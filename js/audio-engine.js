/**
 * Tesla Active Sound — THOR-style Active Sound engine
 *
 * Primary model (see docs/thor_ref.md):
 * 1. Drive states: idle · pull · cruise · overrun · shift
 * 2. Virtual RPM + 3-speed virtual gearbox (EV-style)
 * 3. Multi-layer mix: sample pack when available, else procedural
 * 4. Layer roles ≈ THUNDER(body) / STORM(mid) / ECHO(high)
 * 5. Load from accel/throttle; overrun character on decel
 */

import { clamp, damp } from './animations.js';
import { getProfileById } from './profiles.js';
import {
  GEAR_COUNT,
  resolveGear,
  rpmInGear,
  gearToneBias,
  gearProgress,
  shiftLandingRpm,
} from './gearbox.js';
import { SamplePackLoader, createSampleLayer } from './sample-pack.js';

const REF_RPM = 4000; // buffer authored at this rpm feel

/** @typedef {'idle'|'pull'|'cruise'|'overrun'|'shift'} DriveState */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    this.compressor = null;

    this.running = false;
    this.profile = getProfileById('na-v12');

    this.masterVolume = 0.72;
    this.bassPresence = 0.55;
    this.edge = 0.5;
    this.speedReactive = true;
    this.smoothFilter = true;

    // Vehicle inputs
    this._speed = 0;
    this._speedSmooth = 0;
    this._throttle = 0;
    this._brake = 0;
    /** Longitudinal accel in km/h per second (+accel / −decel) */
    this._accelKmhps = 0;
    this._accelSmooth = 0;
    /** Full-load reference for audio (tube scale ±40; sim rate ±33 sits under full) */
    // Lower ref = the virtual engine has to WORK to match Tesla-grade accel,
    // so normal hard acceleration already revs it hard (real-physics feel).
    this.accelRefKmhps = 26;

    // Engine state (Ioniq-style)
    this._rpm = 900;
    this._rpmSmooth = 900;
    this._gear = 1;
    this._gearCount = GEAR_COUNT; // 3 — top of 3rd ≈ 120 km/h
    this._shifting = false;
    this._shiftTimer = 0;
    this._prevGear = 1;
    this._gearBias = gearToneBias(1);
    this._turbo = 0;
    this._load = 0;
    this._intensity = 0;
    this._idlePhase = 0;
    /** @type {DriveState} */
    this._driveState = 'idle';

    this._started = false;
    this._updateTimer = null;
    this._lastUpdateWall = 0;
    /** Launch rev (drag-run script): wall-clock deadline + schedule */
    this._revUntil = 0;
    this._revDuration = 5;
    this._revScript = null;
    /** Combustion micro-jitter state (engines are never perfectly periodic) */
    this._jitter = 0;
    this._layers = null;
    this._sampleLayers = null;
    this._samplePack = null;
    this._packLoader = null;
    this._useSamples = false;
    this._prevRpm = 900;
    this._bufferCache = new Map();
  }

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    this.master.gain.value = 0;

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 20;
    this.compressor.ratio.value = 2.4; // gentle — keep the drive-state dynamics
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.14;

    // DynamicVolume: models real exhaust SPL across idle/cruise/pull. Sits
    // AFTER the compressor so the big quiet→loud swing survives, and its
    // ceiling is the user's Master Volume.
    this.dynGain = this.ctx.createGain();
    this.dynGain.gain.value = 0.5;

    // Small analyser — no live waveform UI; keep light for compressor tap only
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;

    this.master.connect(this.compressor);
    this.compressor.connect(this.dynGain);
    this.dynGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this._packLoader = new SamplePackLoader(this.ctx);
    this._buildBus();
    this._rebuildLayers();
    // Try sample pack for default profile (non-blocking)
    this._tryLoadSamples(this.profile?.samplePack);
    this._started = true;
    this._startUpdateLoop();
  }

  /**
   * Self-clocked 50 Hz parameter loop, independent of display rAF.
   * Tesla Browser rAF often runs at 20–40 fps (MCU2) or drops while in
   * Drive — audio smoothness must not depend on rendering frame rate.
   */
  _startUpdateLoop() {
    if (this._updateTimer) return;
    this._lastUpdateWall = performance.now();
    this._updateTimer = window.setInterval(() => {
      const now = performance.now();
      let dt = (now - this._lastUpdateWall) / 1000;
      this._lastUpdateWall = now;
      if (!(dt > 0) || dt > 0.25) dt = 0.02;
      this.update(dt);
    }, 20);
  }

  _buildBus() {
    const ctx = this.ctx;

    // Master tone chain
    this.bus = ctx.createGain();
    this.bus.gain.value = 1;

    this.drive = ctx.createWaveShaper();
    this.drive.curve = makeDriveCurve(0.4);
    this.drive.oversample = '2x';

    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 5000;
    this.lp.Q.value = 0.7;

    this.presence = ctx.createBiquadFilter();
    this.presence.type = 'peaking';
    this.presence.frequency.value = 1200;
    this.presence.Q.value = 0.8;
    this.presence.gain.value = 3;

    this.subBoost = ctx.createBiquadFilter();
    this.subBoost.type = 'lowshelf';
    this.subBoost.frequency.value = 120;
    this.subBoost.gain.value = 2;

    this.hi = ctx.createBiquadFilter();
    this.hi.type = 'highshelf';
    this.hi.frequency.value = 3500;
    this.hi.gain.value = 0;

    // Exhaust resonance formant — tracks firing frequency, opens under load
    this.formant = ctx.createBiquadFilter();
    this.formant.type = 'peaking';
    this.formant.frequency.value = 900;
    this.formant.Q.value = 3.2;
    this.formant.gain.value = 0;

    this.bus
      .connect(this.drive)
      .connect(this.subBoost)
      .connect(this.lp)
      .connect(this.presence)
      .connect(this.formant)
      .connect(this.hi);

    // --- Spatial zones (browser is stereo-only, so this is psychoacoustic) ---
    // Exhaust band (lows) staged BEHIND the listener: crossover → predelay →
    // HRTF panner at +z. Engine band (mid/high) stays dry and centered =
    // front-of-cabin. Wide/reverberant rear content also feeds Tesla's
    // Immersive Sound upmixer toward the rear speakers.
    this.zoneRear = ctx.createBiquadFilter();
    this.zoneRear.type = 'lowpass';
    this.zoneRear.frequency.value = 300;
    this.zoneRear.Q.value = 0.7;

    this.zoneFront = ctx.createBiquadFilter();
    this.zoneFront.type = 'highpass';
    this.zoneFront.frequency.value = 300;
    this.zoneFront.Q.value = 0.7;

    this.rearDelay = ctx.createDelay(0.05);
    this.rearDelay.delayTime.value = 0.022; // rear-wall reflection lag

    this.rearPanner = ctx.createPanner();
    this.rearPanner.panningModel = 'HRTF';
    if (this.rearPanner.positionZ) {
      this.rearPanner.positionZ.value = 2.0; // further behind (listener faces −z)
    } else {
      this.rearPanner.setPosition(0, 0, 2.0);
    }

    this.rearGain = ctx.createGain();
    this.rearGain.gain.value = 1.15; // offset HRTF/distance loss
    this.frontGain = ctx.createGain();
    this.frontGain.gain.value = 1;

    this.hi.connect(this.zoneRear);
    this.zoneRear.connect(this.rearDelay);
    this.rearDelay.connect(this.rearPanner);
    this.rearPanner.connect(this.rearGain);
    this.rearGain.connect(this.master);

    this.hi.connect(this.zoneFront);
    this.zoneFront.connect(this.frontGain);
    this.frontGain.connect(this.master);

    // Cabin "space": short generated stereo IR. Rear band gets the full send
    // (exhaust rumbling in the back), front band only a light touch.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._makeReverbIR(0.26, 3.4);
    this.reverbWet = ctx.createGain();
    this.reverbWet.gain.value = 0.13;
    this.zoneRear.connect(this.reverb);
    this.reverbSendFront = ctx.createGain();
    this.reverbSendFront.gain.value = 0.35;
    this.zoneFront.connect(this.reverbSendFront);
    this.reverbSendFront.connect(this.reverb);
    this.reverb.connect(this.reverbWet);
    this.reverbWet.connect(this.master);
  }

  /** Two decorrelated exponentially-decaying noise tails = small-cabin IR */
  _makeReverbIR(seconds = 0.26, decay = 3.4) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lpState = 0;
      for (let i = 0; i < n; i++) {
        const white = Math.random() * 2 - 1;
        lpState += 0.22 * (white - lpState); // darken the tail
        d[i] = lpState * Math.pow(1 - i / n, decay);
      }
    }
    return buf;
  }

  /**
   * Procedural engine loop — pulse train shaped like exhaust blows
   * This is the core of "sounds like a car" vs pure oscillators.
   */
  _makeEngineBuffer(spec) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const duration = 1.25;
    const n = Math.floor(sr * duration);
    const buffer = ctx.createBuffer(1, n, sr);
    const data = buffer.getChannelData(0);

    const {
      pulses = 48, // pulses across the loop at REF character
      thump = 0.7,
      rasp = 0.4,
      hollow = 0.3,
      metallic = 0.2,
      uneven = 0, // boxer / cam
      width = 0.012, // pulse width seconds
      subHeavy = 0.5,
      grit = 0.35,
    } = spec;

    // Pink-ish noise helper state
    let b0 = 0,
      b1 = 0,
      b2 = 0;

    const pulseTimes = [];
    for (let p = 0; p < pulses; p++) {
      let t = (p / pulses) * duration;
      // Uneven spacing (cam / boxer / cross-plane)
      if (uneven > 0) {
        const wobble = Math.sin(p * 1.7) * 0.012 * uneven + Math.sin(p * 0.5) * 0.008 * uneven;
        t += wobble;
      }
      // Classic cross-plane V8 lope: every other pulse delayed
      if (uneven > 0.6 && p % 2 === 1) t += 0.008 * uneven;
      pulseTimes.push(((t % duration) + duration) % duration);
    }

    // Write silence then additive pulses
    data.fill(0);

    for (const pt of pulseTimes) {
      const start = Math.floor(pt * sr);
      const plen = Math.floor(width * sr * (0.7 + Math.random() * 0.6));
      const thumpF = 55 + Math.random() * 30;
      const midF = 180 + rasp * 220 + Math.random() * 40;

      for (let i = 0; i < plen && start + i < n; i++) {
        const u = i / plen;
        // Exhaust blow envelope — fast attack, exponential body
        const env = Math.exp(-u * (4.5 + hollow * 3)) * (1 - u * 0.15);
        const atk = Math.min(1, i / Math.max(1, sr * 0.0008));

        const t = i / sr;
        // Combustion thump
        const th =
          Math.sin(2 * Math.PI * thumpF * t) *
          Math.exp(-u * 8) *
          thump *
          subHeavy;
        // Mid body
        const mid =
          Math.sin(2 * Math.PI * midF * t + 0.4) *
          Math.exp(-u * 6) *
          (0.45 + rasp * 0.4);
        // Higher rasp partials
        const hi =
          Math.sin(2 * Math.PI * (midF * 2.1) * t) *
          Math.exp(-u * 12) *
          rasp *
          0.35;

        // Filtered noise burst (exhaust gas)
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        const pink = (b0 + b1 + b2 + white * 0.15) * 0.15;

        const noiseBurst = pink * Math.exp(-u * (5 + metallic * 4)) * grit;

        // Metallic ring
        const ring =
          metallic > 0.05
            ? Math.sin(2 * Math.PI * (2200 + metallic * 1800) * t) *
              Math.exp(-u * 25) *
              metallic *
              0.25
            : 0;

        const sample =
          (th * 1.1 + mid + hi + noiseBurst + ring) * env * atk * 0.55;
        const idx = start + i;
        data[idx] = clamp(data[idx] + sample, -1, 1);
        // wrap soft for seamless loop
        if (idx + 1 >= n) {
          data[idx + 1 - n] = clamp(data[idx + 1 - n] + sample * 0.5, -1, 1);
        }
      }
    }

    // Soft normalize
    let peak = 0.001;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
    const norm = 0.9 / peak;
    for (let i = 0; i < n; i++) data[i] *= norm;

    // Crossfade loop ends
    const xfade = Math.floor(sr * 0.02);
    for (let i = 0; i < xfade; i++) {
      const k = i / xfade;
      data[i] = data[i] * k + data[n - xfade + i] * (1 - k);
    }

    return buffer;
  }

  _makeNoiseBuffer(seconds, color = 'pink') {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0;
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      if (color === 'white') {
        data[i] = white * 0.4;
      } else {
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }
    return buffer;
  }

  _makeEvBuffer() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * 1.0);
    const buffer = ctx.createBuffer(1, n, sr);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // layered whine partials
      const a =
        Math.sin(2 * Math.PI * 120 * t) * 0.15 +
        Math.sin(2 * Math.PI * 240 * t) * 0.1 +
        Math.sin(2 * Math.PI * 480 * t) * 0.06 +
        Math.sin(2 * Math.PI * 960 * t) * 0.03;
      const buzz = Math.sin(2 * Math.PI * 60 * t) * 0.08;
      data[i] = (a + buzz) * 0.8;
    }
    return buffer;
  }

  _getOrCreateBuffers(profile) {
    const id = profile.id;
    if (this._bufferCache.has(id)) return this._bufferCache.get(id);

    const tone = profile.tone;
    const eng = profile.engine;
    const isEv = eng.type === 'electric' || tone.electric > 0.8;

    let low;
    let high;
    if (isEv) {
      low = this._makeEvBuffer();
      high = this._makeEvBuffer();
    } else {
      low = this._makeEngineBuffer({
        pulses: Math.round(28 + (eng.cylinders || 6) * 2.5),
        thump: 0.55 + tone.sub * 0.5,
        rasp: 0.25 + tone.mid * 0.4,
        hollow: 0.2 + tone.body * 0.3,
        metallic: tone.metallic * 0.5,
        uneven: Math.max(tone.lope, tone.boxer, tone.exhaustPulse * 0.4),
        width: 0.014 + tone.sub * 0.008,
        subHeavy: 0.45 + tone.sub * 0.55,
        grit: 0.25 + tone.noise * 0.5,
      });
      const rot = tone.rotary > 0.5 ? tone.rotary : 0;
      high = this._makeEngineBuffer({
        // Rotary: denser pulses + extra metallic/grit = the buzzy "brap"
        pulses: Math.round(36 + (eng.cylinders || 6) * 3 + rot * 26),
        thump: 0.3 + tone.sub * 0.25,
        rasp: 0.5 + tone.scream * 0.45,
        hollow: 0.35,
        metallic: 0.3 + tone.metallic * 0.7 + rot * 0.15,
        uneven: tone.boxer * 0.7 + tone.rotary * 0.5,
        width: 0.008 + (1 - tone.scream) * 0.006,
        subHeavy: 0.25,
        grit: 0.35 + tone.noise * 0.4 + tone.rotary * 0.35,
      });
    }

    const intake = this._makeNoiseBuffer(0.8, 'pink');
    const turbo = this._makeNoiseBuffer(0.6, 'white');
    const whoosh = this._makeNoiseBuffer(1.0, 'pink');

    const pack = { low, high, intake, turbo, whoosh, isEv };
    this._bufferCache.set(id, pack);
    return pack;
  }

  _stopLayers() {
    if (this._lope) {
      try {
        this._lope.osc.stop();
      } catch (_) {}
      try {
        this._lope.osc.disconnect();
      } catch (_) {}
      this._lope = null;
    }
    if (!this._layers) return;
    for (const L of Object.values(this._layers)) {
      if (!L) continue;
      try {
        L.src?.stop?.();
      } catch (_) {}
      try {
        L.src?.disconnect?.();
      } catch (_) {}
      try {
        L.gain?.disconnect?.();
      } catch (_) {}
      try {
        L.filter?.disconnect?.();
      } catch (_) {}
    }
    this._layers = null;
  }

  _rebuildLayers() {
    if (!this.ctx) return;
    this._stopLayers();
    const ctx = this.ctx;
    const pack = this._getOrCreateBuffers(this.profile);
    const t = ctx.currentTime;

    const makeLayer = (buffer, opts = {}) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.playbackRate.value = opts.rate || 1;

      const filter = ctx.createBiquadFilter();
      filter.type = opts.filterType || 'lowpass';
      filter.frequency.value = opts.freq || 4000;
      filter.Q.value = opts.q || 0.7;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.bus);
      src.start(t + 0.02);
      return { src, filter, gain };
    };

    this._layers = {
      low: makeLayer(pack.low, { filterType: 'lowpass', freq: 900 }),
      high: makeLayer(pack.high, { filterType: 'bandpass', freq: 2200, q: 0.6 }),
      intake: makeLayer(pack.intake, { filterType: 'bandpass', freq: 1800, q: 0.8 }),
      turbo: makeLayer(pack.turbo, { filterType: 'bandpass', freq: 3200, q: 2.2 }),
      whoosh: makeLayer(pack.whoosh, { filterType: 'highpass', freq: 700 }),
      // Extra pure tone for scream / EV whine
      tone: null,
    };

    // Auxiliary oscillators for character
    const scream = ctx.createOscillator();
    scream.type = pack.isEv ? 'sawtooth' : 'triangle';
    scream.frequency.value = 400;
    const screamF = ctx.createBiquadFilter();
    screamF.type = 'bandpass';
    screamF.frequency.value = 2000;
    screamF.Q.value = 3;
    const screamG = ctx.createGain();
    screamG.gain.value = 0;
    scream.connect(screamF);
    screamF.connect(screamG);
    screamG.connect(this.bus);
    scream.start(t);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 45;
    const subG = ctx.createGain();
    subG.gain.value = 0;
    sub.connect(subG);
    subG.connect(this.bus);
    sub.start(t);

    // Idle lope LFO
    const lope = ctx.createOscillator();
    lope.type = 'sine';
    lope.frequency.value = 5;
    const lopeG = ctx.createGain();
    lopeG.gain.value = 0;
    lope.connect(lopeG);
    // will connect to low layer gain modulation via constant-ish path
    this._lope = { osc: lope, gain: lopeG };
    lope.start(t);
    // Manual lope applied in update via gain

    this._layers.scream = { src: scream, filter: screamF, gain: screamG };
    this._layers.sub = { src: sub, filter: null, gain: subG };
    this._pack = pack;
  }

  async resume() {
    if (!this.ctx) await this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async start() {
    await this.resume();
    if (this.running) return;
    if (!this._layers) this._rebuildLayers();
    this.running = true;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(this.masterVolume * 0.9, t + 0.55);
    // Warm idle immediately
    this._rpm = this.profile.engine.idleRpm || 900;
    this._rpmSmooth = this._rpm;
    this._fireStartSequence();
  }

  /**
   * THOR "dynamic start": starter crank + rev flare that settles into idle.
   * EV profiles get a soft power-on whine sweep instead of a crank.
   */
  _fireStartSequence() {
    if (!this.ctx) return;
    const eng = this.profile.engine;
    const tone = this.profile.tone;
    const isEv = eng.type === 'electric' || tone.electric > 0.8;
    const idle = eng.idleRpm || 800;
    const redline = eng.redlineRpm || 7500;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    if (isEv) {
      // Power-on swell: brief whine sweep from above, decaying into silence
      this._rpm = this._rpmSmooth = redline * 0.22;
      return;
    }

    // Starter motor: gated low sawtooth ≈0.45s (crank teeth ~11 Hz)
    const crank = ctx.createOscillator();
    crank.type = 'sawtooth';
    crank.frequency.setValueAtTime(52, t0);
    crank.frequency.linearRampToValueAtTime(74, t0 + 0.42);

    const crankF = ctx.createBiquadFilter();
    crankF.type = 'bandpass';
    crankF.frequency.value = 220;
    crankF.Q.value = 1.1;

    const crankG = ctx.createGain();
    crankG.gain.value = 0.07;

    const gate = ctx.createOscillator();
    gate.type = 'square';
    gate.frequency.value = 11;
    const gateDepth = ctx.createGain();
    gateDepth.gain.value = 0.05;
    gate.connect(gateDepth);
    gateDepth.connect(crankG.gain);

    crank.connect(crankF);
    crankF.connect(crankG);
    crankG.connect(this.bus);
    crank.start(t0);
    gate.start(t0);
    crank.stop(t0 + 0.46);
    gate.stop(t0 + 0.46);

    // Catch: rev flare lands after the crank, then idle-damp brings it down
    window.setTimeout(() => {
      if (!this.running) return;
      const flare = idle + (redline - idle) * (0.3 + (tone.scream || 0.3) * 0.14);
      this._rpm = this._rpmSmooth = flare;
    }, 440);
  }

  stop() {
    if (!this.ctx) {
      this.running = false;
      return;
    }
    this.running = false;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0, t + 0.4);
  }

  setProfile(profile) {
    this.profile = profile;
    this._gear = 1;
    this._shifting = false;
    if (this._started) {
      this._rebuildLayers();
      this._tryLoadSamples(profile?.samplePack);
    }
  }

  /**
   * Load THOR-style layered pack if present under assets/samples/<id>/
   * @param {string|undefined} packId
   */
  async _tryLoadSamples(packId) {
    if (!this._packLoader) return;
    this._useSamples = false;
    this._stopSampleLayers();
    this._samplePack = null;
    if (!packId) return;
    try {
      const pack = await this._packLoader.load(packId);
      if (!pack || !this.running && !this._started) return;
      // Only apply if profile still wants this pack
      if (this.profile?.samplePack !== packId) return;
      this._samplePack = pack;
      this._startSampleLayers(pack);
      this._useSamples = true;
    } catch (e) {
      console.warn('[AudioEngine] sample pack load failed', e);
      this._useSamples = false;
    }
  }

  _stopSampleLayers() {
    if (!this._sampleLayers) return;
    for (const L of Object.values(this._sampleLayers)) {
      if (!L) continue;
      try {
        L.src.stop();
      } catch (_) {}
      try {
        L.src.disconnect();
        L.gain.disconnect();
        L.filter?.disconnect();
      } catch (_) {}
    }
    this._sampleLayers = null;
  }

  _startSampleLayers(pack) {
    if (!this.ctx || !this.bus || !pack) return;
    this._stopSampleLayers();
    const dest = this.bus;
    const b = pack.buffers;
    this._sampleLayers = {
      idle: createSampleLayer(this.ctx, b.idle, dest),
      body: createSampleLayer(this.ctx, b.body || b.idle, dest),
      high: createSampleLayer(this.ctx, b.high || b.body, dest),
      load: createSampleLayer(this.ctx, b.load, dest),
      overrun: createSampleLayer(this.ctx, b.overrun, dest),
    };
  }

  /**
   * Launch rev — a scripted quarter-mile pull while parked, in any mode:
   * flat-out from launch, bang through as many gears as fit the time window
   * (G1→G2→G3, each pull ending at redline), then lift-off.
   * @returns {boolean} false when the engine is not running
   */
  startRevTest(seconds = 5) {
    if (!this.running) return false;
    const eng = this.profile.engine;
    const tone = this.profile.tone;
    const isEv = eng.type === 'electric' || tone.electric > 0.8;
    this._revDuration = clamp(seconds, 2, 10);
    this._revScript = this._buildRevScript(this._revDuration, isEv);
    this._revUntil = performance.now() + this._revDuration * 1000;
    return true;
  }

  /**
   * Drag-run schedule: full-throttle pulls to redline separated by torque-cut
   * shifts, packed into `total` seconds, ending with a lift-off release.
   * Norms are fractions of (idle→redline); shift landings match gearbox.js.
   */
  _buildRevScript(total, isEv) {
    const release = Math.min(0.9, total * 0.18);
    const pullTotal = total - release;
    const segs = [];
    if (isEv) {
      // Single-ratio EV: one long surge instead of gear bangs
      segs.push({ type: 'pull', t0: 0, t1: pullTotal, from: 0.12, to: 0.86, gear: 1 });
    } else {
      const shiftGap = 0.12;
      const weights = [0.3, 0.33, 0.37]; // higher gears pull a little longer
      const froms = [0.16, 0.42, 0.46]; // launch, then G2/G3 shift landings
      const pullTime = pullTotal - shiftGap * 2;
      let t = 0;
      for (let i = 0; i < 3; i++) {
        const dur = pullTime * weights[i];
        segs.push({ type: 'pull', t0: t, t1: t + dur, from: froms[i], to: 1.0, gear: i + 1 });
        t += dur;
        if (i < 2) {
          segs.push({ type: 'shift', t0: t, t1: t + shiftGap, gear: i + 2, land: froms[i + 1], fired: false });
          t += shiftGap;
        }
      }
    }
    segs.push({ type: 'release', t0: total - release, t1: total, from: 1.0 });
    return segs;
  }

  get revActive() {
    return !!this._revUntil && performance.now() < this._revUntil;
  }

  setMasterVolume(v) {
    this.masterVolume = clamp(v, 0, 1);
    if (this.running && this.master) {
      this.master.gain.setTargetAtTime(this.masterVolume * 0.9, this.ctx.currentTime, 0.04);
    }
  }

  setBass(v) {
    this.bassPresence = clamp(v, 0, 1);
  }

  setEdge(v) {
    this.edge = clamp(v, 0, 1);
  }

  /**
   * @param {number} kmh
   * @param {{ throttle?: number, brake?: number, accelKmhps?: number }} [extras]
   */
  setSpeed(kmh, extras = {}) {
    this._speed = Math.max(0, kmh);
    if (extras.throttle != null) this._throttle = clamp(extras.throttle, 0, 1);
    if (extras.brake != null) this._brake = clamp(extras.brake, 0, 1);
    if (extras.accelKmhps != null) this._accelKmhps = extras.accelKmhps;
  }

  setThrottle(t) {
    this._throttle = clamp(t, 0, 1);
  }

  setAccel(kmhps) {
    this._accelKmhps = kmhps;
  }

  /**
   * 3-speed virtual gearbox (top of G3 ≈ 120 km/h — see gearbox.js)
   * Each gear = its own RPM sweep → ช่วงเสียงแยกชัดตามเกียร์
   * Accel/decel = load ภายในเกียร์ + kickdown + จังหวะเปลี่ยนเกียร์
   */
  _updateRpmGear(dt) {
    const eng = this.profile.engine;
    const tone = this.profile.tone;
    const isEv = eng.type === 'electric' || tone.electric > 0.8;

    const idle = eng.idleRpm || 800;
    const redline = eng.redlineRpm || 7500;
    this._gearCount = isEv ? 1 : GEAR_COUNT;

    // Eval hook: pin a steady RPM (A/B comparison against real samples)
    if (this._holdRpm != null) {
      this._rpm = this._rpmSmooth = this._holdRpm;
      this._gear = this._gear || 3;
      this._gearBias = gearToneBias(this._gear);
      this._throttle = 1;
      this._brake = 0;
      this._load = 1;
      this._accelSmooth = this.accelRefKmhps;
      this._driveState = 'pull';
      return;
    }

    if (this._shifting) {
      this._shiftTimer -= dt;
      if (this._shiftTimer <= 0) this._shifting = false;
    }

    const speed = this.speedReactive ? this._speedSmooth : Math.max(this._speedSmooth, 40);

    const aLambda = this.smoothFilter ? 10 : 18;
    this._accelSmooth = damp(this._accelSmooth, this._accelKmhps, aLambda, dt);
    const aNorm = clamp(this._accelSmooth / this.accelRefKmhps, -1.4, 1.4);
    const accelLoad = clamp(aNorm, 0, 1);
    const decelLoad = clamp(-aNorm, 0, 1);

    // Launch rev — scripted quarter-mile pull overrides all inputs (any mode)
    if (this._revUntil) {
      const now = performance.now();
      if (now >= this._revUntil) {
        this._revUntil = 0;
        this._revScript = null;
      } else {
        const elapsed = (now - (this._revUntil - this._revDuration * 1000)) / 1000;
        const segs = this._revScript || [];
        const seg =
          segs.find((s) => elapsed >= s.t0 && elapsed < s.t1) || segs[segs.length - 1];
        const span = redline - idle;
        let n = 0.15;
        let load = 0;
        let lambda = 10;
        if (seg.type === 'pull') {
          const prog = clamp((elapsed - seg.t0) / Math.max(0.05, seg.t1 - seg.t0), 0, 1);
          // Fast off the line, straining as it nears redline
          n = seg.from + (seg.to - seg.from) * Math.pow(prog, 0.85);
          load = 1;
          lambda = 16;
          this._gear = seg.gear;
          this._driveState = 'pull';
        } else if (seg.type === 'shift') {
          if (!seg.fired) {
            seg.fired = true;
            this._fireShiftClick(false);
          }
          n = seg.land;
          load = 0.18;
          lambda = 22; // hard torque cut into the landing
          this._gear = seg.gear;
          this._shifting = true;
          this._shiftTimer = Math.max(0.02, seg.t1 - elapsed);
          this._driveState = 'shift';
        } else {
          // Lift-off after the last gear
          const prog = clamp((elapsed - seg.t0) / Math.max(0.05, seg.t1 - seg.t0), 0, 1);
          n = seg.from * (1 - prog) + 0.1 * prog;
          load = 0;
          lambda = 8;
          this._driveState = 'overrun';
        }
        const target = idle + span * clamp(n, 0.08, 1.02);
        this._rpmSmooth = damp(this._rpmSmooth, target, lambda, dt);
        this._rpm = this._rpmSmooth;
        this._prevGear = this._gear;
        this._gearBias = gearToneBias(this._gear);
        this._throttle = load;
        this._brake = 0;
        this._accelSmooth =
          load * this.accelRefKmhps * 0.9 -
          (seg.type === 'release' ? this.accelRefKmhps * 0.5 : 0);
        this._load = clamp(0.15 + load * 0.85, 0, 1);
        return;
      }
    }

    this._throttle = Math.max(this._throttle * 0.35, accelLoad);
    this._brake = Math.max(this._brake * 0.35, decelLoad);
    if (speed < 1 && accelLoad < 0.05) {
      this._throttle = 0;
      this._brake = 0;
    }

    this._load = clamp(accelLoad * 0.85 + decelLoad * 0.25 + (speed > 5 ? 0.08 : 0), 0, 1);

    // THOR drive state (for layer mix + future sample crossfades)
    if (this._shifting) this._driveState = 'shift';
    else if (speed < 1.5 && accelLoad < 0.1) this._driveState = 'idle';
    else if (decelLoad > 0.28) this._driveState = 'overrun';
    else if (accelLoad > 0.22) this._driveState = 'pull';
    else this._driveState = 'cruise';

    if (isEv) {
      // Single “ratio”: map 0–120 km/h like top of 5th, plus accel pull
      const base = (Math.min(speed, 120) / 120) * redline * 0.8;
      const pull = accelLoad * redline * 0.28;
      const target = Math.max(0, base + pull - decelLoad * redline * 0.12);
      this._rpmSmooth = damp(this._rpmSmooth, target, 9, dt);
      this._rpm = this._rpmSmooth;
      this._gear = 1;
      this._gearBias = gearToneBias(GEAR_COUNT);
      return;
    }

    // Idle
    if (speed < 1.5 && accelLoad < 0.1) {
      this._idlePhase += dt;
      const hunt =
        Math.sin(this._idlePhase * 2.1) * 28 +
        Math.sin(this._idlePhase * 5.3) * 12 * (tone.lope || 0.2);
      const camLope =
        Math.sin(this._idlePhase * (3.5 + (tone.lope || 0) * 4)) * 40 * (tone.lope || 0);
      this._rpmSmooth = damp(this._rpmSmooth, idle + hunt + camLope, 7, dt);
      this._rpm = this._rpmSmooth;
      if ((tone.rotary || 0) > 0.5) {
        // Rotary "panting" idle — rate/depth matched to a real RX-7 FD idle
        // (~4.8 Hz pulse, ~2.2 Hz irregular depth). Added after the damp so
        // it isn't smoothed away.
        const p = this._pantPhase || 0;
        const depth = 0.65 + 0.35 * Math.sin(p * (2 * Math.PI * 2.2));
        this._rpm += Math.sin(p * (2 * Math.PI * 4.8)) * 40 * depth;
      }
      this._gear = 1;
      this._prevGear = 1;
      this._gearBias = gearToneBias(1);
      this._load = 0.05 + (tone.lope || 0) * 0.08;
      return;
    }

    // --- Gear from road speed, rate-limited so hard accel can't machine-gun ---
    this._sinceShift = (this._sinceShift || 0) + dt;
    let nextGear = resolveGear(speed, this._gear, accelLoad, decelLoad);
    // Row one gear at a time (no multi-gear jumps that skip the rev-up)
    if (nextGear > this._gear + 1) nextGear = this._gear + 1;
    else if (nextGear < this._gear - 1) nextGear = this._gear - 1;

    const MIN_DWELL = 0.26; // seconds between shifts — the "rowing" cadence
    if (nextGear !== this._gear && !this._shifting && this._sinceShift > MIN_DWELL) {
      const up = nextGear > this._gear;
      this._prevGear = this._gear;
      this._gear = nextGear;
      this._sinceShift = 0;
      this._shifting = true;
      this._shiftTimer = up ? 0.12 : 0.09;
      this._gearBias = gearToneBias(this._gear);
      this._fireShiftClick(!up);
      // Upshift lands low (revLo) = audible drop; downshift blips revs up
      if (up) {
        const land = shiftLandingRpm(this._gear, idle, redline, eng.revLo);
        this._rpmSmooth = land;
        this._rpm = land;
      } else {
        // Downshift rev-match: jump up toward the lower gear's high band
        const revHi = eng.revHi ?? 0.7;
        const land = idle + (redline - idle) * Math.min(0.95, revHi * 0.95);
        this._rpmSmooth = Math.min(redline * 0.95, Math.max(this._rpmSmooth, land));
        this._rpm = this._rpmSmooth;
      }
    }

    this._gearBias = gearToneBias(this._gear);

    // RPM target = sweep inside current gear band (per-profile rev character)
    let targetRpm = rpmInGear({
      speedKmh: speed,
      gear: this._gear,
      idle,
      redline,
      accelLoad,
      decelLoad,
      revLo: eng.revLo,
      revHi: eng.revHi,
      pull: eng.revPull,
    });

    // During shift flash: soft torque-cut RPM settle
    let rpmLambda = this.smoothFilter ? 7 : 12;
    if (accelLoad > 0.4) rpmLambda = 10 + accelLoad * 5;
    if (decelLoad > 0.4) rpmLambda = 9 + decelLoad * 4;
    if (this._shifting) {
      rpmLambda = 18;
      targetRpm = this._rpm * 0.94 + targetRpm * 0.06;
    }

    this._rpmSmooth = damp(
      this._rpmSmooth,
      clamp(targetRpm, idle * 0.85, redline * 1.05),
      rpmLambda,
      dt
    );
    this._rpm = this._rpmSmooth;

    // Extra load cue near top of gear (pre-shift pull)
    const gPos = gearProgress(speed, this._gear);
    if (accelLoad > 0.3 && gPos > 0.75) {
      this._load = clamp(this._load + 0.15, 0, 1);
    }
  }

  _fireShiftClick(down = false) {
    if (!this.ctx || !this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = down ? 180 : 320;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = down ? 400 : 900;
    osc.connect(f);
    f.connect(g);
    g.connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  update(dt) {
    if (!this.ctx || !this._started) return;

    const smoothL = this.smoothFilter ? 6 : 16;
    this._speedSmooth = damp(this._speedSmooth, this._speed, smoothL, dt);

    // Dedicated real-time clock for the rotary idle pant (Hz-accurate, not
    // tangled with _idlePhase which advances at an ambiguous rate).
    this._pantPhase = (this._pantPhase || 0) + dt;

    this._updateRpmGear(dt);

    const eng = this.profile.engine;
    const tone = this.profile.tone;
    const isEv = eng.type === 'electric' || tone.electric > 0.8;
    const idle = eng.idleRpm || 800;
    const redline = eng.redlineRpm || 7500;
    const rpmNorm = clamp((this._rpm - idle) / Math.max(1, redline - idle), 0, 1.1);
    const throttle = this._throttle;
    const load = this._load;
    const speed = this._speedSmooth;
    const aNorm = clamp(this._accelSmooth / this.accelRefKmhps, -1.4, 1.4);
    const accelLoad = clamp(aNorm, 0, 1);
    const decelLoad = clamp(-aNorm, 0, 1);

    // Load-driven loudness — a real engine goes near-silent coasting at speed.
    // Effort punches in on throttle, fades over ~0.4s on lift-off.
    // Effort = smoothed throttle (punches in fast, fades out slow)
    const effTarget = this._revUntil || this._holdRpm != null ? 1 : accelLoad;
    const prevEff = this._effort ?? 0;
    this._effort = damp(prevEff, effTarget, effTarget > prevEff ? 14 : 3.2, dt);

    // --- DynamicVolume: real-exhaust SPL model, capped by Master Volume ---
    // "Drive energy" 0..1 = how hard the exhaust is working (load + revs − lift).
    // Real exhausts swing ~20 dB from idle/cruise up to WOT; we mirror that as a
    // log-loudness curve so cruise is genuinely soft and a pull really opens up.
    const driveEnergy = clamp(
      0.12 + this._effort * 0.6 + rpmNorm * 0.32 - decelLoad * 0.12,
      0,
      1
    );
    const DYN_DB = 20;
    let dynVol = Math.pow(10, (-DYN_DB * (1 - driveEnergy)) / 20);
    if (speed < 4) dynVol = Math.max(dynVol, 0.5); // idle stays present when parked
    if (this.dynGain) {
      this.dynGain.gain.setTargetAtTime(dynVol, this.ctx.currentTime, 0.06);
    }
    this._dynVol = dynVol;

    // Turbo spool: follows accel load (boost builds when pulling)
    const turboT =
      (tone.turbo || 0) *
      clamp(rpmNorm * 0.55 + accelLoad * 0.85, 0, 1) *
      (decelLoad > 0.35 ? 0.4 : 1);
    const tLag = 1.0 + (1 - (tone.turboLag || 0.4)) * 5;
    this._turbo = damp(this._turbo, turboT, tLag, dt);

    // Intensity: idle bed + rpm + ความเร่ง (หลัก)
    this._intensity = clamp(
      (0.18 +
        rpmNorm * 0.45 +
        accelLoad * 0.55 +
        (speed > 2 ? 0.08 : 0)) *
        (tone.volume || 1) *
        (this.running ? 1 : 0),
      0,
      1.35
    );

    this._prevRpm = this._rpm;

    if (!this.running || !this._layers) return;

    const t = this.ctx.currentTime;
    const tau = this.smoothFilter ? 0.05 : 0.02;

    // Combustion micro-jitter random walk — kills the "perfect loop" giveaway
    const jAmt = isEv ? 0.0015 : 0.004 + (1 - rpmNorm) * 0.008 + accelLoad * 0.003;
    this._jitter = damp(this._jitter, (Math.random() * 2 - 1) * jAmt, 4, dt);
    const rateJ = 1 + this._jitter;

    // Playback rate from RPM — sample + procedural
    const refRpm = this._samplePack?.refRpm || REF_RPM;
    const rate = clamp(this._rpm / refRpm, 0.18, 2.8) * rateJ;
    const rateHi = clamp(this._rpm / (refRpm * 0.85), 0.2, 3.0) * rateJ;

    try {
      this._layers.low.src.playbackRate.setTargetAtTime(rate * (isEv ? 0.8 : 1), t, tau);
      this._layers.high.src.playbackRate.setTargetAtTime(rateHi * (0.95 + tone.scream * 0.1), t, tau);
      this._layers.intake.src.playbackRate.setTargetAtTime(0.6 + rpmNorm * 1.2 + throttle * 0.4, t, tau);
      this._layers.turbo.src.playbackRate.setTargetAtTime(0.8 + this._turbo * 2.2, t, tau);
      this._layers.whoosh.src.playbackRate.setTargetAtTime(0.5 + rpmNorm * 1.5, t, tau);
    } catch (_) {}

    // THOR-style sample layers (if pack loaded)
    if (this._useSamples && this._sampleLayers) {
      this._updateSampleLayers(t, tau, {
        rate,
        rateHi,
        rpmNorm,
        accelLoad,
        decelLoad,
        vol: tone.volume || 1,
        shiftMute: this._shifting ? 0.5 : 1,
        isEv,
      });
    }

    // Living idle gain floor — ALWAYS present when engine on (0 km/h)
    const idleAlive = 0.38 + (tone.idlePresence || 0.5) * 0.55;
    // Dynamic idle wobble
    this._idlePhase += dt;
    let idleWobble =
      1 +
      Math.sin(this._idlePhase * 2.4) * 0.04 * (0.5 + (tone.lope || 0)) +
      Math.sin(this._idlePhase * 6.1) * 0.025 * (tone.lope || 0);
    // Rotary idle = raspy "brap...brap...brap" bursts, not a smooth huff.
    const rotIdle = (tone.rotary || 0) > 0.5 && speed < 3;
    let rotaryIdleBurst = 0;
    if (rotIdle) {
      const p = this._pantPhase || 0;
      // Two slightly detuned pulses → rough, uneven spacing; sharpened into
      // distinct bursts with gaps between (each burst = one raspy "brap").
      const raw = Math.max(
        Math.sin(p * (2 * Math.PI * 4.8)),
        Math.sin(p * (2 * Math.PI * 5.7) + 0.6) * 0.7
      );
      rotaryIdleBurst = Math.pow(Math.max(0, raw), 2.4);
      idleWobble = 0.58 + 0.6 * rotaryIdleBurst; // body punches on each brap
    }

    const vol = tone.volume || 1;
    const shiftMute = this._shifting ? 0.55 : 1;
    const gBias = this._gearBias || gearToneBias(this._gear);
    // When samples are active, duck procedural body so packs lead (keep sub/crackle)
    const procDuck = this._useSamples ? 0.22 : 1;

    // Layer mix — accel load opens body/intake; rpm opens pitch; gear biases tone
    if (isEv) {
      const whine =
        (0.05 + rpmNorm * 0.22 + accelLoad * 0.22) * (tone.whine || 1) * vol * procDuck;
      this._layers.low.gain.gain.setTargetAtTime(whine * 0.5 * idleWobble, t, tau);
      this._layers.high.gain.gain.setTargetAtTime(whine * 0.75, t, tau);
      this._layers.whoosh.gain.gain.setTargetAtTime(
        (0.02 + accelLoad * 0.18 + rpmNorm * 0.06) * (tone.whoosh || 0.9) * vol,
        t,
        tau
      );
      this._layers.intake.gain.gain.setTargetAtTime(0.015 + accelLoad * 0.08, t, tau);
      this._layers.turbo.gain.gain.setTargetAtTime(0, t, tau);
      this._layers.scream.gain.gain.setTargetAtTime(whine * 0.15 * this.edge, t, tau);
      this._layers.scream.src.frequency.setTargetAtTime(180 + rpmNorm * 2400, t, tau);
      this._layers.sub.gain.gain.setTargetAtTime(0.03 * this.bassPresence, t, tau);
      this.formant.gain.setTargetAtTime(0, t, tau);
    } else {
      // --- Enthusiast / 911-style: character in the MID band, not only redline ---
      // "Tunnel presence": audible identity at cruise / light load (rpmNorm ~0.35–0.6)
      const tunnel =
        (tone.characterMid || 0.45) *
        gBias.character *
        Math.exp(-Math.pow((rpmNorm - 0.48) / 0.22, 2)) * // bell around mid revs
        (0.55 + (1 - accelLoad) * 0.35 + (speed > 40 ? 0.2 : 0));

      // Low body — idle bed + mid character + pull (not only aggression)
      const lowG =
        (idleAlive * 0.85 +
          rpmNorm * 0.28 * tone.body * gBias.body +
          tunnel * 0.55 * tone.body +
          accelLoad * 0.32 * tone.body * gBias.aggression +
          (speed > 3 && accelLoad < 0.2 ? 0.14 * tone.body * gBias.character : 0)) *
        vol *
        shiftMute *
        idleWobble *
        (0.8 + this.bassPresence * 0.45) *
        procDuck;
      this._layers.low.gain.gain.setTargetAtTime(lowG * 0.75, t, rotIdle ? 0.02 : tau);
      this._layers.low.filter.frequency.setTargetAtTime(
        380 +
          rpmNorm * 1100 +
          tunnel * 400 +
          accelLoad * 500 +
          (this._gear - 1) * 80,
        t,
        tau
      );

      // High layer: opens earlier (howlStart) but softer — boxer/911 howl without redline only
      const howlStart = gBias.howlStart ?? 0.32;
      const screamGate = Math.pow(clamp((rpmNorm - howlStart) / (0.95 - howlStart), 0, 1), 1.05);
      const highG =
        (0.05 +
          tunnel * 0.35 * tone.high +
          rpmNorm * 0.22 * tone.high * gBias.high +
          screamGate * tone.scream * 0.32 * gBias.aggression +
          accelLoad * 0.12) *
        vol *
        shiftMute *
        (0.5 + this.edge * 0.55) *
        procDuck;
      // Rotary idle rasp: each brap burst briefly opens the buzzy high layer
      const highRasp = rotIdle ? rotaryIdleBurst * 0.16 * vol : 0;
      this._layers.high.gain.gain.setTargetAtTime(highG * 0.42 + highRasp, t, rotIdle ? 0.02 : tau);
      this._layers.high.filter.frequency.setTargetAtTime(
        1000 + rpmNorm * 3000 + tone.metallic * 700 + tunnel * 500,
        t,
        tau
      );

      // Intake — mostly pull; light whoosh in tunnel for air sense
      this._layers.intake.gain.gain.setTargetAtTime(
        (0.008 +
          accelLoad * 0.05 * (0.35 + tone.noise * 0.4) +
          tunnel * 0.025 +
          rpmNorm * 0.015 +
          (rotIdle ? rotaryIdleBurst * 0.05 : 0)) *
          vol,
        t,
        rotIdle ? 0.02 : tau
      );
      this._layers.intake.filter.frequency.setTargetAtTime(
        1000 + accelLoad * 2800 + rpmNorm * 800,
        t,
        tau
      );

      // Turbo only if profile has it — NOT tied to gear number
      this._layers.turbo.gain.gain.setTargetAtTime(
        this._turbo * (tone.turbo || 0) * 0.16 * vol,
        t,
        tau
      );
      this._layers.turbo.filter.frequency.setTargetAtTime(1800 + this._turbo * 4500, t, tau);
      this._layers.turbo.filter.Q.setTargetAtTime(1.5 + this._turbo * 3.5, t, tau);

      this._layers.whoosh.gain.gain.setTargetAtTime(
        this._turbo * 0.04 * (tone.turbo || 0) + throttle * 0.012 + tunnel * 0.015,
        t,
        tau
      );

      // Scream / metallic edge — earlier, gentler; boxer adds uneven spice
      const sc =
        (tone.scream * screamGate * (0.018 + rpmNorm * 0.05 + accelLoad * 0.03) +
          tunnel * 0.025 * (tone.metallic || 0.3)) *
        (0.4 + this.edge * 0.65) *
        vol *
        // Rotary brap signature swells with revs
        (1 + (tone.boxer || 0) * 0.15 + (tone.rotary || 0) * rpmNorm * 0.6);
      this._layers.scream.gain.gain.setTargetAtTime(sc, t, tau);
      const fire = (this._rpm / 60) * ((eng.cylinders || 6) / 2);

      // Formant tracks 2nd firing order — the "rasp" that opens under load
      this.formant.frequency.setTargetAtTime(clamp(fire * 2, 220, 2400), t, tau);
      this.formant.gain.setTargetAtTime(
        (accelLoad * 5.5 + this._load * 1.5 + (tone.mid || 0.5) * 1.8) *
          (0.5 + this.edge * 0.5),
        t,
        tau
      );
      // Slight boxer detune wobble on pitch feel via filter Q path
      this._layers.scream.src.frequency.setTargetAtTime(
        Math.max(100, fire * (1.8 + tone.scream * 0.8) + rpmNorm * 500 + tunnel * 200),
        t,
        tau
      );
      this._layers.scream.filter.frequency.setTargetAtTime(
        1400 + rpmNorm * 3600 + (tone.boxer || 0) * 400,
        t,
        tau
      );

      // Exhaust pulse / sub — stronger in mid for flat-6 character
      const pulseBoost = 1 + tunnel * 0.8 * (tone.exhaustPulse || 0.4);
      this._layers.sub.src.frequency.setTargetAtTime(
        Math.max(30, (this._rpm / 60) * (eng.cylinders >= 8 ? 1 : 0.5) + 28),
        t,
        tau
      );
      this._layers.sub.gain.gain.setTargetAtTime(
        tone.sub *
          (0.06 + (1 - rpmNorm) * 0.06 + throttle * 0.04 + tunnel * 0.08) *
          (0.5 + this.bassPresence) *
          vol *
          pulseBoost,
        t,
        tau
      );
    }

    // Cabin space: a touch more wet at speed, drier under hard pull for clarity
    this.reverbWet.gain.setTargetAtTime(
      0.06 + rpmNorm * 0.05 - accelLoad * 0.03,
      t,
      tau
    );

    // Zone staging: overrun pushes the exhaust rearward, pull leans front
    this.rearGain.gain.setTargetAtTime(1.0 + decelLoad * 0.45 + this._load * 0.1, t, tau);
    this.frontGain.gain.setTargetAtTime(1.1 + accelLoad * 0.2, t, tau);

    // Bus EQ
    this.lp.frequency.setTargetAtTime(
      (tone.filterIdle || 600) +
        ((tone.filterRedline || 5000) - (tone.filterIdle || 600)) * Math.pow(rpmNorm, 0.9) * (0.5 + this.edge * 0.6),
      t,
      tau
    );
    this.subBoost.gain.setTargetAtTime(-1 + this.bassPresence * 6 + tone.sub * 2, t, tau);
    this.hi.gain.setTargetAtTime(-2 + this.edge * 6 + tone.high * 3 * rpmNorm, t, tau);
    this.presence.gain.setTargetAtTime(1 + tone.mid * 4 + accelLoad * 3, t, tau);

    // Drive amount
    if ((this._driveTick = (this._driveTick || 0) + dt) > 0.2) {
      this._driveTick = 0;
      this.drive.curve = makeDriveCurve(
        clamp(
          (tone.drive || 0.4) * (0.3 + rpmNorm * 0.4 + accelLoad * 0.4),
          0.1,
          0.9
        )
      );
    }

  }

  get intensity() {
    return this._intensity;
  }

  get smoothedSpeed() {
    return this._speedSmooth;
  }

  get rpm() {
    return this._rpm;
  }

  get gearIndex() {
    return this._gear;
  }

  get gearCount() {
    return this._gearCount;
  }

  get driveState() {
    return this._driveState;
  }

  get usingSamples() {
    return this._useSamples;
  }

  get throttle() {
    return this._throttle;
  }

  getAnalyser() {
    return this.analyser;
  }

  /**
   * Mix sample layers like THOR multi-layer (idle/body/high/load/overrun)
   */
  _updateSampleLayers(t, tau, ctx) {
    const { rate, rateHi, rpmNorm, accelLoad, decelLoad, vol, shiftMute } = ctx;
    const S = this._sampleLayers;
    if (!S) return;

    const state = this._driveState;
    const idleG =
      state === 'idle' ? 0.55 * vol : state === 'cruise' ? 0.12 * vol : 0.05 * vol;
    const bodyG =
      (state === 'idle' ? 0.15 : 0.28 + rpmNorm * 0.35 + accelLoad * 0.25) *
      vol *
      shiftMute;
    const highG =
      (0.04 + rpmNorm * 0.4 * (0.4 + accelLoad) + (state === 'pull' ? 0.12 : 0)) *
      vol *
      shiftMute *
      (0.5 + this.edge * 0.5);
    const loadG =
      state === 'pull' ? (0.1 + accelLoad * 0.45) * vol * shiftMute : accelLoad * 0.08 * vol;
    const overG =
      state === 'overrun' ? (0.12 + decelLoad * 0.4) * vol : decelLoad * 0.05 * vol;

    const setLayer = (L, gain, playRate) => {
      if (!L) return;
      try {
        L.src.playbackRate.setTargetAtTime(playRate, t, tau);
        L.gain.gain.setTargetAtTime(Math.max(0, gain), t, tau);
      } catch (_) {}
    };

    setLayer(S.idle, idleG * idleWobbleSafe(this), rate * 0.85);
    setLayer(S.body, bodyG, rate);
    setLayer(S.high, highG, rateHi);
    setLayer(S.load, loadG, rate * 1.05);
    setLayer(S.overrun, overG, rate * 0.95);
  }
}

function idleWobbleSafe(engine) {
  return (
    1 +
    Math.sin((engine._idlePhase || 0) * 2.4) * 0.03 +
    Math.sin((engine._idlePhase || 0) * 5.5) * 0.02
  );
}

function makeDriveCurve(amount) {
  const n = 512;
  const curve = new Float32Array(n);
  const k = Math.max(0.01, amount) * 80;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
