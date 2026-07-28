/* ============================================================================
   VesselAudio — deploy bridge for the VESSEL runtime (the "new standard").
   DROP-IN for AudioEngine's public interface, so app.js swaps engines freely.

   LAYER MODEL (keep these separate when tuning):
     ① ENGINE SOUND PROFILE  — compiled .vsl (from Engine DNA .engine.json)
     ② CABIN SOUND PROFILE   — cabin{} + synthesis{} in the rig (this file applies)
     ③ VEHICLE SYSTEM        — vehicle{} gearing / rpm map for THIS sound card
     ④ APP SYSTEM            — Master volume, GPS, Speed Reactive, Sim (app.js only)
                               never stored in the rig; not part of a car profile

   ①+②+③ live in assets/vessel/*.rig.json (built by vessel/tools/build.mjs).
   ④ is global webapp state (localStorage / sliders).
   ============================================================================ */
import {
  GEAR_COUNT,
  resolveGear,
  rpmInGear,
  shiftLandingRpm,
  gearProgress,
  gearToneBias,
} from './gearbox.js';
import { buildRevScript, stepRevScript } from './launch-rev.js';
import { computeDynamicVolume } from './dynamic-volume.js';
import { VESSEL_RIGS, hasRig, listVesselRigs, isVesselProfileId } from './vessel-rigs.js';

export { hasRig, listVesselRigs, isVesselProfileId };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));

