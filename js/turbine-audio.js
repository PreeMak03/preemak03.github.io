/**
 * TURBINE — fourth TAS sound engine. A gas turbine, not a piston engine.
 *
 * WHY IT IS ITS OWN ENGINE
 *   Everything hard about CRANK comes from combustion: a firing order, a
 *   frequency that has to stay above where the ear resolves separate thuds, and
 *   a listener who knows exactly what a four-cylinder is supposed to sound like.
 *   A turbine has none of that. There are no firings — just a shaft spinning,
 *   blades passing, and air roaring — so there is no reference in anyone's head
 *   for it to be wrong against.
 *
 *   And it needs no gearbox. Shaft speed follows road speed continuously, which
 *   removes the upshift rev-snap, the overrun state machine and the gear
 *   hysteresis in one go — the three things that have caused every judder so far.
 *
 * WHAT MAKES IT SOUND LIKE A TURBINE
 *   spool   the shaft tone, rich in harmonics, sweeping with speed. It LAGS the
 *           demand, which is the signature: a jet does not answer instantly.
 *   blade   blade-passing tone, a fixed multiple of shaft speed — the metallic
 *           edge that says turbine rather than motor.
 *   whine   a high pure partial that only appears once the shaft is up, so the
 *           top end opens out instead of just getting louder.
 *   roar    filtered noise, the air itself. Carries most of the loudness.
 *   hiss    bright air noise on top, so the sound has some sparkle.
 *
 *   Stereo is real here, unlike a piston engine: the two shaft oscillators are
 *   genuinely detuned from each other, so panning them apart produces an actual
 *   L/R difference rather than the same signal twice.
 *
 * COST
 *   5 oscillators, 2 looping noise buffers, ~12 filters. The shaft wave is ~32
 *   partials built once at start (not the 384-partial tables CRANK compiles
 *   offline — a turbine's spectrum is smooth and does not need them). Nothing is
 *   allocated per tick.
 */

import { clamp, damp } from './animations.js';
import { computeDynamicVolume } from './dynamic-volume.js';
import { TURBINE_RIGS } from './turbine-rigs.js';

export { hasTurbine, listTurbineRigs } from './turbine-rigs.js';

function tasUrl(rel) {
  if (typeof window !== 'undefined' && window.__TAS_ASSET_BASE__) {
    try {
      return new URL(String(rel).replace(/^\//, ''), window.__TAS_ASSET_BASE__).href;
    } catch (_) { /* fall through */ }
  }
  return rel;
}

const at = (param, v, t, tau = 0.05) => param.setTargetAtTime(Math.max(0, v), t, tau);
const cents = (c) => c;   // AudioParam.detune is already in cents

/** Shaft tone: a smooth falling harmonic series with a lift on the blade partial. */
function shaftWave(ctx, partials, tilt, bladeMul) {
  const n = partials + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    let a = 1 / Math.pow(k, tilt);
    // Blades passing put energy at a multiple of shaft speed — this is what
    // separates "turbine" from "a synth pad sweeping".
    const d = Math.abs(k - bladeMul);
    a *= 1 + 0.9 * Math.exp(-d * d * 0.35);
    imag[k] = a;
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

function noiseBuffer(ctx, seconds, kind) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      d[i] = (b0 + b1 + b2 + w * 0.3) * 0.22;
    }
  }
  return buf;
}

/** Brick-wall ceiling (classic engine parity) — nothing leaves above full scale. */
function ceilingCurve(knee = 0.82, ceil = 0.985) {
  const n = 2048;
  const curve = new Float32Array(n);
  const span = Math.max(1e-4, ceil - knee);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    curve[i] = Math.sign(x) * Math.min(ceil, y);
  }
  return curve;
}

const DEFAULT_DYN = {
  dynDb: 16, dynCeiling: 0.92, shiftDuck: 1, overrunDuck: 0.85,
  idlePresence: 0.6, loadBoost: 0.2, floorBias: 0.8,
};

export class TurbineAudio {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.speedReactive = true;
    this.smoothFilter = true;
    this.accelRefKmhps = 26;

    this._profileId = 'turbine-jet';
    this._profile = null;
    this._rigUrl = TURBINE_RIGS['turbine-jet'];
    this._rigCache = {};
    this._spec = null;
    this._dyn = { ...DEFAULT_DYN };

    this._speed = 0; this._speedSmooth = 0;
    this._accel = 0; this._accelSmooth = 0;
    this._throttle = 0; this._brake = 0;