/** Resolve asset/worklet URLs when app is not at site root (e.g. CommandRoom). */
function tasUrl(rel) {
  if (typeof window !== 'undefined' && window.__TAS_ASSET_BASE__) {
    try {
      return new URL(String(rel).replace(/^\//, ''), window.__TAS_ASSET_BASE__).href;
    } catch (_) { /* fall through */ }
  }
  return rel;
}
function vesselWorkletUrl() {
  if (typeof window !== 'undefined' && window.__TAS_VESSEL_WORKLET__) {
    return window.__TAS_VESSEL_WORKLET__;
  }
  return tasUrl('js/vessel-runtime.worklet.js');
}

const RIGS = VESSEL_RIGS;

const DEFAULT_VEH = { idle: 800, redline: 7000, revLo: 0.15, revHi: 0.5, pull: 0.9 };
const DEFAULT_DYN = { curve: [[800, 0.6], [7000, 1.0]], loadBoost: 0.5, accelBoost: 0.35 };
// Cabin defaults — biased DARK/THUMP to match Classic Muscle “ทุ้ม” preference.
// Classic muscle lives ~filterIdle 220 → filterRedline ~2600; VESSEL was too open up top.
const DEFAULT_CABIN = {
  master: 0.62,
  boomFreq: 52, boomGain: 5.5, boomQ: 2.0,   // stronger cabin boom
  lowFreq: 95, lowGain: 5.5,                 // body shelf (classic sub/body)
  midScoopFreq: 2200, midScoopGain: -5.5, midScoopQ: 1.0, // kill harsh mid “แหลม”
  highFreq: 1800, highGain: -8,
  hpf: 36, lpf: 2600,                        // match classic muscle ceiling-ish
  drive: 0.05,
  width: 0.00026,
};
const DEFAULT_SYNTH = {
  textureGain: 0.42,     // formant/high band was the main “แหลม” source
  residualNoise: 0.012,
  softPulseMs: 1.6,
  cabinCutHz: 2200,      // worklet one-pole before cabin EQ
  tipInGain: 0.14,
  overrunTilt: 0.22,
  loadBoom: 0.7,
  perceptionTilt: 0.42,
  // Waveguide exhaust bus (DasEtwas/Baldan) — off by default; enable per-rig
  waveguide: false,
  waveguideGain: 0.28,
  /** Hybrid Classic stability: smooth RPM/load + HF/sub clamps (soft toggle) */
  hybridStability: true,
  /** Kill radio-tuner static: smooth filter coeffs + soft fire + noise gate */
  antiStatic: true,
  globalMaxLpf: 1800,
  /** v2 organic dynamics (tip/overrun drive — no pink pops) */
  organicV2: true,
};

/** Optional peaking output bands from deploy.bands[] */
const DEFAULT_BANDS = [
  { id: 'sub', f: 55, Q: 1.2, gain: 0, on: true },
  { id: 'body', f: 110, Q: 1.0, gain: 0, on: true },
  { id: 'lowmid', f: 280, Q: 1.0, gain: 0, on: true },
  { id: 'mid', f: 700, Q: 1.1, gain: 0, on: true },
  { id: 'presence', f: 1600, Q: 1.2, gain: 0, on: true },
  { id: 'air', f: 3200, Q: 1.0, gain: 0, on: true },
];

export class VesselAudio {
  constructor() {
    this.ctx = null; this.node = null; this.running = false;
    // Match Classic defaults for drive feel
    this.speedReactive = true; this.smoothFilter = true;
    this._rigUrl = RIGS['camaro-vessel']; this._rigCache = {};
    this._veh = DEFAULT_VEH; this._dyn = DEFAULT_DYN;
    this._cabin = { ...DEFAULT_CABIN }; this._synth = { ...DEFAULT_SYNTH };
    this._bands = DEFAULT_BANDS.map((b) => ({ ...b }));
    this._speed = 0; this._speedSmooth = 0; this._accel = 0; this._accelSmooth = 0;
    this._throttle = 0; this._brake = 0;
    this.accelRefKmhps = 26; // same as AudioEngine — hard pull revs harder
    this._rpm = this._veh.idle; this._gear = 1; this._driveState = 'idle';
    this._load = 0; this._accelEnv = 0; this._prevRpm = this._rpm; this._sinceShift = 0;
    this._prevLoad = 0; this._tipIn = 0; this._overrun = 0;
    this._masterOverride = null;
    this._layerInfo = null;
    this._profileId = 'camaro-vessel';
    this._profile = null; // full SoundProfile (for engine revLo/Hi/pull overrides)
    /** Launch Rev (+ v3 multi-bus cues from stepRevScript) */
    this._revUntil = 0;
    this._revDuration = 5;
    this._revScript = null;
    this._revTipIn = 0;
    this._revOverrun = 0;
    this._revTxScale = 1;
    this._revGearSnap = false;
    /** Gear-shift flash */
    this._shifting = false;
    this._shiftTimer = 0;
    this._shiftUp = false;      // direction of the current shift (up vs down)
    this._postShift = 0;        // seconds left of the post-upshift "catch" punch
    this._liftHold = 0;         // GPS lift-off (throttle release) engine-braking hold
    this._prevGear = 1;
    this._gearBias = gearToneBias(1);
    /** Classic-parity dynamics */
    this._jitter = 0;
    this._effort = 0;
    this._effortHold = 0;
    this._idlePhase = 0;
    this._holdRpm = null; // eval A/B pin
    this._revHang = 0.2;  // from DNA transient if present
    this._idlePresence = 0.75;
  }

  setProfile(profile) {
    const id = profile && profile.id;
    this._profile = profile || null;
    this._profileId = id || this._profileId;
    if (id && RIGS[id]) this._rigUrl = RIGS[id];
    // Pull per-profile rev character from classic-style engine{} when present
    if (profile?.engine) {
      const e = profile.engine;
      if (e.idleRpm != null) this._veh = { ...this._veh, idle: e.idleRpm };
      if (e.redlineRpm != null) this._veh = { ...this._veh, redline: e.redlineRpm };
      if (e.revLo != null) this._veh = { ...this._veh, revLo: e.revLo };
      if (e.revHi != null) this._veh = { ...this._veh, revHi: e.revHi };
      if (e.revPull != null) this._veh = { ...this._veh, pull: e.revPull };
    }
    if (profile?.tone?.idlePresence != null) this._idlePresence = profile.tone.idlePresence;
  }

  /** What the UI should label as Sound Profile vs App System. */
  getTuneLayers() {
    return this._layerInfo || {
      engine: 'Engine DNA → .vsl',
      cabin: 'Cabin sound profile',
      vehicle: 'Vehicle system (this card)',
      app: 'App system (global)',
    };
  }

  async _loadRig() {
    const url = tasUrl(this._rigUrl);
    let rig = this._rigCache[url];
    if (!rig) { rig = await (await fetch(url, { cache: 'reload' })).json(); this._rigCache[url] = rig; }
    this._veh = { ...DEFAULT_VEH, ...(rig.vehicle || {}) };
    // Merge classic profile engine{} on top of rig vehicle (rev character)
    if (this._profile?.engine) {
      const e = this._profile.engine;
      if (e.idleRpm != null) this._veh.idle = e.idleRpm;
      if (e.redlineRpm != null) this._veh.redline = e.redlineRpm;
      if (e.revLo != null) this._veh.revLo = e.revLo;
      if (e.revHi != null) this._veh.revHi = e.revHi;
      if (e.revPull != null) this._veh.pull = e.revPull;
    }
    this._dyn = rig.dynamics || DEFAULT_DYN;
    this._cabin = { ...DEFAULT_CABIN, ...(rig.cabin || {}) };
    this._synth = { ...DEFAULT_SYNTH, ...(rig.synthesis || {}) };
    if (Array.isArray(rig.bands) && rig.bands.length) {
      this._bands = DEFAULT_BANDS.map((def) => {
        const hit = rig.bands.find((x) => x.id === def.id || x.f === def.f);
        return hit ? { ...def, ...hit, on: hit.on !== false } : { ...def };
      });
    } else {
      this._bands = DEFAULT_BANDS.map((b) => ({ ...b }));
    }
    // rev hang from compiled DNA aux if present
    const rh = rig.vsl?.aux?.transient?.revHang;
    if (rh != null) this._revHang = rh;
    if (this._profile?.tone?.idlePresence != null) this._idlePresence = this._profile.tone.idlePresence;
    // CommandRoom override: control.json cars[id] wins over the rig, so per-car
    // vehicle/dynamics/cabin/synth can be tuned centrally WITHOUT rebuilding the .vsl.
    try {
      const m = await import('./profiles.js');
      const ov = m.getCarOverride?.(this._profileId);
      if (ov) {
        if (ov.vehicle) this._veh = { ...this._veh, ...ov.vehicle };
        if (ov.dynamics) this._dyn = { ...this._dyn, ...ov.dynamics };
        if (ov.cabin) this._cabin = { ...this._cabin, ...ov.cabin };
        if (ov.synth) this._synth = { ...this._synth, ...ov.synth };
      }
    } catch (_) {}
    this._layerInfo = {
      engine: rig.compiledFrom || 'Engine DNA (compiled .vsl)',
      cabin: 'cabin{} + synthesis{} in rig',
      vehicle: 'vehicle{} in rig',
      app: 'Master / GPS / Reactive (app only)',
      name: rig.name || 'VESSEL',
    };
    if (this.node) this._pushSynthToWorklet(rig.vsl);
  }

  _pushSynthToWorklet(vsl) {
    if (!this.node) return;
    const s = this._synth;
    // combustion_rand from DNA lives on compiled vsl.aux — also pass explicit opts
    const combRand = vsl?.aux?.combustion?.rand
      ?? vsl?.aux?.idle?.combustionRand
      ?? s.combustionRand;
    // DNA geometry → waveguide opts (meters)
    const pipe = vsl?.aux?.pipe || vsl?.aux?.geometry || {};
    const eng = vsl?.aux?.engine || {};
    const waveguideOpts = {
      intakeLenM: pipe.intakeLenM ?? (eng.intake_len != null ? eng.intake_len / 1000 : undefined),
      exhaustLenM: pipe.exhaustLenM ?? (eng.header_len_prim != null ? eng.header_len_prim / 1000 : undefined),
      extractorLenM: pipe.extractorLenM,
      straightPipeLenM: pipe.tailpipeLenM
        ?? pipe.straightPipeLenM
        ?? (eng.tailpipe_len != null ? eng.tailpipe_len / 1000 : undefined),
      mufflerAction: pipe.mufflerAction
        ?? (eng.muffler_absorb != null ? eng.muffler_absorb * 0.25 : undefined),
      ignitionTime: s.pulseSharpness != null ? 0.04 + s.pulseSharpness * 0.08 : 0.06,
      crankshaftFluctuation: Math.min(0.35, (combRand != null ? combRand : 0.03) * 6),
      exhaustLpfHz: s.waveguideExhaustLpf != null ? s.waveguideExhaustLpf : 1280,
      intakeVolume: s.waveguideIntake != null ? s.waveguideIntake : 0,
      exhaustVolume: 0.65,
      engineVibrationsVolume: 0.03,
      intakeNoiseFactor: 0,
      master: 0.4,
    };
    this.node.port.postMessage({
      profile: vsl,
      textureGain: s.textureGain,
      residualNoise: s.residualNoise,
      softPulseMs: s.softPulseMs,
      pulseSharpness: s.pulseSharpness != null ? s.pulseSharpness : 0.3,
      cabinCutHz: s.cabinCutHz,
      tipInGain: s.tipInGain,
      overrunTilt: s.overrunTilt,
      // D) analog saturation — cabin drive maps into worklet tanh
      drive: (this._cabin && this._cabin.drive != null) ? this._cabin.drive * 4 + 0.25 : 0.35,
      // Feature matrix (all soft-toggle — no file restore required)
      // organicV2:false → disable organic dynamics only
      organicV2: s.organicV2 !== false,
      // hybridStability:false → raw AudioParam steps (debug)
      hybridStability: s.hybridStability !== false,
      antiStatic: s.antiStatic !== false,
      globalMaxLpf: s.globalMaxLpf != null ? s.globalMaxLpf : 1800,
      // Perf self-throttle (control.global.perf → lite): cap the per-sample partial bank.
      // CPU-only; never touches sampleRate (a low SR made a filter emit NaN → silence).
      perfMaxPartials: this._lite ? 16 : 0,
      combustionRand: combRand != null ? combRand : 0.03,
      loadLag: s.loadLag != null ? s.loadLag : 0.12,
      timingJitterDeg: s.timingJitterDeg != null ? s.timingJitterDeg : 0.35,
      // Waveguide exhaust bus — synthesis.waveguide:true to enable
      waveguide: s.waveguide === true,
      waveguideGain: s.waveguideGain != null ? s.waveguideGain : 0.28,
      waveguideOpts,
      resetWaveguide: true,
    });
  }

  async start() {
    if (this.running) return;
    // Perf tier comes from CommandRoom (control.global.perf: auto|lite|full) — the ONE
    // place the MCU2/Tesla budget is controlled. lite = big audio buffers + slower
    // telemetry tick (fixes GPS-follow lag on weak cores). Never force a low sampleRate
    // (a filter emitted NaN → silence).
    let perf = 'auto';
    try { const m = await import('./profiles.js'); perf = (m.getGlobalControl?.() || {}).perf || 'auto'; } catch (_) {}
    this._lite = this._resolveLite(perf);
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new AC({ latencyHint: this._lite ? 'playback' : 'interactive' }); }
    catch (_) { this.ctx = new AC(); }
    await this.ctx.audioWorklet.addModule(vesselWorkletUrl());
    this.node = new AudioWorkletNode(this.ctx, 'vessel-runtime', { numberOfOutputs: 1, outputChannelCount: [1] });
    await this._loadRig();
    this._buildGraph();
    this._rpm = this._veh.idle;
    this.node.parameters.get('rpm').setValueAtTime(this._rpm, this.ctx.currentTime);
    this.node.parameters.get('load').setValueAtTime(0, this.ctx.currentTime);
    // v3 Global Transmission — gear k-rate for worklet volume scale
    if (this.node.parameters.get('gear')) {
      this.node.parameters.get('gear').setValueAtTime(this._gear || 1, this.ctx.currentTime);
    }
    this.running = true;
    const tickMs = this._lite ? 33 : 20;
    this._timer = setInterval(() => this._tick(tickMs / 1000), tickMs);
  }

  stop() {
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    if (this.ctx) { this.ctx.close(); this.ctx = null; this.node = null; }
  }

  /** perf tier (control.global.perf): auto → lite on Tesla/weak cores, else full. */
  _resolveLite(perf) {
    if (perf === 'lite') return true;
    if (perf === 'full') return false;
    const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '').toLowerCase();
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 8;
    return ua.includes('tesla') || cores <= 4;
  }

  /**
   * Cabin transmission chain (first-principles, not free-field):
   *   worklet → soft drive → cabin boom → body shelves → mid scoop (firewall) →
   *   HPF → cabin LPF (~4 kHz) → dyn gain → stereo width → limiter → master
   */
  _buildGraph() {
    const ac = this.ctx, N = this.node, c = this._cabin;
    const drive = ac.createWaveShaper();
    drive.curve = this._driveCurve(c.drive); drive.oversample = 'none';

    // ~40–80 Hz cabin boom (structure / cabin volume mode)
    const boom = ac.createBiquadFilter();
    boom.type = 'peaking';
    boom.frequency.value = c.boomFreq ?? 52;
    boom.Q.value = c.boomQ ?? 2.0;
    boom.gain.value = c.boomGain ?? 5.5;

    // Extra sub shelf — Classic Muscle has a dedicated sub layer; VESSEL needs this for ทุ้ม
    const sub = ac.createBiquadFilter();
    sub.type = 'lowshelf';
    sub.frequency.value = 72;
    sub.gain.value = c.subGain != null ? c.subGain : 3.5;

    const low = ac.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = c.lowFreq; low.gain.value = c.lowGain;

    // Firewall / glass: mild scoop of harsh mids that free-field exhaust has
    const mid = ac.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = c.midScoopFreq ?? 2400;
    mid.Q.value = c.midScoopQ ?? 0.9;
    mid.gain.value = c.midScoopGain ?? -3.5;

    const high = ac.createBiquadFilter();
    high.type = 'highshelf'; high.frequency.value = c.highFreq; high.gain.value = c.highGain;

    const hpf = ac.createBiquadFilter();
    hpf.type = 'highpass'; hpf.frequency.value = c.hpf;

    // Cabin LPF — engine content in-cabin is not a 9–12 kHz rasp source
    const lpf = ac.createBiquadFilter();
    lpf.type = 'lowpass'; lpf.frequency.value = c.lpf ?? 4200; lpf.Q.value = 0.707;
    // 2nd pole for steeper "what cabin doesn't pass"
    const lpf2 = ac.createBiquadFilter();
    lpf2.type = 'lowpass'; lpf2.frequency.value = (c.lpf ?? 4200) * 1.15; lpf2.Q.value = 0.5;

    // Perception tilt — mild low shelf that tracks master (equal-loudness-ish)
    const perc = ac.createBiquadFilter();
    perc.type = 'lowshelf'; perc.frequency.value = 180; perc.gain.value = 1.5;

    // Output bands (from deploy.bands) — peaking EQ after cabin
    const bandNodes = (this._bands || DEFAULT_BANDS).map((b) => {
      const f = ac.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = b.f;
      f.Q.value = b.Q || 1;
      f.gain.value = b.on === false ? 0 : (b.gain || 0);
      return f;
    });

    N.connect(drive);
    drive.connect(boom); boom.connect(sub); sub.connect(low); low.connect(mid); mid.connect(high);
    high.connect(hpf); hpf.connect(lpf); lpf.connect(lpf2); lpf2.connect(perc);
    let prev = perc;
    for (const bn of bandNodes) { prev.connect(bn); prev = bn; }

    const dyn = ac.createGain(); dyn.gain.value = 0.6; prev.connect(dyn);
    const merger = ac.createChannelMerger(2), dR = ac.createDelay(0.01);
    dR.delayTime.value = c.width;
    dyn.connect(merger, 0, 0); dyn.connect(dR); dR.connect(merger, 0, 1);

    // Brick-wall SAFETY limiter only (high threshold, hard knee) — must NOT act as
    // an AGC. A low-threshold/12:1 compressor here flattens the cruise↔pull dynamic
    // volume (the coast-ducks / rpm-rises behaviour). Keep it catching clip peaks only.
    const lim = ac.createDynamicsCompressor();
    lim.threshold.value = -1.5; lim.ratio.value = 20; lim.knee.value = 1;
    lim.attack.value = 0.002; lim.release.value = 0.1;

    const master = ac.createGain();
    master.gain.value = this._masterOverride ?? c.master;
    merger.connect(lim); lim.connect(master); master.connect(ac.destination);

    this._nodes = { drive, boom, sub, low, mid, high, hpf, lpf, lpf2, perc, bandNodes, dyn, dR, lim, master };
  }

  _driveCurve(a) {
    const n = 1024, cc = new Float32Array(n), k = (a || 0) * 28;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * 2 - 1;
      cc[i] = k > 0 ? (1 + k) * x / (1 + k * Math.abs(x)) : x;
    }
    return cc;
  }

  _sampleCurve(rpm) {
    const c = this._dyn.curve;
    if (rpm <= c[0][0]) return c[0][1];
    if (rpm >= c[c.length - 1][0]) return c[c.length - 1][1];
    for (let i = 0; i < c.length - 1; i++) if (rpm >= c[i][0] && rpm <= c[i + 1][0]) {
      const t = (rpm - c[i][0]) / ((c[i + 1][0] - c[i][0]) || 1);
      return c[i][1] + (c[i + 1][1] - c[i][1]) * t;
    }
    return c[c.length - 1][1];
  }

  _tick(dt) {
    if (!this.running) return;
    const v = this._veh, d = this._dyn, ac = this.ctx;
    const smoothL = this.smoothFilter ? 6 : 16;
    this._speedSmooth = damp(this._speedSmooth, this._speed, smoothL, dt);
    this._accelSmooth = damp(this._accelSmooth, this._accel, this.smoothFilter ? 10 : 18, dt);
    const speed = this.speedReactive ? this._speedSmooth : Math.max(this._speedSmooth, 40);
    const aNorm = clamp(this._accelSmooth / this.accelRefKmhps, -1.4, 1.4);
    let accelLoad = clamp(aNorm, 0, 1), decelLoad = clamp(-aNorm, 0, 1);
    // Classic also blends throttle/brake extras when present
    accelLoad = Math.max(accelLoad, this._throttle * 0.85);
    decelLoad = Math.max(decelLoad, this._brake * 0.85);

    let load;
    const idle = v.idle ?? 800;
    const redline = v.redline ?? 7000;
    const span = Math.max(500, redline - idle);
    this._idlePhase += dt;

    // --- holdRpm eval pin (Classic A/B + CommandRoom listen) ---
    if (this._holdRpm != null) {
      this._rpm = damp(this._rpm, this._holdRpm, 12, dt);
      // Throttle drives load under pin (preview slider)
      load = clamp(0.12 + Math.max(this._throttle, accelLoad) * 0.88, 0, 1);
      this._driveState = load > 0.25 ? 'pull' : 'cruise';
      this._gearBias = gearToneBias(this._gear);
    // --- Launch Rev (v3 multi-bus: gear snap + bus tipIn/txScale) ---
    } else if (this._revUntil && performance.now() < this._revUntil) {
      const elapsed = (performance.now() - (this._revUntil - this._revDuration * 1000)) / 1000;
      const step = stepRevScript({
        elapsed,
        script: this._revScript,
        rpm: this._rpm,
        idle,
        redline,
        dt,
        onShiftClick: (down) => this._fireShiftClick(down),
      });
      this._rpm = step.rpm;
      // Prefer loadBus when present (multi-bus body/pulse feed)
      load = step.loadBus != null ? step.loadBus : step.load;
      this._gear = step.gear;
      this._driveState = step.state === 'done' ? 'idle' : step.state;
      this._shifting = step.shifting;
      if (step.shifting) this._shiftTimer = 0.08;
      this._gearBias = gearToneBias(this._gear);
      // Stash v3 cues for the worklet push below (tipIn/overrun/txScale)
      this._revTipIn = step.tipIn != null ? step.tipIn : 0;
      this._revOverrun = step.overrun != null ? step.overrun : 0;
      this._revTxScale = step.txScale != null ? step.txScale : 1;
      this._revGearSnap = !!step.gearSnap;
      this._effort = 1;
      this._effortHold = 0.8;
      if (step.done) {
        this._revUntil = 0;
        this._revScript = null;
        this._revTipIn = 0;
        this._revOverrun = 0;
        this._revTxScale = 1;
        this._revGearSnap = false;
      }
    } else {
      if (this._revUntil && performance.now() >= this._revUntil) {
        this._revUntil = 0;
        this._revScript = null;
      }

      if (this._shifting) {
        this._shiftTimer -= dt;
        if (this._shiftTimer <= 0) {
          this._shifting = false;
          // Post-upshift "catch": clutch re-engages → a short torque re-punch you can hear.
          if (this._shiftUp && accelLoad > 0.18) this._postShift = 0.14;
        }
      }
      if (this._postShift > 0) this._postShift -= dt;

      if (speed < 1.5 && accelLoad < 0.1) {
        load = 0.05; this._gear = 1; this._driveState = 'idle';
        // Idle wobble / lope presence (Classic idleAlive)
        const lope = 1 + Math.sin(this._idlePhase * 2.4) * 0.035 + Math.sin(this._idlePhase * 5.8) * 0.02;
        this._rpm = damp(this._rpm, idle * lope, 10, dt);
        this._gearBias = gearToneBias(1);
      } else {
        this._sinceShift += dt;
        let nextGear = resolveGear(speed, this._gear, accelLoad, decelLoad);
        if (nextGear > this._gear + 1) nextGear = this._gear + 1;
        else if (nextGear < this._gear - 1) nextGear = this._gear - 1;

        const MIN_DWELL = 0.26;
        if (nextGear !== this._gear && !this._shifting && this._sinceShift > MIN_DWELL) {
          const up = nextGear > this._gear;
          this._prevGear = this._gear;
          this._gear = nextGear;
          this._sinceShift = 0;
          this._shifting = true;
          this._shiftUp = up;
          this._shiftTimer = up ? 0.12 : 0.09;
          this._gearBias = gearToneBias(this._gear);
          this._fireShiftClick(!up);
          if (up) {
            this._rpm = shiftLandingRpm(this._gear, idle, redline, v.revLo ?? 0.15);
          } else if (accelLoad > 0.25) {
            const revHi = v.revHi ?? 0.5;
            const land = idle + span * Math.min(0.95, revHi * 0.9);
            this._rpm = Math.min(redline * 0.95, Math.max(this._rpm, land));
          }
        }

        this._gearBias = gearToneBias(this._gear);
        let targetRpm = rpmInGear({
          speedKmh: speed,
          gear: this._gear,
          idle,
          redline,
          accelLoad,
          decelLoad,
          revLo: v.revLo,
          revHi: v.revHi,
          pull: v.pull,
        });
        let rpmLambda = this.smoothFilter ? 7 : 12;
        if (accelLoad > 0.4) rpmLambda = 10 + accelLoad * 5;
        if (decelLoad > 0.4) rpmLambda = 9 + decelLoad * 4;
        if (this._shifting) {
          rpmLambda = 18;
          targetRpm = this._rpm * 0.94 + targetRpm * 0.06;
        }
        this._rpm = damp(this._rpm, clamp(targetRpm, idle * 0.85, redline * 1.05), rpmLambda, dt);

        load = clamp(accelLoad * 0.85 + decelLoad * 0.25 + (speed > 5 ? 0.08 : 0), 0, 1);
        const gPos = gearProgress(speed, this._gear);
        if (accelLoad > 0.3 && gPos > 0.75) load = clamp(load + 0.15, 0, 1);
        // Torque interruption: upshift cuts deeper/faster than a downshift blip.
        if (this._shifting) load = clamp(load * (this._shiftUp ? 0.12 : 0.28) + 0.05, 0, 1);
        // The re-engagement punch right after an upshift (short catch).
        else if (this._postShift > 0) load = clamp(load + 0.2 * (this._postShift / 0.14), 0, 1);

        if (this._shifting) this._driveState = 'shift';
        else if (decelLoad > 0.28) this._driveState = 'overrun';
        else if (accelLoad > 0.22) this._driveState = 'pull';
        else this._driveState = 'cruise';
        // Lift-off (throttle release at speed) → engine-braking overrun that TRAILS off,
        // not an instant cut. Refresh the hold while decelerating above walking pace.
        if (decelLoad > 0.2 && speed > 12) this._liftHold = 0.38;
      }
    }

    // Combustion micro-jitter (kills perfect-loop feel) — Classic parity
    const rpmNorm = clamp((this._rpm - idle) / span, 0, 1.1);
    const jAmt = 0.003 + (1 - rpmNorm) * 0.007 + accelLoad * 0.0025;
    this._jitter = damp(this._jitter, (Math.random() * 2 - 1) * jAmt, 4, dt);
    const rpmOut = this._rpm * (1 + this._jitter);

    // Effort + rev-hang (Classic: punch in fast, hold ~1s / DNA revHang, then fade)
    const effTarget = (this._revUntil || this._holdRpm != null) ? 1 : accelLoad;
    const prevEff = this._effort;
    const hang = Math.max(0.35, this._revHang || 0.2) * 2.5; // seconds-ish hold scale
    if (effTarget > prevEff) {
      this._effort = damp(prevEff, effTarget, 14, dt);
      this._effortHold = hang;
    } else {
      this._effortHold = (this._effortHold || 0) - dt;
      this._effort = this._effortHold > 0 ? prevEff : damp(prevEff, effTarget, 2.5, dt);
    }

    // Worklet load follows effort (rev-hang keeps load up after lift)
    // During Launch Rev: trust scripted loadBus (do not re-boost with effort lag)
    const launchActive = !!(this._revUntil && performance.now() < this._revUntil);
    let loadOut = load;
    if (this._holdRpm == null && !launchActive) {
      loadOut = clamp(Math.max(load, this._effort * 0.9), 0, 1);
      if (this._driveState === 'overrun') loadOut = clamp(loadOut * 0.55 + 0.05, 0, 1);
    }

    if (this.node) {
      const t = ac.currentTime;
      // Launch: snappier rpm/load so multi-bus sub re-locks and pulse torque-cut is heard
      const rpmTau = launchActive ? 0.012 : 0.03;
      const loadTau = launchActive ? 0.018 : 0.05;
      this.node.parameters.get('rpm').setTargetAtTime(rpmOut, t, rpmTau);
      this.node.parameters.get('load').setTargetAtTime(loadOut, t, loadTau);
      // v3 Global Transmission — snap gear on shift / launch edges
      const gearParam = this.node.parameters.get('gear');
      if (gearParam) {
        const g = this._gear || 1;
        if (launchActive && this._revGearSnap) {
          gearParam.setValueAtTime(g, t);
        } else {
          gearParam.setTargetAtTime(g, t, launchActive ? 0.01 : 0.02);
        }
      }
    }

    const dLoad = loadOut - this._prevLoad;
    this._prevLoad = loadOut;
    // Normal tip-in from load delta; Launch Rev overlays scripted bus cues
    let tipTarget = clamp(dLoad * 8, 0, 1);
    let overTarget = clamp(-dLoad * 6, 0, 1) * (this._driveState === 'overrun' ? 1 : 0.55);
    // Lift-off engine-braking: keep a trailing overrun burble after the pedal is released,
    // and add a re-punch tip-in on the post-upshift catch — the two "feel" moments on GPS.
    if (this._liftHold > 0) {
      this._liftHold -= dt;
      overTarget = Math.max(overTarget, 0.32 + decelLoad * 0.4);
    }
    if (this._postShift > 0) tipTarget = Math.max(tipTarget, 0.35 * (this._postShift / 0.14));
    // Sustained hard pull → steady bite (not only on the load-delta edge) = revving feel.
    if (this._driveState === 'pull' && accelLoad > 0.5) {
      tipTarget = Math.max(tipTarget, 0.18 + (accelLoad - 0.5) * 0.4);
    }
    if (launchActive) {
      tipTarget = Math.max(tipTarget, this._revTipIn || 0);
      overTarget = Math.max(overTarget, this._revOverrun || 0);
    }
    this._tipIn = damp(this._tipIn, tipTarget, launchActive ? 18 : 14, dt);
    this._overrun = damp(this._overrun, overTarget, launchActive ? 12 : 10, dt);
    this._load = loadOut;

    // Gear tone bias → cabin boom only (texture/noise bus is zeroed in v3 worklet)
    const gBias = this._gearBias || gearToneBias(this._gear);
    // Transmission scale: launch script wins; else shift mute + gear aggression
    let txScale = clamp(
      (this._shifting ? 0.55 : 1) * (0.92 + (gBias.aggression || 1) * 0.08),
      0.2,
      1.25
    );
    if (launchActive && this._revTxScale != null) {
      txScale = clamp(this._revTxScale, 0.2, 1.25);
    }
    if (this.node) {
      this.node.port.postMessage({
        tipIn: this._tipIn,
        overrun: this._overrun,
        txScale,
        textureGain: 0,
      });
    }

    // Cabin boom / body vs load + gear body bias
    if (this._nodes?.boom) {
      const baseBoom = this._cabin.boomGain ?? 5.5;
      const swell = (this._synth.loadBoom ?? 0.7) * loadOut;
      this._nodes.boom.gain.setTargetAtTime(
        baseBoom * (0.55 + 0.7 * swell + 0.25 * this._tipIn) * (0.9 + gBias.body * 0.12),
        ac.currentTime,
        0.06
      );
    }

    // --- DynamicVolume (shared with Classic): soft ceiling + per-gear + idle floor ---
    const drpm = this._rpm - this._prevRpm; this._prevRpm = this._rpm;
    this._accelEnv += (clamp(drpm / 40, 0, 1) - this._accelEnv) * 0.15;
    const curveMul = this._sampleCurve(this._rpm);
    // Fold accel envelope into effort-like term for energy (pull swell)
    const effortEff = clamp(
      (this._effort ?? 0) + this._accelEnv * (d.accelBoost ?? 0.35) * 0.35,
      0,
      1
    );
    const dyn = computeDynamicVolume({
      effort: effortEff,
      rpmNorm,
      accelLoad,
      decelLoad,
      speed,
      idlePresence: this._idlePresence ?? 0.75,
      gear: this._gear || 1,
      gearCount: GEAR_COUNT,
      shifting: !!this._shifting,
      overrun: this._driveState === 'overrun',
      dynDb: d.dynDb != null ? d.dynDb : 20,
      curveMul,
      loadBoost: d.loadBoost ?? 0.5,
      load: loadOut,
      softCeiling: d.dynCeiling != null ? d.dynCeiling : 0.88,
      floorBias: 1.0,
    });
    if (this._nodes) {
      this._nodes.dyn.gain.setTargetAtTime(dyn.dynVol, ac.currentTime, 0.07);
    }
    this._dynVol = dyn.dynVol;
    this._driveEnergy = dyn.driveEnergy;
    this._gearDynScale = dyn.gearScale;
  }

  setSpeed(kmh, extras = {}) {
    this._speed = Math.max(0, kmh);
    if (extras.accelKmhps != null) this._accel = extras.accelKmhps;
    if (extras.throttle != null) this._throttle = clamp(extras.throttle, 0, 1);
    if (extras.brake != null) this._brake = clamp(extras.brake, 0, 1);
  }
  setThrottle(v) { if (v != null) this._throttle = clamp(v, 0, 1); }
  setAccel(k) { this._accel = k; }
  /** Eval A/B: pin RPM (null to release). Classic parity. */
  setHoldRpm(rpm) { this._holdRpm = rpm == null ? null : Math.max(0, rpm); }

  /**
   * Soft mechanical shift tick (same idea as AudioEngine._fireShiftClick).
   * Routed to master so cabin EQ doesn't turn it into a harsh pop.
   * @param {boolean} down  true = downshift (lower pitch)
   */
  _fireShiftClick(down = false) {
    if (!this.ctx || !this.running || !this._nodes?.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = down ? 150 : 230;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.028, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.045);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = down ? 480 : 680;
    osc.connect(f);
    f.connect(g);
    g.connect(this._nodes.master);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  /** APP SYSTEM — global, not part of the car sound profile. */
  setMasterVolume(v) {
    this._masterOverride = clamp(v, 0, 1.2);
    if (!this._nodes || !this.ctx) return;
    const t = this.ctx.currentTime;
    this._nodes.master.gain.setTargetAtTime(this._masterOverride, t, 0.03);
    // Perception: quieter master → relatively more low-shelf (Fletcher-Munson-ish)
    if (this._nodes.perc) {
      const tilt = (this._synth.perceptionTilt ?? 0.35) * (1.15 - this._masterOverride) * 6;
      this._nodes.perc.gain.setTargetAtTime(clamp(tilt, 0, 5), t, 0.08);
    }
  }

  /** SOUND PROFILE (cabin) — bass body / cabin boom / sub feel. */
  setBass(v) {
    if (!this._nodes) return;
    const t = this.ctx.currentTime;
    this._nodes.low.gain.setTargetAtTime(-0.5 + v * 8, t, 0.05);
    this._nodes.boom.gain.setTargetAtTime((this._cabin.boomGain ?? 5.5) * (0.45 + v * 1.15), t, 0.05);
    if (this._nodes.sub) {
      const baseSub = this._cabin.subGain != null ? this._cabin.subGain : 3.5;
      this._nodes.sub.gain.setTargetAtTime(baseSub * (0.35 + v * 1.2), t, 0.05);
    }
  }

  /** SOUND PROFILE (cabin) — edge = residual rasp (kept dark; full open still ≤ classic redline). */
  setEdge(v) {
    if (!this._nodes) return;
    const t = this.ctx.currentTime;
    // v=0 → very dark; v=1 → only modest brightness (not 9 kHz rasp)
    this._nodes.high.gain.setTargetAtTime(-10 + v * 7, t, 0.05);
    this._nodes.mid.gain.setTargetAtTime((this._cabin.midScoopGain ?? -5.5) + v * 2.0, t, 0.05);
    const base = this._cabin.lpf ?? 2600;
    this._nodes.lpf.frequency.setTargetAtTime(base * (0.7 + v * 0.45), t, 0.08);
    this._nodes.lpf2.frequency.setTargetAtTime(base * 1.1 * (0.7 + v * 0.45), t, 0.08);
    if (this.node) {
      const tg = (this._synth.textureGain ?? 0.42) * (0.4 + v * 0.55);
      this.node.port.postMessage({ textureGain: clamp(tg, 0.12, 0.85) });
    }
  }

  /**
   * Launch Rev — scripted G1→G2→G3 pulls while parked (same as TAS main).
   * Shared with Vessel Lab via js/launch-rev.js.
   * @returns {boolean}
   */
  startRevTest(seconds = 5) {
    if (!this.running) return false;
    this._revDuration = clamp(seconds, 2, 10);
    this._revScript = buildRevScript(this._revDuration, false);
    this._revUntil = performance.now() + this._revDuration * 1000;
    // seed at launch landing so first frame isn't stuck at idle
    const idle = this._veh.idle ?? 800;
    const redline = this._veh.redline ?? 7000;
    const span = Math.max(500, redline - idle);
    const n0 = this._revScript[0]?.from ?? 0.16;
    this._rpm = idle + span * n0;
    this._gear = 1;
    this._prevGear = 1;
    this._driveState = 'pull';
    this._shifting = false;
    this._effort = 1;
    this._effortHold = 1.2;
    this._prevLoad = 0;           // first load=1 → tip-in edge for multi-bus
    this._tipIn = 0.85;           // launch punch into sub/pulse buses
    this._overrun = 0;
    this._revTipIn = 0.85;
    this._revOverrun = 0;
    this._revTxScale = 1.12;
    this._revGearSnap = true;
    // Snap worklet params immediately (v3 gear / load / tipIn)
    if (this.node && this.ctx) {
      const t = this.ctx.currentTime;
      this.node.parameters.get('rpm').setValueAtTime(this._rpm, t);
      this.node.parameters.get('load').setValueAtTime(0.95, t);
      const gearParam = this.node.parameters.get('gear');
      if (gearParam) gearParam.setValueAtTime(1, t);
      this.node.port.postMessage({
        tipIn: 0.85,
        overrun: 0,
        txScale: 1.12,
        textureGain: 0,
      });
    }
    return true;
  }

  get revActive() {
    return !!this._revUntil && performance.now() < this._revUntil;
  }

  /**
   * Live feature toggles for Lab / CommandRoom preview (no rebuild).
   * @param {{ waveguide?: boolean, waveguideGain?: number, hybridStability?: boolean, organicV2?: boolean, globalMaxLpf?: number }} flags
   */
  setSynthFlags(flags = {}) {
    if (!flags || typeof flags !== 'object') return;
    if (flags.waveguide != null) this._synth.waveguide = !!flags.waveguide;
    if (flags.waveguideGain != null) this._synth.waveguideGain = +flags.waveguideGain;
    if (flags.hybridStability != null) this._synth.hybridStability = !!flags.hybridStability;
    if (flags.antiStatic != null) this._synth.antiStatic = !!flags.antiStatic;
    if (flags.organicV2 != null) this._synth.organicV2 = !!flags.organicV2;
    if (flags.globalMaxLpf != null) this._synth.globalMaxLpf = +flags.globalMaxLpf;
    if (!this.node) return;
    const msg = {};
    if (flags.waveguide != null) msg.waveguide = !!flags.waveguide;
    if (flags.waveguideGain != null) msg.waveguideGain = +flags.waveguideGain;
    if (flags.hybridStability != null) msg.hybridStability = !!flags.hybridStability;
    if (flags.antiStatic != null) msg.antiStatic = !!flags.antiStatic;
    if (flags.organicV2 != null) msg.organicV2 = !!flags.organicV2;
    if (flags.globalMaxLpf != null) msg.globalMaxLpf = +flags.globalMaxLpf;
    if (flags.waveguide === true) msg.resetWaveguide = true;
    this.node.port.postMessage(msg);
  }

  /** Current synthesis flags (for Lab UI). */
  getSynthFlags() {
    return {
      waveguide: this._synth.waveguide === true,
      waveguideGain: this._synth.waveguideGain != null ? this._synth.waveguideGain : 0.28,
      hybridStability: this._synth.hybridStability !== false,
      antiStatic: this._synth.antiStatic !== false,
      organicV2: this._synth.organicV2 !== false,
      globalMaxLpf: this._synth.globalMaxLpf != null ? this._synth.globalMaxLpf : 1800,
    };
  }

  get rpm() { return this._rpm; }
  get gearIndex() { return this._gear; }
  get gearCount() { return GEAR_COUNT; }
  get driveState() { return this._driveState; }
}