    /** Shaft speed, 0..1. Lags the demand — the spool. */
    this._n = 0;
    this._load = 0;
    this._driveState = 'idle';
    this._holdRpm = null;
    this._masterOverride = null;
    this._bass = 0.5;
    this._edge = 0.5;
    this._nodes = null;
    this._timer = null;
    this._lite = false;
    this._tickJitterMs = 0;
    this._wanderPhase = 0;
  }

  setProfile(profile) {
    const id = profile && profile.id;
    this._profile = profile || null;
    if (id) this._profileId = id;
    if (id && TURBINE_RIGS[id]) this._rigUrl = TURBINE_RIGS[id];
  }

  getTuneLayers() {
    return {
      engine: 'Turbine spec -> .turbine.json (spool / blade / roar)',
      cabin: 'Bass / Edge (this card)',
      vehicle: 'Speed -> shaft, no gearbox',
      app: 'App system (global)',
    };
  }

  async _loadDoc(url) {
    const full = tasUrl(url);
    if (this._rigCache[full]) return this._rigCache[full];
    const res = await fetch(full, { cache: 'reload' });
    if (!res.ok) throw new Error(`turbine profile ${full} -> HTTP ${res.status}`);
    const doc = await res.json();
    this._rigCache[full] = doc;
    return doc;
  }

  _resolveLite(perf) {
    if (perf === 'lite') return true;
    if (perf === 'full') return false;
    const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '').toLowerCase();
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 8;
    return ua.includes('tesla') || cores <= 4;
  }

  async start() {
    if (this.running) return;
    let perf = 'auto';
    try {
      const m = await import('./profiles.js');
      perf = (m.getGlobalControl?.() || {}).perf || 'auto';
    } catch (_) { /* auto is fine */ }
    this._lite = this._resolveLite(perf);

    const doc = await this._loadDoc(this._rigUrl);
    this._spec = doc.spec;
    this._dyn = { ...DEFAULT_DYN, ...(doc.dynamics || {}) };

    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new AC({ latencyHint: this._lite ? 'playback' : 'interactive' }); }
    catch (_) { this.ctx = new AC(); }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (_) {} }

    this._buildGraph();
    this.running = true;
    const tickMs = this._lite ? 33 : 20;
    this._lastTickWall = performance.now();
    this._timer = setInterval(() => {
      const now = performance.now();
      let dt = (now - this._lastTickWall) / 1000;
      this._lastTickWall = now;
      this._tickJitterMs = this._tickJitterMs * 0.9 + Math.abs(dt * 1000 - tickMs) * 0.1;
      if (!(dt > 0) || dt > 0.25) dt = tickMs / 1000;
      this._tick(dt);
    }, tickMs);
  }

  stop() {
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (_) {} this.ctx = null; }
    this._nodes = null;
  }

  _buildGraph() {
    const ctx = this.ctx;
    const s = this._spec;

    const bus = ctx.createGain();
    bus.gain.value = s.outputTrim ?? 1;

    // --- shaft: two genuinely detuned oscillators, panned apart. Unlike a
    // piston engine's banks (which carry the same wave and collapse back to
    // mono when summed), these differ, so the width is real.
    const wave = shaftWave(ctx, s.partials ?? 32, s.tilt ?? 1.15, s.blade.mul);
    const mkShaft = (detune, pan) => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.detune.value = cents(detune);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 0.8;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      const g = ctx.createGain(); g.gain.value = 0;
      osc.connect(lp).connect(g).connect(p).connect(bus);
      return { osc, lp, g, p };
    };
    const spread = s.stereo?.spread ?? 0.5;
    const det = s.stereo?.detuneCents ?? 9;
    const shaftL = mkShaft(-det, -spread);
    const shaftR = mkShaft(+det, +spread);

    // --- blade tone: metallic edge at a multiple of shaft speed
    const bladeOsc = ctx.createOscillator();
    bladeOsc.type = 'sine';
    const bladeGain = ctx.createGain(); bladeGain.gain.value = 0;
    bladeOsc.connect(bladeGain).connect(bus);

    // --- whine: only opens up once the shaft is spinning
    const whineOsc = ctx.createOscillator();
    whineOsc.type = 'sine';
    const whineGain = ctx.createGain(); whineGain.gain.value = 0;
    whineOsc.connect(whineGain).connect(bus);

    // --- roar + hiss: the air. Carries most of the loudness.
    const pink = noiseBuffer(ctx, 2, 'pink');
    const white = noiseBuffer(ctx, 2, 'white');
    const loop = (buf) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true; src.start();
      return src;
    };
    const roarSrc = loop(pink);
    const roarBp = ctx.createBiquadFilter();
    roarBp.type = 'bandpass'; roarBp.Q.value = s.roar.q ?? 0.7;
    const roarGain = ctx.createGain(); roarGain.gain.value = 0;
    roarSrc.connect(roarBp).connect(roarGain).connect(bus);

    const hissSrc = loop(white);
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass'; hissHp.frequency.value = s.hiss.hz ?? 4200; hissHp.Q.value = 0.7;
    const hissGain = ctx.createGain(); hissGain.gain.value = 0;
    hissSrc.connect(hissHp).connect(hissGain).connect(bus);

    // --- cabin + output, same staging as the other engines
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 140; low.gain.value = 0;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf'; high.frequency.value = 3500; high.gain.value = 0;
    const dynGain = ctx.createGain(); dynGain.gain.value = 1;
    const makeup = ctx.createGain(); makeup.gain.value = s.makeup ?? 1.3;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 3; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.09;

    const safety = ctx.createWaveShaper();
    safety.oversample = 'none';
    safety.curve = ceilingCurve(0.82, 0.985);

    const master = ctx.createGain(); master.gain.value = 0;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.72;

    bus.connect(low).connect(high).connect(dynGain).connect(makeup)
      .connect(limiter).connect(master);
    master.connect(safety);
    safety.connect(analyser);
    analyser.connect(ctx.destination);

    const t0 = ctx.currentTime + 0.02;
    shaftL.osc.start(t0); shaftR.osc.start(t0); bladeOsc.start(t0); whineOsc.start(t0);

    this._nodes = {
      bus, shaftL, shaftR, bladeOsc, bladeGain, whineOsc, whineGain,
      roarSrc, roarBp, roarGain, hissSrc, hissHp, hissGain,
      low, high, dynGain, makeup, limiter, safety, master, analyser,
    };
    this.setBass(this._bass);
    this.setEdge(this._edge);
  }

  getAnalyser() { return this._nodes ? this._nodes.analyser : null; }

  _tick(dt) {
    if (!this.running || !this._nodes) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = this._spec;
    const N = this._nodes;

    const smoothL = this.smoothFilter ? 6 : 16;
    this._speedSmooth = damp(this._speedSmooth, this._speed, smoothL, dt);
    this._accelSmooth = damp(this._accelSmooth, this._accel, this.smoothFilter ? 10 : 18, dt);

    let accelForLoad = this._accelSmooth;
    if (Math.abs(accelForLoad) < 1.5) accelForLoad = 0;      // classic parity deadband
    const aNorm = clamp(accelForLoad / this.accelRefKmhps, -1.4, 1.4);
    const accelLoad = clamp(aNorm, 0, 1);
    const decelLoad = clamp(-aNorm, 0, 1);

    const speed = this._speedSmooth;
    // Demand: how hard the turbine is being asked to work. Road speed sets the
    // floor, acceleration lifts it — the same idea as the piston profiles, but
    // it drives ONE continuous shaft instead of a rev target inside a gear.
    let demand = clamp(speed / (s.spool.topSpeedKmh ?? 140), 0, 1.05);
    demand = Math.pow(demand, s.spool.curve ?? 0.8);
    demand = clamp(demand + accelLoad * (s.spool.accelLift ?? 0.22) - decelLoad * 0.06, 0, 1.08);
    if (this._holdRpm != null) demand = clamp(this._holdRpm / 8000, 0, 1.08);

    // Spool inertia — a turbine does not answer instantly, and the lag IS the
    // sound. Slower to wind up than to wind down, like the real thing.
    const rising = demand > this._n;
    const lag = rising ? (s.spool.lagSec ?? 0.9) : (s.spool.decaySec ?? 1.4);
    this._n += (demand - this._n) * (1 - Math.exp(-dt / lag));

    // Slow wander so it never sits perfectly still.
    this._wanderPhase += dt;
    const wp = this._wanderPhase;
    const wander = 1 + (s.wander ?? 0.012) *
      (0.6 * Math.sin(wp * 0.9) + 0.4 * Math.sin(wp * 2.3));

    const n = clamp(this._n * wander, 0, 1.1);
    this._load = clamp(n * 0.75 + accelLoad * 0.25, 0, 1);
    this._driveState = accelLoad > 0.22 ? 'pull' : decelLoad > 0.3 ? 'overrun'
      : speed < 1.5 ? 'idle' : 'cruise';

    // --- frequencies ------------------------------------------------------
    const hz = s.spool.idleHz + (s.spool.topHz - s.spool.idleHz) * n;
    const tau = 0.04;
    N.shaftL.osc.frequency.setTargetAtTime(hz, t, tau);
    N.shaftR.osc.frequency.setTargetAtTime(hz, t, tau);
    N.bladeOsc.frequency.setTargetAtTime(hz * s.blade.mul, t, tau);
    N.whineOsc.frequency.setTargetAtTime(hz * s.whine.mul, t, tau);

    // Shaft brightness opens with speed
    const lp = s.shaftLpHz.lo + (s.shaftLpHz.hi - s.shaftLpHz.lo) * Math.pow(n, 0.7);
    N.shaftL.lp.frequency.setTargetAtTime(lp, t, 0.06);
    N.shaftR.lp.frequency.setTargetAtTime(lp, t, 0.06);
    N.roarBp.frequency.setTargetAtTime(s.roar.loHz + (s.roar.hiHz - s.roar.loHz) * n, t, 0.06);

    // --- levels -----------------------------------------------------------
    const shaftG = s.shaftGain * (0.25 + 0.75 * n);
    at(N.shaftL.g.gain, shaftG, t, 0.05);
    at(N.shaftR.g.gain, shaftG, t, 0.05);
    at(N.bladeGain.gain, s.blade.gain * Math.pow(n, 1.3), t, 0.05);
    // The whine only arrives once the shaft is up, so the top end OPENS rather
    // than simply getting louder.
    const whineOn = clamp((n - (s.whine.riseFrom ?? 0.35)) / 0.4, 0, 1);
    at(N.whineGain.gain, s.whine.gain * whineOn * whineOn, t, 0.06);
    at(N.roarGain.gain, s.roar.gain * (0.2 + 0.8 * n), t, 0.05);
    at(N.hissGain.gain, s.hiss.gain * Math.pow(n, 1.5), t, 0.06);

    // --- in-car loudness ---------------------------------------------------
    const dyn = computeDynamicVolume({
      effort: accelLoad, rpmNorm: n, accelLoad, decelLoad, speed,
      idlePresence: this._dyn.idlePresence, gear: 1, gearCount: 1,
      dynDb: this._dyn.dynDb, curveMul: 1, loadBoost: this._dyn.loadBoost,
      floorBias: this._dyn.floorBias, load: this._load,
      softCeiling: this._dyn.dynCeiling,
      shiftDuck: this._dyn.shiftDuck, overrunDuck: this._dyn.overrunDuck,
      overrun: this._driveState === 'overrun',
    });
    at(N.dynGain.gain, clamp(dyn.dynVol, 0, 1.2), t, 0.05);
    at(N.master.gain, this._masterOverride != null ? this._masterOverride : 0.8, t, 0.04);
  }

  setSpeed(kmh, extras = {}) {
    this._speed = Math.max(0, kmh);
    if (extras.throttle != null) this._throttle = clamp(extras.throttle, 0, 1);
    if (extras.brake != null) this._brake = clamp(extras.brake, 0, 1);
    if (extras.accelKmhps != null) this._accel = extras.accelKmhps;
  }

  setThrottle(v) { if (v != null) this._throttle = clamp(v, 0, 1); }
  setAccel(k) { this._accel = k; }
  setHoldRpm(rpm) { this._holdRpm = rpm == null ? null : Math.max(0, rpm); }

  setMasterVolume(v) {
    this._masterOverride = clamp(v, 0, 1.2);
    if (!this._nodes || !this.ctx) return;
    at(this._nodes.master.gain, this._masterOverride, this.ctx.currentTime, 0.03);
  }

  setBass(v) {
    this._bass = clamp(v, 0, 1);
    if (!this._nodes || !this.ctx) return;
    this._nodes.low.gain.setTargetAtTime((this._bass - 0.5) * 10, this.ctx.currentTime, 0.05);
  }

  setEdge(v) {
    this._edge = clamp(v, 0, 1);
    if (!this._nodes || !this.ctx) return;
    this._nodes.high.gain.setTargetAtTime((this._edge - 0.5) * 10, this.ctx.currentTime, 0.05);
  }

  /** No gearbox to script, so a rev test is just a full spool and release. */
  startRevTest(seconds = 5) {
    if (!this.running) return false;
    const hold = clamp(seconds, 2, 10) * 1000;
    this._holdRpm = 8000;
    window.setTimeout(() => { this._holdRpm = null; }, hold);
    return true;
  }

  /** Reported as a shaft speed so the readout has something to show. */
  get rpm() { return Math.round(this._n * (this._spec?.shaftRpmTop ?? 42000)); }
  get gearIndex() { return 1; }
  get gearCount() { return 1; }
  get driveState() { return this._driveState; }
  get load() { return this._load; }
  get shaftN() { return this._n; }
}
