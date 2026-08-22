/**
 * CRANK — third TAS sound engine (alongside Classic AudioEngine and VESSEL).
 *
 * WHAT IT IS
 *   A firing-order synthesiser. Every cylinder's pressure pulse is laid on a
 *   720-degree crank table and Fourier-transformed into one PeriodicWave, so a
 *   single oscillator carries the *whole* combustion spectrum with the firing
 *   order already sitting where physics puts it. Around it: two tailpipe
 *   resonances, a pipe-length delay, an intake runner, mechanical clatter, and
 *   an induction voice (turbo spool / VTEC crossover).
 *
 *   Ported 1:1 from the CRANK prototype the owner approved
 *   (soundforpreemak.grok.me) — the voice is the prototype's, unchanged.
 *
 * WHAT CHANGED FOR THE CAR
 *   The prototype revved off a pedal and integrated its own RPM. In TAS the RPM
 *   comes from the road: GPS speed + acceleration -> virtual gearbox (gearbox.js)
 *   -> RPM, exactly like the other two engines. Everything downstream of RPM is
 *   the prototype's.
 *
 * COST (this is why it can ship — see the owner's "no lag / no spike" rule)
 *   - The 384-harmonic DFT runs OFFLINE in vessel/tools/build-crank.mjs. The app
 *     only reads finished coefficients and calls createPeriodicWave().
 *   - Fixed node graph, built once at start(): ~10 oscillators, 4 looping noise
 *     buffers, ~20 filters. All native nodes, no AudioWorklet, no ScriptProcessor.
 *   - Zero allocation per tick. Every parameter move is setTargetAtTime on a
 *     pre-built node; even the overrun pops are an envelope on a permanent
 *     noise bed rather than freshly created nodes.
 *   - One 20 ms interval (33 ms on the lite perf tier), never rAF, so audio
 *     stays smooth when Tesla Browser drops frames.
 *
 * LAW notes: tune lives in assets/crank/*.crank.json (LAW 1) — this file only
 * plays what the JSON says (LAW 2). Files added here must be in the deploy ship
 * list and sw.js precache (LAW 5).
 */

import { clamp, damp } from './animations.js';
import {
  GEAR_COUNT,
  resolveGear,
  rpmInGear,
  rpmInGearManual,
  isManual,
  gearProgress,
  gearToneBias,
  shiftLandingRpm,
} from './gearbox.js';
import { computeDynamicVolume, computeManualVolume } from './dynamic-volume.js';
import { buildRevScript, stepRevScript } from './launch-rev.js';
import { CRANK_RIGS } from './crank-rigs.js';

export { hasCrank, listCrankRigs } from './crank-rigs.js';

/** Same asset-base rewrite the VESSEL engine uses (Lab serves from a subpath). */
function tasUrl(rel) {
  if (typeof window !== 'undefined' && window.__TAS_ASSET_BASE__) {
    try {
      return new URL(String(rel).replace(/^\//, ''), window.__TAS_ASSET_BASE__).href;
    } catch (_) { /* fall through */ }
  }
  return rel;
}

/** Speed by which a launch is over and the gear floor applies in full. */
const LAUNCH_KMH = 12;

/** Loudness recovered from crest factor. See the comment at the graph. */
const DEFAULT_DENSITY = {
  // Swept on the bench. Firmer settings bought another dB and cost a gain
  // reduction of -6 with clipping up at 3.2%; these sit at -3.5 dB mean and
  // leave cruise completely untouched (0.00 reduction), so the dynamic range
  // the owner says is right now is not squeezed.
  thresholdDb: -14, kneeDb: 8, ratio: 2.5,
  attackSec: 0.012, releaseSec: 0.3, makeup: 1.3,
};

const DEFAULT_MIXER = { exhaust: 0.92, intake: 0.58, mechanical: 0.34, induction: 0.46, master: 0.72 };

/**
 * CRANK type defaults — the floor every profile stands on.
 *
 * The compiler derives these per engine and writes them into the .crank.json
 * (see vessel/tools/build-crank.mjs). What is here is the safety net: a profile
 * that predates a field, or was hand-edited, still gets the behaviour rather
 * than silently losing it. Nothing in this engine may depend on a JSON having
 * remembered to include something.
 *
 * glide/rise/fall exist because CRANK is one oscillator — rpm IS pitch — and
 * both the virtual gearbox (snaps rpm at a shift) and sim mode (full demand in
 * one frame) hand it step changes that must be walked, not jumped.
 */
const DEFAULT_DRIVE = {
  revLo: 0.17, revHi: 0.55, revPull: 0.9, floorLo: 1300, floorHi: 1800,
  cruiseLoad: 0.5, wanderRpm: 52, wanderLope: 178,
  limiterHz: 13, limiterDropTo: 0.93, blipFallMul: 5.7,

  glideSec: 0.03, shiftGlideSec: 0.09, glideHoldSec: 0.2,
  riseRpmPerSec: 8000, fallRpmPerSec: 10000,
  maxRiseStPerSec: 46, maxFallStPerSec: 24, accelRef: 60, accelCurve: 0.65,
  // A gear change legitimately drops the revs far faster than a lift does, so
  // it gets its own ceiling instead of teleporting past every ceiling. A real
  // upshift sheds roughly 2500 rpm in a quarter second, which around 4000 rpm
  // is about 48 st/s; 60 keeps the drop crisp without becoming a step again.
  shiftFallStPerSec: 60, shiftLandSec: 0.3,
  // How long the voice takes to come UP when load appears — his words, the
  // difference between pressing play with the music already at full volume and
  // letting it arrive over a moment. A rate limit on the way up only; the way
  // down is untouched, because a lift has to drop when the driver lifts.
  //
  // load used to step: 0.238 to 0.777 in a single tick, measured. The engine
  // already had a gradual envelope in _effort, but load never read it, so the
  // smoothing was wired to a different wire — which is why rate-limiting
  // _effort changed the onset by 1 ms.
  loadAttackSec: 0.3,
  // Multiplies the accel input filter. 0.12 takes lambda 18 to 2.2, a time
  // constant of 56 ms to 463 ms. Swept against the two things that compete:
  //
  //     tau      1 Hz scatter      level response   rpm response
  //      56 ms      6.43 dB            128 ms          139 ms
  //     278         4.93              130             139
  //     463         4.34              130             139
  //     694         4.48              122             139
  //
  // 2.1 dB of judder for nothing measurable. Response is flat because the
  // throttle term of accelLoad does not pass through this filter at all — only
  // the accel-derived half does — so slowing it cannot slow the arrival. Past
  // 463 ms it stops improving.
  accelSmoothMul: 0.12,
};
/**
 * Cabin staging. These are the classic engine's own numbers — the brief was to
 * sound placed like classic, so nothing here is "improved".
 */
const DEFAULT_SPACE = {
  crossoverHz: 420, rearDelaySec: 0.024, rearZ: 2.4, rearGain: 1.45,
  frontGain: 0.9, reverbSec: 0.3, reverbDecay: 3.2, reverbWet: 0.22, frontSend: 0.45,
};

/**
 * BODY LAYER — off by default, and jz-crank never turns it on.
 *
 * The owner's report: CRANK sounds like it comes from the front console while
 * classic fills the whole car. Measured at cruise, both at the same setting:
 *
 *     band        classic   jz-crank
 *     60-120 Hz    -10.5      -44.3     <- classic's loudest band, and CRANK's
 *     120-250      -22.0      -16.8        emptiest. 34 dB apart.
 *     500-1k       -39.2      -31.7
 *
 * Below ~120 Hz the ear cannot place a source, so that band is felt rather than
 * located — it is the whole-car half of the sound. CRANK puts its energy an
 * octave up, where localisation is sharp, and lands on the dashboard.
 *
 * It is NOT a stereo problem: measured side energy is -21.6 dB on CRANK against
 * -28 dB on classic, so CRANK is already the wider of the two. And it is not
 * the cabin staging, which is classic's own and sends everything under 420 Hz
 * to the rear HRTF with 1.45x gain. The band simply is not generated. classic
 * has a dedicated sub oscillator for exactly this (audio-engine.js: "let the
 * CLEAN sub oscillator carry the body"); CRANK has one wavetable and no body.
 *
 * So this ports that one layer rather than running a second engine beside the
 * first — one sine and one gain against a whole extra graph and tick on an MCU
 * that is already the tightest constraint here. The laws below are classic's,
 * copied not reinvented.
 */
const DEFAULT_SUB = {
  mix: 0,          // 0 disables it entirely; the oscillator is never started
  // WHICH partial to lay down, in 720-degree table harmonics (n * rpm/120).
  //
  // 0 means an octave below the firing order — n = cylinders/2 — and the route
  // to that number is worth keeping, because two wrong answers came first.
  //
  // Porting classic's law verbatim put it at 43 Hz. Chasing classic's loud
  // 60-120 Hz band instead put it on the firing order, and that measured as
  // landing in 120-250: at 112 km/h jz turns fast enough that its fundamental
  // is near 140 Hz. Which is the whole finding. At the same road speed CRANK's
  // fundamental sits most of an octave above classic's, straddling the ~120 Hz
  // line where the ear starts placing a source — so classic is felt and CRANK
  // is pointed at. Reinforcing the fundamental only makes the pointing louder.
  //
  // An octave below lands near 70 Hz at that same cruise, under the line, and
  // it is consonant with the fundamental rather than beating against it. That
  // is also the relationship classic's own sub uses. Any other value names a
  // partial directly.
  order: 0,
  floorHz: 18,     // added on top: an idling six would otherwise sit near 19 Hz
  base: 0.06,      // classic's constant term
  lowRpm: 0.06,    // more body low down, backing off as the revs climb
  throttle: 0.04,  // and more when it is being asked for something
};

const DEFAULT_DYN = {
  dynDb: 16, dynCeiling: 0.5, shiftDuck: 0.9, overrunDuck: 0.9,
  idlePresence: 0.55, loadBoost: 0.22, floorBias: 0.7,
};

/** VVT latch — used if a vtec profile ships without a cam block. */
const DEFAULT_CAM = { onAt: 0.62, offAt: 0.34, dwellSec: 0.28 };

/** Generic small-turbo curve — used only if a turbo profile ships without one. */
const DEFAULT_BOOST = {
  onsetRpm: 1900, fullRpm: 3900, peakBar: 0.7, taperRpm: 6300, taperTo: 0.88,
  crossRpm: 2900, spoolSec: 0.36, spoolFastSec: 0.18, bleedSec: 0.16,
  loadLo: 0.08, loadHi: 0.55, offGain: 0.62, intakeGain: 0.45,
};

/** d(semitones)/dt = ST x (drpm/dt) / rpm — converts a rev rate into a pitch rate. */
const ST = 12 / Math.LN2;

/** km/h/s. Below this the acceleration reading is scatter (classic parity). */
const ACCEL_DEADBAND = 1.5;

/** Crank-cycle frequency: one full 720-degree cycle per revolution pair. */
const cycleHz = (rpm) => rpm / 120;
/** Perceptual square-law for mixer faders (prototype parity). */
const sq = (x) => x * x;
/** setTargetAtTime with a clamped floor — the prototype's `Q` helper. */
function at(param, value, t, tau = 0.03) {
  param.setTargetAtTime(Math.max(0, value), t, tau);
}

/** Hermite ease between two rpm points — used for the boost threshold. */
function smoothstep(a, b, x) {
  const t = clamp((x - a) / Math.max(1, b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Boost available at this rpm, 0..1 of the engine's peak bar.
 *
 * Not a ramp and not a step. A real turbo has a THRESHOLD (below it the
 * turbine has no energy at all), a steep swell to the wastegate limit, then a
 * plateau — and, on small turbos, a taper at the top when the compressor runs
 * out of flow. All four rpm points come from the profile JSON.
 */
function boostAtRpm(rpm, b, redline) {
  let n = smoothstep(b.onsetRpm, b.fullRpm, rpm);
  if (rpm > b.taperRpm) {
    const over = clamp((rpm - b.taperRpm) / Math.max(1, redline - b.taperRpm), 0, 1);
    n *= 1 - (1 - b.taperTo) * over;
  }
  return n;
}

/** Torque curve — idle floor, climb to peak, gentle fall to redline. */
function torqueFactor(rpm, s) {
  const { idleRpm: idle, peakTorqueRpm: peak, redlineRpm: red } = s;
  if (rpm <= idle) return 0.42;
  if (rpm < peak) return 0.42 + 0.58 * (1 - (1 - (rpm - idle) / Math.max(1, peak - idle)) ** 1.4);
  const over = (rpm - peak) / Math.max(1, red - peak);
  return 1 - 0.38 * over * over;
}

/**
 * Two decorrelated exponentially-decaying noise tails = a small-cabin IR.
 * Copied from the classic engine, including the darkening low-pass on the tail.
 */
function cabinIR(ctx, seconds, decay) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      lp += 0.22 * (white - lp);
      d[i] = lp * Math.pow(1 - i / n, decay);
    }
  }
  return buf;
}

/**
 * Brick-wall ceiling curve. Linear to `knee`, then a tanh that can never exceed
 * `ceil`. Last thing in the chain: a DynamicsCompressor has no lookahead and
 * lets fast transients overshoot — measured +0.5 dBFS before this existed.
 */
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

/** tanh drive curve for the exhaust waveshaper ("rasp"). */
function raspCurve(amount) {
  const curve = new Float32Array(256);
  const k = 0.4 + amount * 4.5;
  const norm = Math.tanh(k);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** White / pink / brown noise beds. Built once at start(), then looped forever. */
function noiseBuffer(ctx, seconds, kind) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, brown = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else if (kind === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      d[i] = (b0 + b1 + b2 + w * 0.3) * 0.22;
    } else {
      brown = brown * 0.985 + w * 0.015;
      d[i] = brown * 3.2;
    }
  }
  return buf;
}

export class CrankAudio {
  constructor() {
    this.ctx = null;
    this.running = false;
    /** Drive-feel switches, matched to Classic/VESSEL so all three feel alike. */
    this.speedReactive = true;
    this.smoothFilter = true;
    this.accelRefKmhps = 26;

    this._profileId = 'jz-crank';
    this._profile = null;
    this._rigUrl = CRANK_RIGS['jz-crank'];
    this._rigCache = {};
    this._doc = null;
    this._spec = null;
    this._mixer = { ...DEFAULT_MIXER };
    this._drive = { ...DEFAULT_DRIVE };
    this._dyn = { ...DEFAULT_DYN };
    this._density = { ...DEFAULT_DENSITY };
    this._boostSpec = null;

    // Vehicle input
    this._speed = 0; this._speedSmooth = 0;
    this._accel = 0; this._accelSmooth = 0;
    this._throttle = 0; this._brake = 0;

    // Engine state
    this._rpm = 800;
    this._idleLatch = true;
    this._gear = 1;
    this._prevGear = 1;
    this._gearBias = gearToneBias(1);
    this._driveState = 'idle';
    this._load = 0;
    this._prevLoad = 0;
    this._boost = 0;
    this._vtec = 0;
    this._sharpCam = false;
    this._camPending = null;   // cam change waiting for its duck (see _tick)
    this._camHold = 0;         // min seconds between cam changes (VVT latch)
    this._camSpec = null;
    this._limiter = false;
    this._jitter = 0;
    this._effort = 0;
    this._effortHold = 0;
    this._idlePhase = 0;
    this._breathePhase = 0;
    this._limPhase = 0;
    this._onLimiter = false;
    this._rpmDisplay = null;
    this._paramTick = 0;
    this._lastParam = new WeakMap();
    this._holdRpm = null;

    // Shift / crank phases
    this._shifting = false;
    this._shiftTimer = 0;
    this._shiftLand = null;   // rpm the change is heading for
    this._shiftLandT = 0;     // how long that target still applies
    this._shiftUp = false;
    this._sinceShift = 0;
    this._postShift = 0;
    this._crankUntil = 0;      // starter phase end (audio clock)
    this._popCooldown = 0;
    this._overrunLatch = false;   // hysteresis, so cruise<->overrun cannot flutter
    this._glideHold = 0;       // seconds left of the slow pitch glide after a shift

    // Launch Rev
    this._revUntil = 0;
    this._revDuration = 5;
    this._revScript = null;

    // UI overrides (App System)
    this._masterOverride = null;
    this._masterScale = 0.88;
    this._outputTrim = 1;
    this._makeup = 1;
    this._space = { ...DEFAULT_SPACE };
    this._sub = { ...DEFAULT_SUB };
    this._subStarted = false;
    this._bass = 0.5;
    this._edge = 0.5;

    this._nodes = null;
    this._voices = null;
    this._active = 'a';
    this._waves = null;
    this._vtecWaves = null;
    this._timer = null;
    this._lite = false;
    this._tickJitterMs = 0;
    this._tickWorstMs = 0;
    this._tickStalls = 0;
    this._swapToken = 0;
  }

  /* ------------------------------------------------------------ profile -- */

  setProfile(profile) {
    const id = profile && profile.id;
    this._profile = profile || null;
    if (id) this._profileId = id;
    if (id && CRANK_RIGS[id]) this._rigUrl = CRANK_RIGS[id];
    if (this.running) this._swapProfile();
  }

  getTuneLayers() {
    return {
      engine: 'CRANK spec -> .crank.json (firing order + resonances)',
      cabin: 'Bass / Edge shelves (this card)',
      vehicle: 'Virtual gearbox (this card)',
      app: 'App system (global)',
    };
  }

  async _loadDoc(url) {
    const full = tasUrl(url);
    if (this._rigCache[full]) return this._rigCache[full];
    // 'reload' (VESSEL rig parity): the in-memory _rigCache already stops repeat
    // fetches inside a session, so the only thing an HTTP cache would buy us is
    // serving a STALE profile after a deploy. Offline is covered by sw.js, which
    // precaches these and falls back to cache when the network is dead.
    const res = await fetch(full, { cache: 'reload' });
    if (!res.ok) throw new Error(`CRANK profile ${full} -> HTTP ${res.status}`);
    const doc = await res.json();
    this._rigCache[full] = doc;
    return doc;
  }

  /** Apply a loaded .crank.json: spec, mixer, drive window, dynamics. */
  _applyDoc(doc) {
    this._doc = doc;
    this._spec = doc.spec;
    this._mixer = { ...DEFAULT_MIXER, ...(doc.mixer || {}) };
    this._drive = { ...DEFAULT_DRIVE, ...(doc.drive || {}) };
    this._dyn = { ...DEFAULT_DYN, ...(doc.dynamics || {}) };
    this._density = { ...DEFAULT_DENSITY, ...(doc.density || {}) };
    this._masterScale = doc.masterScale ?? 0.88;
    this._outputTrim = doc.outputTrim ?? 1;
    this._makeup = doc.makeup ?? 1;
    this._space = { ...DEFAULT_SPACE, ...(doc.space || {}) };
    // Profile beats rig: two cards share one compiled table and differ only by
    // how much body they ask for.
    this._subStarted = false;
    this._sub = {
      ...DEFAULT_SUB,
      ...(doc.sub || {}),
      ...((this._profile && this._profile.crankSub) || {}),
    };
    // Every forced-induction CRANK profile gets a boost curve, compiled or not.
    if (doc.boost) {
      this._boostSpec = doc.boost;
    } else if (this._spec.induction === 'turbo') {
      console.warn(`[crank] ${doc.id} has no boost block — using type default. Recompile with vessel/tools/build-crank.mjs.`);
      this._boostSpec = { ...DEFAULT_BOOST };
    } else {
      this._boostSpec = null;
    }
    this._camSpec = this._spec.induction === 'vtec'
      ? { ...DEFAULT_CAM, ...(doc.cam || {}) }
      : null;
    // A profile card may override the rev window without recompiling the JSON
    const e = this._profile && this._profile.engine;
    if (e) {
      if (e.revLo != null) this._drive.revLo = e.revLo;
      if (e.revHi != null) this._drive.revHi = e.revHi;
      if (e.revPull != null) this._drive.revPull = e.revPull;
    }
  }

  /** JSON coefficient arrays -> PeriodicWave triple (left / right / mono). */
  _makeWaveSet(packed) {
    if (!packed) return null;
    const one = (w) =>
      this.ctx.createPeriodicWave(Float32Array.from(w.real), Float32Array.from(w.imag), {
        disableNormalization: false,
      });
    return { left: one(packed.left), right: one(packed.right), mono: one(packed.mono) };
  }

  /**
   * Crossfade to the newly selected profile on the idle voice, then swap.
   * Same trick as the prototype: two identical voices, only one audible.
   */
  async _swapProfile() {
    // Flicking through the carousel fires overlapping swaps; only the newest one
    // is allowed to touch the voices, or the A/B pointer ends up on a muted voice.
    const token = ++this._swapToken;
    const url = this._rigUrl;
    let doc;
    try {
      doc = await this._loadDoc(url);
    } catch (err) {
      console.warn('[crank] profile load failed, keeping current voice', err);
      return;
    }
    if (!this.running || !this.ctx || token !== this._swapToken) return;
    this._applyDoc(doc);
    this._waves = this._makeWaveSet(doc.waves.base);
    this._vtecWaves = doc.waves.vtec ? this._makeWaveSet(doc.waves.vtec) : null;
    this._sharpCam = false;
    // The new card may carry a different output trim, and the graph already
    // exists, so re-apply it here rather than only at build time.
    this.setBass(this._bass);   // re-applies trim with the bass compensation

    const nextKey = this._active === 'a' ? 'b' : 'a';
    const cur = this._voices[this._active];
    const next = this._voices[nextKey];
    this._applyWaves(next, this._waves);
    next.shape.curve = raspCurve(this._spec.rasp);
    const t = this.ctx.currentTime;
    at(cur.voiceGain.gain, 0, t, 0.06);
    at(next.voiceGain.gain, 1, t, 0.06);
    this._active = nextKey;
    if (this._rpm > this._spec.redlineRpm) this._rpm = this._spec.redlineRpm * 0.92;
  }

  /* --------------------------------------------------------- lifecycle -- */

  /**
   * @param {object} [opts]
   * @param {BaseAudioContext} [opts.ctx]  render into this instead of opening a
   *   live output. An OfflineAudioContext here renders the REAL graph faster
   *   than real time, with no rAF, no tab-visibility freeze and no timer
   *   jitter -- which is how vessel/tools/offline-bench.js measures an audio
   *   change before it can ever reach the car. Nothing about the graph changes.
   * @param {boolean} [opts.manualTick]  do not start the interval; the caller
   *   drives _tick(dt) itself. Required with an offline ctx, where wall-clock
   *   time and render time are unrelated.
   */
  async start(opts = {}) {
    if (this.running) return;
    let perf = 'auto';
    try {
      const m = await import('./profiles.js');
      perf = (m.getGlobalControl?.() || {}).perf || 'auto';
    } catch (_) { /* profiles.js may not expose control — auto is fine */ }
    this._lite = this._resolveLite(perf);

    const doc = await this._loadDoc(this._rigUrl);
    if (opts.ctx) {
      this.ctx = opts.ctx;
      this._borrowedCtx = true;
    } else {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new AC({ latencyHint: this._lite ? 'playback' : 'interactive' }); }
      catch (_) { this.ctx = new AC(); }
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (_) {} }
    }

    this._applyDoc(doc);
    this._waves = this._makeWaveSet(doc.waves.base);
    this._vtecWaves = doc.waves.vtec ? this._makeWaveSet(doc.waves.vtec) : null;
    this._buildGraph();

    this._rpm = this._spec.idleRpm;
    this._gear = 1;
    this._driveState = 'idle';
    // Short starter crank, then the engine catches — the prototype's ignition.
    this._crankUntil = this.ctx.currentTime + 0.7;
    at(this._nodes.starterGain.gain, 0.42, this.ctx.currentTime, 0.04);

    this.running = true;
    const tickMs = this._lite ? 33 : 20;
    this.tickMs = tickMs;
    if (opts.manualTick) return;
    // Measured wall-clock dt, like the classic engine. A fixed nominal dt makes
    // every damp() integrate the wrong amount whenever the timer slips, which on
    // a busy MCU is often — the filters then run faster or slower than tuned.
    this._lastTickWall = performance.now();
    this._timer = setInterval(() => {
      const now = performance.now();
      let dt = (now - this._lastTickWall) / 1000;
      this._lastTickWall = now;
      // Rolling mean |interval - nominal|, for the Dev perf readout. If this
      // grows on a device, the main thread is starving the parameter updates.
      this._tickJitterMs = this._tickJitterMs * 0.9 + Math.abs(dt * 1000 - tickMs) * 0.1;
      // The mean above hides exactly what matters. One 150 ms stall barely
      // moves a 0.9/0.1 rolling average, and one 150 ms stall is a lurch: dt
      // passes through unclamped up to 250 ms, so damp() integrates as much as
      // 7.5 ticks' worth in a single step. On a single-oscillator engine that
      // lands straight in the pitch. Keep the worst and a count instead.
      const ms = dt * 1000;
      if (ms > this._tickWorstMs) this._tickWorstMs = ms;
      if (ms > tickMs * 2) this._tickStalls++;
      if (!(dt > 0) || dt > 0.25) dt = tickMs / 1000;
      this._tick(dt);
    }, tickMs);
  }

  stop() {
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    // A borrowed context belongs to whoever lent it; closing it here would kill
    // a render still in flight.
    if (this.ctx && !this._borrowedCtx) { try { this.ctx.close(); } catch (_) {} }
    this.ctx = null;
    this._borrowedCtx = false;
    this._nodes = null;
    this._voices = null;
  }

  /** perf tier (control.global.perf): auto -> lite on Tesla / weak cores. */
  _resolveLite(perf) {
    if (perf === 'lite') return true;
    if (perf === 'full') return false;
    const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '').toLowerCase();
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 8;
    return ua.includes('tesla') || cores <= 4;
  }

  /* ------------------------------------------------------------- graph -- */

  /**
   * One complete engine voice. Built twice (A/B) so switching cards can
   * crossfade instead of clicking. Every node here is permanent.
   */
  _makeVoice() {
    const ctx = this.ctx;
    const oscL = ctx.createOscillator();
    const oscR = ctx.createOscillator();
    const oscIntake = ctx.createOscillator();
    const oscMech = ctx.createOscillator();
    const oscWhistle = ctx.createOscillator();
    oscMech.type = 'sawtooth';
    oscWhistle.type = 'sine';
    // Both banks play the SAME table into the SAME mono shaper, so a detune here
    // was never stereo width -- it was a tremolo. Ten cents apart makes the
    // firing harmonics beat at 0.6-2.3 Hz, and that is the judder: an offline
    // render of this exact table at 2000 rpm predicts 7.8 dB of level swing,
    // against 7.7 dB measured in the car. It is worst at steady cruise, where
    // the beat stays coherent, and hides while the pitch is sweeping -- which is
    // why it read as "smooth sometimes" and never as an overload. Two identical
    // waves cancel at SOME rate for any detune, so zero is the only stable
    // answer. Real width needs decorrelated tables; waves.right is the hook.
    oscL.detune.value = 0;
    oscR.detune.value = 0;

    // Coherent banks sum to 2.0 peak where the beating pair averaged 1.41 rms.
    // Without this trim the shaper gets driven 3 dB harder and the engine comes
    // back 3 dB louder than the level the owner tuned by driving. 0.707 puts
    // the rms back on top of the old one on paper; an OfflineAudio render through
    // the real rasp curve says 0.645, because the shaper was already clipping the
    // loud half of the beat and the arithmetic cannot see that. It saturates hard
    // enough that the last 0.8 dB of trim only bought 0.2 dB of output, so the
    // patch lands +0.6 dB rather than dead level -- under the threshold anyone
    // re-tunes for, and peak is unchanged, so no new clipping. Chasing the rest
    // would mean backing off the shaper, which is the rasp itself.
    const preShape = ctx.createGain();
    preShape.gain.value = 0.645;

    const shape = ctx.createWaveShaper();
    shape.oversample = '2x';

    const exhaustLp = ctx.createBiquadFilter();
    exhaustLp.type = 'lowpass';
    exhaustLp.Q.value = 0.7;

    const peak1 = ctx.createBiquadFilter();
    peak1.type = 'peaking'; peak1.Q.value = 2.2; peak1.gain.value = 6;

    const peak2 = ctx.createBiquadFilter();
    peak2.type = 'peaking'; peak2.Q.value = 1.6; peak2.gain.value = 4;

    const delay = ctx.createDelay(0.05);           // pipe length reflection
    const delayGain = ctx.createGain(); delayGain.gain.value = 0.2;
    const dry = ctx.createGain(); dry.gain.value = 1;
    const exhaustGain = ctx.createGain(); exhaustGain.gain.value = 0;

    // Same idea on the wavetable side: exhaustGain is rewritten every tick, so
    // a listening trim has to sit after it.
    const exhaustTrim = ctx.createGain();
    const panL = ctx.createStereoPanner();
    const panR = ctx.createStereoPanner();

    const intakeBp = ctx.createBiquadFilter();
    intakeBp.type = 'bandpass'; intakeBp.Q.value = 1.1;
    const intakeGain = ctx.createGain(); intakeGain.gain.value = 0;

    const combBp = ctx.createBiquadFilter();
    combBp.type = 'bandpass'; combBp.Q.value = 0.8;
    const combGain = ctx.createGain(); combGain.gain.value = 0;

    const mechHp = ctx.createBiquadFilter();
    mechHp.type = 'highpass'; mechHp.frequency.value = 1800; mechHp.Q.value = 0.7;
    const mechGain = ctx.createGain(); mechGain.gain.value = 0;

    const turboBp = ctx.createBiquadFilter();
    turboBp.type = 'bandpass'; turboBp.Q.value = 0.7;
    const turboGain = ctx.createGain(); turboGain.gain.value = 0;

    const whistleGain = ctx.createGain(); whistleGain.gain.value = 0;
    const voiceGain = ctx.createGain(); voiceGain.gain.value = 0;
    const sum = ctx.createGain();

    oscL.connect(preShape);
    oscR.connect(preShape);
    preShape.connect(shape);
    shape.connect(dry);
    shape.connect(delay);
    delay.connect(delayGain);
    dry.connect(exhaustLp);
    delayGain.connect(exhaustLp);
    exhaustLp.connect(peak1).connect(peak2).connect(exhaustGain);
    exhaustGain.connect(exhaustTrim);
    exhaustTrim.connect(panL);
    exhaustTrim.connect(panR);
    panL.connect(sum);
    panR.connect(sum);
    oscIntake.connect(intakeBp).connect(intakeGain).connect(sum);
    oscMech.connect(mechHp).connect(mechGain).connect(sum);
    oscWhistle.connect(whistleGain).connect(sum);
    sum.connect(voiceGain);

    return {
      oscL, oscR, oscIntake, oscMech, oscWhistle,
      preShape, shape, exhaustLp, peak1, peak2, delay, delayGain, dry, exhaustGain,
      exhaustTrim, panL, panR, intakeBp, intakeGain, combBp, combGain,
      mechHp, mechGain, turboBp, turboGain, whistleGain, sum, voiceGain,
    };
  }

  /**
   * Set an AudioParam only when it has actually moved (classic's `setRate`).
   * A change smaller than `eps` is inaudible, so sending it buys nothing and
   * costs one automation event per parameter per tick.
   */
  _setParam(param, value, t, tau, eps) {
    const prev = this._lastParam.get(param);
    if (prev != null && Math.abs(prev - value) < eps) return;
    this._lastParam.set(param, value);
    param.setTargetAtTime(value, t, tau);
  }

  _applyWaves(voice, waves) {
    voice.oscL.setPeriodicWave(waves.left);
    voice.oscR.setPeriodicWave(waves.right);
    voice.oscIntake.setPeriodicWave(waves.mono);
  }

  _buildGraph() {
    const ctx = this.ctx;

    // Bus for everything the engine makes. The prototype's -18 dB / 3.2:1
    // LEVELLING compressor used to sit here: harmless at its own 0.72 master,
    // but at TAS master 100 it pressed into the signal and ate about 9 dB of
    // the pull, which is most of why dynamic volume was inaudible in the car.
    const compressor = ctx.createGain();
    compressor.gain.value = this._outputTrim;

    /* --- cabin staging, copied from the classic engine ----------------------
     * The exhaust band is split off below the crossover, delayed by a rear-wall
     * reflection and placed BEHIND the listener with an HRTF panner; the
     * mechanical top end stays dry and in front; a short decorrelated stereo IR
     * supplies the tail. Wide, reverberant rear content is also what feeds
     * Tesla's Immersive Sound upmixer toward the rear speakers, which is why
     * the classic profiles come out of the whole cabin rather than one point.
     * Values are classic's, not tuned ones — the brief was "same as classic". */
    const sp = this._space;
    const zoneRear = ctx.createBiquadFilter();
    zoneRear.type = 'lowpass'; zoneRear.frequency.value = sp.crossoverHz; zoneRear.Q.value = 0.7;
    const zoneFront = ctx.createBiquadFilter();
    zoneFront.type = 'highpass'; zoneFront.frequency.value = sp.crossoverHz; zoneFront.Q.value = 0.7;

    const rearDelay = ctx.createDelay(0.05);
    rearDelay.delayTime.value = sp.rearDelaySec;
    const rearPanner = ctx.createPanner();
    rearPanner.panningModel = 'HRTF';
    if (rearPanner.positionZ) rearPanner.positionZ.value = sp.rearZ;
    else rearPanner.setPosition(0, 0, sp.rearZ);
    const rearGain = ctx.createGain(); rearGain.gain.value = sp.rearGain;
    const frontGain = ctx.createGain(); frontGain.gain.value = sp.frontGain ?? 1;

    const stage = ctx.createGain();
    compressor.connect(zoneRear);
    zoneRear.connect(rearDelay).connect(rearPanner).connect(rearGain).connect(stage);
    compressor.connect(zoneFront);
    zoneFront.connect(frontGain).connect(stage);

    /* --- body layer -------------------------------------------------------
     * Connected to `master`, which is AFTER the limiter — see the chain below.
     *
     * The first attempt fed zoneRear, to collect the rear HRTF and the reverb
     * send. It measured as doing nothing: mix 8 and mix 20 both landed 60-120 Hz
     * at -26.5 dB, identical, with the peak barely moving. Everything from stage
     * onward still runs through `density` and then `limiter`, so the layer was
     * being compressed away — and had it been pushed harder it would have
     * started ducking the engine above it, which is the pumping this project has
     * spent months chasing. `compressor` is the VOICE compressor; bypassing it
     * bypassed one dynamics stage out of three. Cut below the branch, not above.
     *
     * Losing the HRTF costs nothing real: under about 120 Hz the ear cannot
     * place a source at all, which is the whole reason this band reads as the
     * whole car rather than a point. Spatialising it was never doing anything.
     *
     * `safety` still follows, so nothing here can leave above full scale.
     * Never started when mix is 0, so jz-crank renders no extra node at all. */
    const oscSub = ctx.createOscillator();
    oscSub.type = 'sine';
    oscSub.frequency.value = Math.max(25, this._sub.floorHz || 40);
    const subGain = ctx.createGain();
    subGain.gain.value = 0;

    const reverb = ctx.createConvolver();
    reverb.buffer = cabinIR(ctx, sp.reverbSec, sp.reverbDecay);
    const reverbWet = ctx.createGain(); reverbWet.gain.value = sp.reverbWet;
    const frontSend = ctx.createGain(); frontSend.gain.value = sp.frontSend;
    zoneRear.connect(reverb);
    zoneFront.connect(frontSend).connect(reverb);
    reverb.connect(reverbWet).connect(stage);

    // TAS Sound Profile shelves (Bass / Edge). Neutral at 0.5 so the default
    // card sounds exactly like the prototype.
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 140; low.gain.value = 0;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf'; high.frequency.value = 3500; high.gain.value = 0;

    const dynGain = ctx.createGain();   // in-car loudness curve
    // Recorded in the car: this opened at 1.000 and the first tick pulled it
    // to 0.294 — the engine announcing itself 10.6 dB too loud and then
    // ducking. Start where a standing engine actually sits.
    dynGain.gain.value = this._dyn.dynCeiling * 0.55;
    const master = ctx.createGain();
    master.gain.value = 0;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;

    // Level goes in HERE, before the limiter, so something can contain it.
    //
    // The previous arrangement put it after, to stop the limiter pumping — but
    // after the limiter the only thing left is the brick wall, so it traded
    // pumping for clipping. Measured at full pull: peak 1.52 arriving at a wall
    // that starts shaping at 0.82, with 15% of all samples inside the knee (20%
    // once bass was turned up). classic-muscle in the same test: peak 0.711 and
    // 0% — it never touches its wall at all, which is what "the wall only ever
    // shapes rare peaks" is supposed to mean.
    const makeup = ctx.createGain();
    makeup.gain.value = this._makeup * this._masterScale;

    // A proper peak limiter this time: fast enough to actually catch the
    // exhaust pulses (a 3 ms attack let them straight through to the wall) and
    // slow enough on release that it cannot pump. Fast attack with a slow
    // release removes peak energy while barely touching RMS, which is exactly
    // the loudness the level above is asking for.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.0006;
    limiter.release.value = 0.25;

    // Final brick wall, after master, so nothing leaves above full scale no
    // matter what the volume slider or a profile asks for.
    const safety = ctx.createWaveShaper();
    safety.oversample = 'none';
    // 0.90, not 0.82. classic peaks at 0.65 and never reaches this; CRANK
    // runs at 0.95, so the wall was soft-saturating constantly on signal that
    // was never over full scale. Measured after: output peak 0.953, still
    // clear of 1.0, and 0.4 dB louder for free.
    safety.curve = ceilingCurve(0.90, 0.985);

    // DENSITY — the only place more loudness can come from.
    //
    // The owner wants the car's own volume at 55% instead of 80%. At master
    // 100 the output is already against the ceiling: jz-crank peaks at 0.961
    // with 1.5% of samples in the brick wall, so raising the gain just breaks
    // it. What IS available is crest factor — measured on the same bench,
    // classic-muscle runs 2.7 dB peak-to-rms and jz-crank runs 10.2, which is
    // 7.5 dB of loudness sitting unused at the SAME peak.
    //
    // Attack is slower than a firing pulse is sharp but faster than the crank
    // period, so it clamps the pulse without erasing its leading edge.
    // Release is long against the 10-70 Hz pulse rate on purpose: fast enough
    // to follow the drive envelope, far too slow to breathe at pulse rate,
    // which is the pumping that had to be reverted before.
    const density = ctx.createDynamicsCompressor();
    const dn = this._density;
    density.threshold.value = dn.thresholdDb;
    density.knee.value = dn.kneeDb;
    density.ratio.value = dn.ratio;
    density.attack.value = dn.attackSec;
    density.release.value = dn.releaseSec;
    const densityMakeup = ctx.createGain();
    densityMakeup.gain.value = dn.makeup;

    stage.connect(low).connect(high).connect(dynGain)
      .connect(makeup).connect(density).connect(densityMakeup)
      .connect(limiter).connect(master);
    oscSub.connect(subGain).connect(master);   // body layer, post-limiter
    master.connect(safety);
    safety.connect(analyser);
    analyser.connect(ctx.destination);

    const voices = { a: this._makeVoice(), b: this._makeVoice() };
    for (const key of ['a', 'b']) {
      const v = voices[key];
      this._applyWaves(v, this._waves);
      v.shape.curve = raspCurve(this._spec.rasp);
      v.voiceGain.connect(compressor);
    }
    voices.a.voiceGain.gain.value = 1;
    voices.b.voiceGain.gain.value = 0;

    const white = noiseBuffer(ctx, 2, 'white');
    const pink = noiseBuffer(ctx, 2, 'pink');
    const brown = noiseBuffer(ctx, 2, 'brown');
    const loopSrc = (buf) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start();
      return s;
    };
    const noiseComb = loopSrc(pink);     // combustion hash
    const noiseTurbo = loopSrc(white);   // compressor broadband
    const noiseIntake = loopSrc(pink);   // runner air
    const starterSrc = loopSrc(brown);   // starter motor

    // One trim per LOOPED-NOISE source, placed before the fan-out to the voices,
    // and never written by the tick — so a level set here survives the fifty
    // gain rewrites a second that happen downstream.
    //
    // Only these three are noise. oscMech is a sawtooth and oscWhistle a sine,
    // and intakeBp is fed by BOTH oscIntake and noiseIntake, so trimming the
    // node would take the oscillator with it. Trimming the source does not.
    const combTrim = ctx.createGain();
    const turboTrim = ctx.createGain();
    const intakeNoiseTrim = ctx.createGain();
    noiseComb.connect(combTrim);
    noiseTurbo.connect(turboTrim);
    noiseIntake.connect(intakeNoiseTrim);

    for (const key of ['a', 'b']) {
      const v = voices[key];
      combTrim.connect(v.combBp);
      v.combBp.connect(v.combGain).connect(v.voiceGain);
      turboTrim.connect(v.turboBp);
      v.turboBp.connect(v.turboGain).connect(v.voiceGain);
      intakeNoiseTrim.connect(v.intakeBp);
    }

    const starterLp = ctx.createBiquadFilter();
    starterLp.type = 'lowpass'; starterLp.frequency.value = 400;
    const starterGain = ctx.createGain(); starterGain.gain.value = 0;
    starterSrc.connect(starterLp).connect(starterGain).connect(compressor);

    // Overrun pops: a PERMANENT bed we envelope, never per-event nodes.
    // Node churn on lift-off is exactly the kind of GC spike that shows up as a
    // stutter on the MCU.
    const popSrc = loopSrc(white);
    const popBp = ctx.createBiquadFilter();
    popBp.type = 'bandpass'; popBp.frequency.value = 900; popBp.Q.value = 0.9;
    const popGain = ctx.createGain(); popGain.gain.value = 0.0001;
    popSrc.connect(popBp).connect(popGain).connect(compressor);

    // An OscillatorNode is born at 440 Hz and keeps singing it until something
    // says otherwise — and the first tick is up to 20 ms away, plus a glide.
    // Recorded in the car: the engine came up at 440 Hz and swept down to
    // 6.23 Hz over about a second. That is 73 semitones of descending whoop on
    // every start, and nothing in the profile asked for it.
    //
    // The crank fundamental is rpm/120 — one cycle per two revolutions, which
    // is what the 720 deg wavetable spans.
    const idleHz = Math.max(0.5, (this._spec.idleRpm || 750) / 120);
    for (const key of ['a', 'b']) {
      const v = voices[key];
      v.oscL.frequency.value = idleHz;
      v.oscR.frequency.value = idleHz;
      v.oscIntake.frequency.value = idleHz;
      v.oscMech.frequency.value = idleHz;
      v.oscWhistle.frequency.value = idleHz * 24;
    }
    const t0 = ctx.currentTime + 0.02;
    for (const key of ['a', 'b']) {
      const v = voices[key];
      v.oscL.start(t0); v.oscR.start(t0); v.oscIntake.start(t0);
      v.oscMech.start(t0); v.oscWhistle.start(t0);
    }
    // An oscillator that is never started renders nothing, so a card with no
    // body layer costs exactly what it did before. Uses the local binding:
    // this._nodes is not assigned until after this block.
    // Body layer is started by the first tick that wants it — see _tick.

    this._voices = voices;
    this._active = 'a';
    this._nodes = {
      oscSub, subGain,
      compressor, stage, zoneRear, zoneFront, rearDelay, rearPanner, rearGain,
      density, densityMakeup,
      frontGain, reverb, reverbWet, frontSend,
      low, high, dynGain, makeup, limiter, safety, master, analyser,
      noiseComb, noiseTurbo, noiseIntake, starterSrc, starterLp, starterGain,
      combTrim, turboTrim, intakeNoiseTrim,
      popSrc, popBp, popGain,
    };
    this.setBass(this._bass);
    this.setEdge(this._edge);
  }

  getAnalyser() {
    return this._nodes ? this._nodes.analyser : null;
  }

  /* --------------------------------------------------------- drive loop -- */

  /**
   * Road -> RPM. Same model as Classic/VESSEL: acceleration is the load, gears
   * come from speed bands, steady cruise settles to the gear's rev floor.
   */
  _driveModel(dt) {
    const s = this._spec;
    const idle = s.idleRpm;
    const redline = s.redlineRpm;
    const span = Math.max(500, redline - idle);
    const d = this._drive;

    const smoothL = this.smoothFilter ? 6 : 16;
    this._speedSmooth = damp(this._speedSmooth, this._speed, smoothL, dt);
    // THE LOW-PASS ON THE INPUT, and the only place the scatter can be stopped.
    //
    // A swinging accel signal is faithfully reproduced by everything downstream:
    // rpm follows it, drive and torque follow rpm, and a 1.36 dB wobble in load
    // comes out as 4.72 dB at the exhaust gain. That chain is not wrong — if a
    // car really did surge like that you would hear it. The input is what lies,
    // so the input is where it has to be caught. Classic runs 12 here; CRANK ran
    // 18, which tracks a 1 Hz fix rate almost perfectly.
    const aLam = (this.smoothFilter ? 10 : 18) * (this._drive.accelSmoothMul ?? 1);
    this._accelSmooth = damp(this._accelSmooth, this._accel, Math.max(1, aLam), dt);
    const speed = this.speedReactive ? this._speedSmooth : Math.max(this._speedSmooth, 40);

    // Classic parity: below this the reading is GPS scatter, not the road.
    let accelForLoad = this._accelSmooth;
    if (Math.abs(accelForLoad) < ACCEL_DEADBAND) accelForLoad = 0;
    // accelRef comes from the profile: bigger = LESS sensitive. CRANK reads as
    // twitchier than the classic engines on identical input because one
    // oscillator turns load straight into pitch and level with nothing masking
    // it, so it runs a slacker reference than their 26.
    const aNorm = clamp(accelForLoad / (d.accelRef || this.accelRefKmhps), -1.4, 1.4);
    let accelLoad = clamp(aNorm, 0, 1);
    let decelLoad = clamp(-aNorm, 0, 1);

    // The app feeds a constant cruise throttle while holding speed
    // (vehicle-physics.js sets 0.18), and a PROPORTIONAL one while accelerating
    // — clamped to a 0.15 floor. So light acceleration arrives with LESS
    // throttle (0.15) than holding a steady speed (0.18). Taking max() of that
    // against the acceleration signal inverted the two: accelLoad read 0.153 at
    // cruise and 0.128 under a light pull, so the car got quieter when the
    // driver eased on. Measured: civic-crank light throttle came out -0.3 dB
    // against classic's +8.4.
    //
    // Adding keeps the standing load a real engine carries at cruise while
    // leaving acceleration free to move on top of it. Full throttle is
    // unchanged — aNorm alone already saturates.
    const cruiseLoad = d.cruiseLoad ?? DEFAULT_DRIVE.cruiseLoad;
    accelLoad = clamp(accelLoad + this._throttle * cruiseLoad, 0, 1);
    decelLoad = Math.max(decelLoad, this._brake * 0.85);
    const accelRaw = accelLoad;   // gear choice keeps this, so shift points hold

    // Two readings of the same pedal, on purpose.
    //
    // accelLoad decides WHERE THE REVS GO. accelVoice decides HOW LOUD IT IS,
    // and only that one gets the curve — it lifts the small-but-real end,
    // because easing up at 3 km/h/s used to come out at exactly the cruise
    // level, which is why light throttle needed the car at 85% while a hard
    // pull was right at 65%.
    //
    // They are separate because the first attempt curved the single shared
    // value, so the revs jumped on a light touch as well. The result felt
    // twitchier than before the sensitivity was ever reduced — the opposite of
    // what was asked for. Full throttle is untouched either way (1 ** k is 1),
    // and the deadband still rejects GPS noise ahead of both.
    const kv = d.accelCurve ?? 0.65;
    const accelVoice = Math.pow(accelLoad, kv);
    const decelVoice = Math.pow(decelLoad, kv);

    this._idlePhase += dt;
    let load;

    if (this._holdRpm != null) {
      // Eval / CommandRoom pin
      this._rpm = damp(this._rpm, this._holdRpm, 12, dt);
      load = clamp(0.12 + Math.max(this._throttle, accelLoad) * 0.88, 0, 1);
      this._driveState = load > 0.25 ? 'pull' : 'cruise';
      this._gearBias = gearToneBias(this._gear);
    } else if (this._revUntil && performance.now() < this._revUntil) {
      // Launch Rev — scripted standing pull
      const elapsed = (performance.now() - (this._revUntil - this._revDuration * 1000)) / 1000;
      const step = stepRevScript({
        elapsed, script: this._revScript, rpm: this._rpm, idle, redline, dt,
      });
      this._rpm = step.rpm;
      load = step.loadBus != null ? step.loadBus : step.load;
      this._gear = step.gear;
      this._driveState = step.state === 'done' ? 'idle' : step.state;
      this._shifting = step.shifting;
      this._gearBias = gearToneBias(this._gear);
      if (step.done) { this._revUntil = 0; this._revScript = null; }
    } else {
      if (this._revUntil && performance.now() >= this._revUntil) {
        this._revUntil = 0;
        this._revScript = null;
      }
      if (this._shifting) {
        this._shiftTimer -= dt;
        if (this._shiftTimer <= 0) {
          this._shifting = false;
          if (this._shiftUp && accelLoad > 0.18) this._postShift = 0.14;
        }
      }
      if (this._postShift > 0) this._postShift -= dt;
      if (this._shiftLandT > 0) {
        this._shiftLandT -= dt;
        if (this._shiftLandT <= 0) this._shiftLand = null;
      }
      if (this._glideHold > 0) this._glideHold -= dt;

      // Pulling away is a RAMP, not a step.
      //
      // This used to be a bare threshold: under it the revs sat at idle, over
      // it they sat on the gear-1 floor. For a six that is 750 against 1300 —
      // 9.6 semitones, and the exhaust note an octave with it, crossed every
      // time a crawling car wobbles past 1.5 km/h. Recorded in traffic at
      // 0-7 km/h: state flipping idle <-> cruise, revs 747 -> 1690, level
      // modulation 13.5 dB where a steady cruise measures 1.4.
      //
      // Two things were wrong and both are here. The boundary now latches the
      // way classic's overrun does — enter deep, leave shallow — so a wobble
      // cannot flap it. And leaving it no longer steps: the gear-1 floor
      // blends up from idle across the launch, which is what a real engine
      // does as the clutch takes up.
      //
      // Also why raising accelRef did nothing for this: the boundary is on
      // SPEED. A slacker accelRef makes accelLoad smaller, which makes the
      // idle side EASIER to satisfy — if anything it flapped more.
      const idleEnter = speed < 1.5 && accelLoad < 0.1;
      const idleStay = speed < 3.2 && accelLoad < 0.16;
      this._idleLatch = this._idleLatch ? idleStay : idleEnter;
      if (this._idleLatch) {
        // Idle — hunt the idle speed a little (prototype's idleHunt)
        load = 0.05;
        this._gear = 1;
        this._driveState = 'idle';
        const hunt = Math.sin(this._idlePhase * (7 + s.idleHunt * 0.15)) * s.idleHunt;
        this._rpm = damp(this._rpm, idle + hunt, 10, dt);
        this._gearBias = gearToneBias(1);
      } else {
        this._sinceShift += dt;
        let nextGear = resolveGear(speed, this._gear, accelRaw, decelLoad);
        if (nextGear > this._gear + 1) nextGear = this._gear + 1;
        else if (nextGear < this._gear - 1) nextGear = this._gear - 1;

        if (nextGear !== this._gear && !this._shifting && this._sinceShift > 0.26) {
          const up = nextGear > this._gear;
          this._prevGear = this._gear;
          this._gear = nextGear;
          this._sinceShift = 0;
          this._shifting = true;
          this._shiftUp = up;
          this._shiftTimer = up ? 0.12 : 0.09;
          // The rpm snap below is a step change. Let the pitch WALK to it.
          this._glideHold = d.glideHoldSec;
          // NOT IN MANUAL. These snaps belong to the automatic, whose revs come
          // from load: after an upshift it lands just above revLo and that is a
          // fair guess because nothing else decides. In manual the RATIO decides
          // — rpmInGearManual already returns speed/vmax * redline, the true new
          // rev for the gear just selected — so assigning a fixed number here
          // does not help it, it fights it.
          //
          // shiftLandingRpm ignores gear and speed alike and returns
          // idle + (redline - idle) * (revLo + 0.03), which on the 1JZ is 1975
          // whatever is happening. Shift up at 7000 and the rev line teleports
          // to 28% of where it was in a single tick, and the ratio model hauls
          // it straight back. Measured through a scripted manual upshift, that
          // came out at -1013 st/s, unchanged by every fall-rate cap because an
          // assignment is not a rate. It is the snatch he heard at the change.
          //
          // The gain duck and the glide hold stay: torque really is interrupted
          // in manual too. Only the teleport goes.
          // A TARGET, NOT AN ASSIGNMENT.
          //
          // This used to write this._rpm directly, and that is the judder he
          // has been reporting since the engine shipped -- the same sound in
          // automatic that he caught in manual, where it was easier to see.
          // Measured on the automatic drive it threw the rev line at -568 st/s,
          // which no rate cap could touch because an assignment is not a rate.
          //
          // The drop itself is wanted: rpmInGear only moves its floor 125 rpm
          // per gear, so without this there is no "coming down between gears"
          // at all, which is the thing he asked for in the first place. So keep
          // the destination and take the teleport: hold it as a target for
          // shiftLandSec and let the limiter walk there at shiftFallStPerSec.
          if (!isManual()) {
            if (up) {
              this._shiftLand = shiftLandingRpm(this._gear, idle, redline, d.revLo);
              this._shiftLandT = d.shiftLandSec ?? 0.3;
            } else if (accelLoad > 0.25) {
              this._shiftLand = Math.min(redline * 0.95,
                Math.max(this._rpm, idle + span * Math.min(0.95, d.revHi * 0.9)));
              this._shiftLandT = d.shiftLandSec ?? 0.3;
            }
          }
        }
        this._gearBias = gearToneBias(this._gear);

        // LAUNCH BLEND — see the comment on the latch above. Full gear floor
        // only once the car is properly rolling; below that, walk up from
        // idle so leaving a standstill is continuous.
        const launch = clamp((speed - 1.5) / (LAUNCH_KMH - 1.5), 0, 1);
        // Manual mode swaps where the revs COME FROM, not how they move.
        // Automatic ties them to acceleration, which is right when the box
        // picks its own gear. Once a human holds one, they have to follow
        // speed instead or the choice means nothing — second at 90 has to
        // scream and fifth at 20 has to lug. Everything after this line is
        // untouched: same glide, same rate caps, same shift handling.
        let targetRpm = isManual()
          ? rpmInGearManual({
            gear: this._gear,
            speedKmh: speed,
            idle,
            redline,
            accelLoad,
            decelLoad,
            revLo: d.revLo,
            pull: d.revPull,
          })
          : rpmInGear({
            gear: this._gear,
            idle,
            redline,
            accelLoad,
            decelLoad,
            revLo: d.revLo,
            pull: d.revPull,
            floorLo: d.floorLo,
            floorHi: d.floorHi,
          });
        // Classic's rates, verbatim. CRANK was chasing the target roughly twice as
        // fast (6-15 against 3.6-8.5), which on a single oscillator means it
        // tracked GPS scatter straight into the pitch.
        let rpmLambda = this.smoothFilter ? 3.6 : 5.5;
        if (launch < 1 && !isManual()) targetRpm = idle + (targetRpm - idle) * launch;

        // REV LIMITER — a fuel cut, not a ceiling.
        //
        // A limiter does not hold the engine at a number, it stops firing and
        // lets it fall, then fires again: revs hammer up and down against the
        // cut at roughly 12-15 Hz and the exhaust cracks on every re-light.
        // Holding a clean line at the redline is silent and dull, which is
        // exactly what it sounded like.
        //
        // Manual only. The automatic upshifts before it ever gets here, and
        // nothing in this block can run unless a human is holding the gear.
        this._onLimiter = false;

        if (isManual() && this._rpm >= redline * 0.975) {
          this._limPhase += dt;
          const cut = Math.sin(this._limPhase * Math.PI * 2 * d.limiterHz) > -0.15;
          this._onLimiter = cut;
          if (cut) targetRpm = redline * d.limiterDropTo;
          rpmLambda = 22;                  // the cut bites fast, it does not glide
        } else {
          this._limPhase = 0;
        }

        // NOTHING SHIFTS ITSELF IN MANUAL. Both halves of this were built and
        // both came out on the owner's call, and the reasoning holds either
        // way round: an upshift at the limiter arrives while the car is still
        // gaining speed, which reads as the app fighting the driver, and a
        // downshift out of lugging takes away the very thing someone might be
        // trying to do — pull away in fifth, because a real manual lets you.
        //
        // The engine reports what it is doing and the driver decides. That is
        // the whole point of the mode.
        if (accelLoad > 0.35) rpmLambda = 6 + accelLoad * 2.5;
        if (decelLoad > 0.35) rpmLambda = 5.5 + decelLoad * 2;
        if (isManual() && accelLoad < 0.12) rpmLambda = Math.max(rpmLambda, 13);
        if (this._shifting) {
          rpmLambda = 18;
          targetRpm = this._rpm * 0.94 + targetRpm * 0.06;
        }
        // The gear change owns the target while its window is open. An upshift
        // may only pull the revs DOWN and a downshift only up, so the pull
        // target can never cancel the drop the way it did before this was a
        // teleport.
        if (this._shiftLand != null) {
          targetRpm = this._shiftUp
            ? Math.min(targetRpm, this._shiftLand)
            : Math.max(targetRpm, this._shiftLand);
        }
        // Angular inertia. damp() alone will happily jump thousands of rpm in one
        // tick when the demand steps; a real crank + flywheel cannot. Off boost a
        // turbo engine is lazier still, which is most of why the 1JZ feels heavy
        // down low and then suddenly does not.
        const next = damp(this._rpm, clamp(targetRpm, idle * 0.85, redline * 1.05), rpmLambda, dt);
        const delta = next - this._rpm;
        const engineRise = d.riseRpmPerSec
          * (s.induction === 'turbo' ? 0.5 + 0.5 * this._boost : 1);
        // The same rpm/s is far more pitch per second down low than up high, so a
        // pure rpm/s cap lets a wide-range engine swoop away right after a shift
        // while a heavier one sounds fine on identical numbers. Cap the PITCH
        // rate too — it only binds at low rpm, which is exactly where it should.
        const byPitch = Math.max(idle, this._rpm) * d.maxRiseStPerSec / ST;
        const riseCap = Math.min(engineRise, byPitch) * dt;
        // Blipping — on, off, on, off, listening to the engine — lives or dies
        // on how fast the revs COME DOWN, and the automatic's fall is tuned for
        // a car that is still driving: it lifts between gears, not to nothing.
        // maxFallStPerSec also went 72 -> 57 when the pitch roughness was
        // fixed, which slowed exactly this.
        //
        // A closed throttle in manual is a driver asking for the revs back, so
        // it gets the engine's real overrun rate: no combustion, just a
        // flywheel against its own friction, which falls a great deal faster
        // than a part-throttle lift.
        const blipping = isManual() && accelLoad < 0.12 && delta < 0;
        const fallSt = this._shiftLand != null
          ? (d.shiftFallStPerSec ?? d.maxFallStPerSec)
          : (blipping ? d.maxFallStPerSec * d.blipFallMul : d.maxFallStPerSec);
        const fallRpm = blipping ? d.fallRpmPerSec * d.blipFallMul : d.fallRpmPerSec;
        const fallCap = Math.min(fallRpm, Math.max(idle, this._rpm) * fallSt / ST) * dt;
        this._rpm += delta >= 0 ? Math.min(delta, riseCap) : Math.max(delta, -fallCap);

        load = clamp(accelVoice * 0.85 + decelVoice * 0.25 + (speed > 5 ? 0.08 : 0), 0, 1);
        // Fuel cut means no combustion, so the voice has to go with the revs.
        // Dropping the rev line alone was inaudible — the engine sat at the
        // redline sounding perfectly happy.
        if (this._onLimiter) load = clamp(load * 0.34, 0, 1);
        const gPos = gearProgress(speed, this._gear);
        if (accelLoad > 0.3 && gPos > 0.75) load = clamp(load + 0.15, 0, 1);
        // Torque interruption. This used to take load down to 12% on an upshift,
        // ON TOP of the gain duck — two cuts stacked into one hole. Classic
        // applies its duck alone and lets the rev drop carry the shift.
        if (this._shifting) load = clamp(load * (this._shiftUp ? 0.72 : 0.85), 0, 1);
        else if (this._postShift > 0) load = clamp(load + 0.2 * (this._postShift / 0.14), 0, 1);

        // Overrun hysteresis, classic verbatim. A single threshold lets GPS
        // scatter flip cruise<->overrun repeatedly, and every flip switches a
        // gain multiplier — audible as the sound breaking up right at lift-off.
        // Classic latches: enter deep, leave shallow.
        if (decelLoad > 0.38) this._overrunLatch = true;
        else if (decelLoad < 0.18 || accelLoad > 0.2) this._overrunLatch = false;

        if (this._shifting) this._driveState = 'shift';
        else if (this._overrunLatch) this._driveState = 'overrun';
        else if (accelLoad > 0.22) this._driveState = 'pull';
        else this._driveState = 'cruise';
      }
    }

    // Rev-hang: effort punches in fast, holds, then eases — stops the sound
    // collapsing the instant GPS accel dips.
    const effTarget = (this._revUntil || this._holdRpm != null) ? 1 : accelVoice;
    if (effTarget > this._effort) {
      this._effort = damp(this._effort, effTarget, 14, dt);
      this._effortHold = 0.5;
    } else {
      this._effortHold -= dt;
      if (this._effortHold <= 0) this._effort = damp(this._effort, effTarget, 2.5, dt);
    }

    this._limiter = this._rpm >= redline;
    if (this._rpm > redline) this._rpm = redline;
    // The attack. Rise is capped at full-scale-per-loadAttackSec; fall passes
    // straight through. Applied HERE because this one value is what every gain
    // downstream reads — exhaust, combustion, intake and the dyn curve alike —
    // so the onset is shaped once rather than in five places that could drift.
    const wanted = clamp(Math.max(load, this._effort * 0.9), 0, 1);
    const attack = Math.max(0.01, d.loadAttackSec ?? 0.3);
    this._load = wanted > this._load
      ? Math.min(wanted, this._load + dt / attack)
      : wanted;
    return { accelLoad, decelLoad, accelVoice, decelVoice, speed, idle, redline, span };
  }

  _tick(dt) {
    if (!this.running || !this._nodes) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = this._spec;
    const v = this._voices[this._active];

    const cranking = t < this._crankUntil;
    const drv = this._driveModel(dt);
    if (cranking) {
      // Starter spinning the engine over before it catches
      this._rpm = 240 + Math.random() * 60;
      this._load = 0.08;
      this._driveState = 'idle';
    } else if (this._nodes.starterGain.gain.value > 0.001) {
      at(this._nodes.starterGain.gain, 0, t, 0.08);
    }

    const rpm = this._rpm;
    const load = this._load;
    const rpmNorm = clamp((rpm - s.idleRpm) / Math.max(1, s.redlineRpm - s.idleRpm), 0, 1);

    // --- body layer ------------------------------------------------------
    // classic's law, unchanged: roughly first engine order (halved under eight
    // cylinders) over a floor, so it sits where the ear stops localising. Body
    // is loudest low down and backs off as the revs climb, which is why it
    // fills the car at a cruise and never muds up a pull.
    if (this._sub.mix > 0 && this._nodes) {
      const sub = this._sub;
      // Started here, not in _buildGraph. Switching cards while the engine runs
      // swaps the profile without rebuilding the graph, so a card that arrives
      // wanting body found an oscillator that had never been started: gain rode
      // up to 0.42 and not one sample came out. The tick is the only place that
      // sees every route in.
      if (!this._subStarted) {
        try { this._nodes.oscSub.start(t + 0.02); } catch (_) { /* already going */ }
        this._subStarted = true;
      }
      // n harmonics of a 720-degree table = n * rpm/120.
      const order = sub.order > 0 ? sub.order : s.cylinders / 2;
      const hz = Math.max(25, (rpm / 120) * order + sub.floorHz);
      this._setParam(this._nodes.oscSub.frequency, hz, t, 0.08, hz * 0.004);
      const g = sub.mix
        * (sub.base + (1 - rpmNorm) * sub.lowRpm + this._throttle * sub.throttle)
        * (0.5 + this._bass);
      at(this._nodes.subGain.gain, g, t, 0.08);
    }

    // --- induction state -------------------------------------------------
    // Boost = what the rpm makes available, gated by how hard the engine is
    // being asked to work, then chased with the turbo's own lag. Cruising at
    // 2500 rpm therefore sits near zero boost, the way a real one does.
    const b = this._boostSpec;
    if (s.induction === 'turbo' && b) {
      const loadGate = smoothstep(b.loadLo, b.loadHi, load);
      const target = boostAtRpm(rpm, b, s.redlineRpm) * loadGate;
      const tau = target < this._boost
        ? b.bleedSec                                   // closed throttle: dumps fast
        : (rpm < b.crossRpm ? b.spoolSec : b.spoolFastSec);
      this._boost += (target - this._boost) * (1 - Math.exp(-dt / tau));
    } else {
      this._boost += (0 - this._boost) * 4 * dt;
    }
    if (s.induction === 'vtec') {
      const lo = s.vtecRpm - 180;
      const hi = s.vtecRpm + 220;
      const target = clamp((rpm - lo) / (hi - lo), 0, 1);
      this._vtec += (target - this._vtec) * (1 - Math.exp(-dt / 0.08));
    } else {
      this._vtec = 0;
    }

    // --- rev wander (classic parity) --------------------------------------
    // Real revs are never frozen on a number, even holding a gear floor. Classic
    // writes this into the rpm it plays AND displays, while gear selection keeps
    // using the clean value. CRANK had nothing, so it sat dead flat.
    const d0 = this._drive;
    this._breathePhase += dt;
    const bp = this._breathePhase;
    const lopeCh = s.idleHunt / 20;
    // Sized against classic measured on the same bench: at a settled 60 km/h
    // classic's oscillator moved 7.06% while CRANK's moved 2.45%. The old base
    // (18 + lope * 62) was 2.9x short. Raising it costs nothing in pitch rate --
    // these are 2-5 rad/s sines, so even at 7% they contribute about 2 st/s
    // against the 100 st/s already on the profile.
    const wBase = d0.wanderRpm ?? DEFAULT_DRIVE.wanderRpm;
    const wLope = d0.wanderLope ?? DEFAULT_DRIVE.wanderLope;
    const wanderAmp = (wBase + lopeCh * wLope) * (1.15 - Math.min(1, rpmNorm) * 0.65);
    const wander = wanderAmp * (
      0.5 * Math.sin(bp * 2.1) + 0.3 * Math.sin(bp * 5.3) + 0.2 * Math.sin(bp * (3.5 + lopeCh * 4))
    );
    const rpmPlayed = rpm + (this._speedSmooth > 2 ? wander : 0);

    // The needle shows what the engine PLAYS. _rpm stays clean because gear
    // selection and the drive-state thresholds run off it and must not be
    // jittered — but the owner reads the gauge, and a gauge frozen on an exact
    // number is the tell that there is no engine behind it. Classic writes the
    // wander into the value it displays; CRANK kept it out of both. Measured at
    // cruise: classic's needle moved 134 rpm, CRANK's moved 0.
    this._rpmDisplay = rpmPlayed;

    // --- combustion micro-jitter (kills the perfect-loop tell) ------------
    // Classic's amounts. CRANK was running up to 4x more grain, which on a pure
    // oscillator is continuous roughness rather than texture.
    const jAmt = 0.0012 + (1 - rpmNorm) * 0.002 + load * 0.0008;
    this._jitter = damp(this._jitter, (Math.random() * 2 - 1) * jAmt, 2.4, dt);
    const rpmOut = rpmPlayed * (1 + this._jitter);

    // --- oscillators ------------------------------------------------------
    // Pitch glide. The gearbox SNAPS rpm on a shift (6400 -> 2200 in one step);
    // a real engine takes ~0.1-0.2 s to fall that far with the clutch out. Follow
    // it at the fast rate normally and the slow one through a shift, or the drop
    // arrives as a click. (Launch Rev never exposed this: its script ramps rpm.)
    const d = this._drive;
    const glide = (this._shifting || this._glideHold > 0) ? d.shiftGlideSec : d.glideSec;

    // Pitch ceiling (classic parity). The readout still reaches the real
    // redline, but everything that sets a PLAYED frequency runs on a rev range
    // mapped onto idle..rpmCeiling. Classic has capped this at 4800 since the
    // harshness complaint; muscle's own redline is 4500, so muscle is untouched
    // by it — part of why muscle sounds settled. A 7200 rpm profile playing its
    // full range is both brighter and 1.6x more sensitive, in semitones, to any
    // rev error at all.
    const ceilRpm = Math.min(s.redlineRpm, d.rpmCeiling || 4800);
    const pitchRpm = s.idleRpm
      + ((rpmOut - s.idleRpm) * (ceilRpm - s.idleRpm)) / Math.max(1, s.redlineRpm - s.idleRpm);

    // Push at ~25 Hz, and skip anything smaller than the epsilon. Classic has
    // done both since the start; CRANK pushed every parameter every tick, so a
    // sub-audible rev wobble still became a fresh automation ramp 50 times a
    // second. Fewer events is also strictly less work for the audio thread.
    this._paramTick++;
    const pushAudio = (this._paramTick & 1) === 0;
    const f = cycleHz(Math.max(pitchRpm, 1));
    if (pushAudio) {
      this._setParam(v.oscL.frequency, f, t, glide, f * 0.004);
      this._setParam(v.oscR.frequency, f, t, glide, f * 0.004);
      this._setParam(v.oscIntake.frequency, f, t, glide, f * 0.004);
      this._setParam(v.oscMech.frequency, Math.max(1, f * 2), t, glide, f * 0.008);
    }

    const whistleHz = s.induction === 'turbo'
      ? 1800 + this._boost * 7400 + rpm * 0.22
      : s.itb ? 900 + rpmNorm * 2400 + load * 400
        : 700 + rpmNorm * 900;
    v.oscWhistle.frequency.setTargetAtTime(whistleHz, t, 0.04);

    // --- resonances -------------------------------------------------------
    const lpHz = 280 + s.brightness * (420 + rpmNorm * 5200) * (0.35 + 0.65 * Math.max(load, 0.2));
    v.exhaustLp.frequency.setTargetAtTime(lpHz, t, 0.04);
    v.peak1.frequency.setTargetAtTime(s.exhaustHz * (0.92 + rpmNorm * 0.18), t, 0.05);
    v.peak2.frequency.setTargetAtTime(s.exhaustHz2 * (0.9 + rpmNorm * 0.2), t, 0.05);
    v.intakeBp.frequency.setTargetAtTime(s.intakeHz * (0.75 + rpmNorm * 0.45), t, 0.05);
    v.combBp.frequency.setTargetAtTime(220 + rpmNorm * 1400 + s.cylinders * 18, t, 0.05);
    v.turboBp.frequency.setTargetAtTime(1400 + rpmNorm * 4200, t, 0.05);

    // --- levels (prototype mixer law, torque-weighted) --------------------
    const torque = torqueFactor(rpm, s);
    const drive = 0.28 + load * 0.55 + rpmNorm * 0.22;
    const combLvl = 0.22 + load * 0.55 + rpmNorm * 0.15;
    // "Silk, then spool" — off boost the exhaust is only `offGain` of its full
    // voice, and the turbos add the rest as they come in. This is what makes the
    // climb follow the boost curve instead of rising flat with rpm.
    const swell = b ? b.offGain + (1 - b.offGain) * this._boost : 1;
    const swellIntake = b ? 1 - b.intakeGain * (1 - swell) : 1;
    const exhaust = sq(this._mixer.exhaust) * s.body * drive * torque * swell
      * (this._limiter ? 0.35 : 1);
    const intake = sq(this._mixer.intake) * (0.12 + load * 0.7) * (0.35 + rpmNorm * 0.8)
      * (s.itb ? 1.15 : 0.75) * (1 + this._vtec * 0.85) * swellIntake;
    const mech = sq(this._mixer.mechanical) * (0.08 + rpmNorm * 0.45);
    const ind = sq(this._mixer.induction);
    const turboLvl = s.induction === 'turbo' ? this._boost * 0.85
      : s.itb ? rpmNorm * load * 0.35 : this._vtec * 0.4;
    const whistleLvl = s.induction === 'turbo' ? this._boost * 0.22 * rpmNorm
      : s.itb ? rpmNorm * load * 0.08 : this._vtec * 0.12;

    at(v.exhaustGain.gain, cranking ? exhaust * 0.12 : exhaust, t, 0.03);
    at(v.intakeGain.gain, intake * 0.55, t, 0.03);
    at(v.combGain.gain, combLvl * 0.28 * (0.5 + this._mixer.exhaust), t, 0.04);
    at(v.mechGain.gain, mech * 0.22 * (cranking ? 0.5 : 1), t, 0.04);
    at(v.turboGain.gain, ind * turboLvl * 0.35, t, 0.05);
    at(v.whistleGain.gain, ind * whistleLvl, t, 0.05);
    at(v.delayGain.gain, s.delayMix * (0.4 + rpmNorm * 0.6), t, 0.08);
    v.delay.delayTime.setTargetAtTime(s.pipeM / 343, t, 0.05);
    v.panL.pan.setTargetAtTime(-s.stereoWidth, t, 0.1);
    v.panR.pan.setTargetAtTime(s.stereoWidth, t, 0.1);

    // --- VTEC cam crossover (latched, like the real rocker) ---------------
    // The latch stops the cam chasing every rev swing. What it cannot fix is
    // that setPeriodicWave replaces the oscillator's ENTIRE harmonic content in
    // one sample — no CPU cost (measured 0 ms), but a step in the waveform, and
    // classic never does anything like it: it crossfades layers with gains.
    // Only VTEC profiles reach this code, which is why the Civic yanks at
    // shifts and the 1JZ, on the same engine, never does.
    //
    // So the swap happens UNDER a duck: one tick to fade the voice down, the
    // next to change the wave and come back. Runs on the existing tick, so no
    // timers and no extra nodes.
    this._camHold -= dt;
    if (s.induction === 'vtec' && this._vtecWaves && this._camSpec) {
      const c = this._camSpec;
      if (this._camPending) {
        this._applyWaves(v, this._camPending === 'sharp' ? this._vtecWaves : this._waves);
        this._camPending = null;
        v.sum.gain.setTargetAtTime(1, t, 0.012);
      } else {
        const sharp = this._sharpCam ? this._vtec > c.offAt : this._vtec > c.onAt;
        if (sharp !== this._sharpCam && this._camHold <= 0) {
          this._sharpCam = sharp;
          this._camHold = c.dwellSec;
          this._camPending = sharp ? 'sharp' : 'mild';
          v.sum.gain.setTargetAtTime(c.duckTo ?? 0.35, t, 0.004);
        }
      }
    }

    // --- overrun pops on lift ---------------------------------------------
    this._popCooldown -= dt;
    const dLoad = load - this._prevLoad;
    this._prevLoad = load;
    if (s.overrun > 0.1 && rpm > 3800 && dLoad < -0.14 && this._popCooldown <= 0) {
      this._firePops(t, s.overrun);
      this._popCooldown = 0.22;
    }
    // The limiter's own crack. Same envelope as an overrun pop because it is
    // the same event — unburnt fuel lighting in the pipe — just triggered by
    // the cut instead of a lift.
    if (this._onLimiter && this._popCooldown <= 0) {
      this._firePops(t, Math.max(0.5, s.overrun));
      this._popCooldown = 0.09;
    }

    // --- in-car loudness ---------------------------------------------------
    // A held gear needs its own loudness model — in manual the revs follow road
    // speed, so "high rpm" no longer implies "working hard" and the automatic's
    // rpm-led curve holds a low-gear cruise at full voice. See
    // computeManualVolume.
    const dynFn = isManual() ? computeManualVolume : computeDynamicVolume;
    const dyn = dynFn({
      effort: this._effort,
      rpmNorm,
      accelLoad: drv.accelVoice,
      decelLoad: drv.decelLoad,
      speed: drv.speed,
      idlePresence: this._dyn.idlePresence,
      gear: this._gear,
      gearCount: GEAR_COUNT,
      shifting: this._shifting,
      overrun: this._driveState === 'overrun',
      dynDb: this._dyn.dynDb,
      curveMul: 1,
      loadBoost: this._dyn.loadBoost,
      floorBias: this._dyn.floorBias,
      load,
      softCeiling: this._dyn.dynCeiling,
      shiftDuck: this._dyn.shiftDuck,
      overrunDuck: this._dyn.overrunDuck,
    });
    at(this._nodes.dynGain.gain, clamp(dyn.dynVol, 0, 1.2), t, 0.05);

    const master = this._masterOverride != null ? this._masterOverride : sq(this._mixer.master);
    at(this._nodes.master.gain, master, t, 0.04);
  }

  /**
   * 1-3 exhaust pops. Envelope only — the noise bed and its filter already
   * exist, so nothing is allocated and nothing is collected.
   */
  _firePops(t, overrun) {
    const g = this._nodes.popGain.gain;
    const bp = this._nodes.popBp.frequency;
    const count = 1 + Math.floor(overrun * 3 * Math.random());
    g.cancelScheduledValues(t);
    for (let i = 0; i < count; i++) {
      const at0 = t + i * (0.04 + Math.random() * 0.05);
      bp.setValueAtTime(600 + Math.random() * 1600, at0);
      g.setValueAtTime(0.0001, at0);
      g.exponentialRampToValueAtTime(Math.max(0.002, 0.35 * overrun), at0 + 0.004);
      g.exponentialRampToValueAtTime(0.0001, at0 + 0.07);
    }
  }

  /* --------------------------------------------------------------- API -- */

  setSpeed(kmh, extras = {}) {
    this._speed = Math.max(0, kmh);
    if (extras.throttle != null) this._throttle = clamp(extras.throttle, 0, 1);
    if (extras.brake != null) this._brake = clamp(extras.brake, 0, 1);
    if (extras.accelKmhps != null) this._accel = extras.accelKmhps;
  }

  setThrottle(v) { if (v != null) this._throttle = clamp(v, 0, 1); }

  /**
   * Split the engine into its two repeating halves so they can be heard apart.
   * Dev only, and it disconnects rather than zeroing a gain because the tick
   * rewrites every gain 50 times a second and would undo it instantly.
   *
   *   'engine'  wavetable only — the part that repeats at rpm/120
   *   'noise'   noise beds only — four 2-second buffers on loop, 0.5 Hz
   *   'all'     put everything back
   *
   * If the pattern follows the revs it is the table; if it holds the same
   * cadence whatever the engine is doing, it is the loops.
   */
  /**
   * Listening levels, 0..1 each, for finding a balance by ear rather than by
   * switching halves off. Muting outright is what made the first version of
   * this useless -- his words, it goes "digital". A percentage does not.
   *
   *   noise   the three LOOPED-NOISE sources: combustion hash, turbo, and the
   *           noise half of the intake. Not mech (a sawtooth) and not whistle
   *           (a sine) -- those are oscillators and never loop.
   *   engine  the firing wavetable.
   *
   * Static gains placed outside the tick's reach, so a setting stays put.
   */
  setMix({ noise, engine } = {}) {
    if (!this._nodes) return 'engine not running';
    const n = this._nodes;
    if (noise != null) {
      const g = Math.max(0, noise);
      this._mixNoise = g;
      for (const k of ['combTrim', 'turboTrim', 'intakeNoiseTrim']) if (n[k]) n[k].gain.value = g;
    }
    if (engine != null && this._voices) {
      const g = Math.max(0, engine);
      this._mixEngine = g;
      for (const k of Object.keys(this._voices)) {
        const t = this._voices[k].exhaustTrim;
        if (t) t.gain.value = g;
      }
    }
    return { noise: this._mixNoise ?? 1, engine: this._mixEngine ?? 1 };
  }

  /** Shorthand over setMix, kept because it reads well while listening. */
  isolate(what = 'all') {
    if (what === 'engine') return this.setMix({ engine: 1, noise: 0 });
    if (what === 'noise') return this.setMix({ engine: 0, noise: 1 });
    return this.setMix({ engine: 1, noise: 1 });
  }


  /**
   * Body-layer level, live. Starts the oscillator on first use, because an
   * unstarted OscillatorNode stays silent forever however high the gain goes —
   * which would make this setter look like it did nothing. Cards that never
   * call it still pay for no extra node.
   */
  setSubMix(v) {
    if (v == null || !this._sub) return;
    this._sub.mix = Math.max(0, v);   // the next tick starts the oscillator
  }
  setAccel(k) { this._accel = k; }
  setHoldRpm(rpm) { this._holdRpm = rpm == null ? null : Math.max(0, rpm); }

  /** APP SYSTEM — global output level. */
  setMasterVolume(v) {
    this._masterOverride = clamp(v, 0, 1.2);
    if (!this._nodes || !this.ctx) return;
    at(this._nodes.master.gain, this._masterOverride, this.ctx.currentTime, 0.03);
  }

  /**
   * SOUND PROFILE — cabin body. Neutral at 0.5 = the prototype's balance.
   *
   * A shelf that adds energy has to pay for it in headroom. Turning this to 100
   * puts +5 dB into the band the engine already lives in, and measured, that
   * took the share of samples being shaped by the brick wall from 15% to 20% —
   * audible as the sound breaking up. So the bus gives back part of what the
   * shelf adds: the low end still rises clearly against everything else, which
   * is the point of the control, without the peak running away with it.
   */
  setBass(v) {
    this._bass = clamp(v, 0, 1);
    if (!this._nodes || !this.ctx) return;
    const t = this.ctx.currentTime;
    const shelfDb = (this._bass - 0.5) * 10;
    this._nodes.low.gain.setTargetAtTime(shelfDb, t, 0.05);
    const compDb = shelfDb > 0 ? -shelfDb * 0.6 : 0;
    at(this._nodes.compressor.gain, this._outputTrim * Math.pow(10, compDb / 20), t, 0.05);
  }

  /** SOUND PROFILE — top-end bite. Neutral at 0.5. */
  setEdge(v) {
    this._edge = clamp(v, 0, 1);
    if (!this._nodes || !this.ctx) return;
    this._nodes.high.gain.setTargetAtTime((this._edge - 0.5) * 10, this.ctx.currentTime, 0.05);
  }

  /** Launch Rev — scripted G1->G2->G3 pull while parked. */
  startRevTest(seconds = 5) {
    if (!this.running) return false;
    this._revDuration = clamp(seconds, 2, 10);
    this._revScript = buildRevScript(this._revDuration, false);
    this._revUntil = performance.now() + this._revDuration * 1000;
    const idle = this._spec.idleRpm;
    const span = Math.max(500, this._spec.redlineRpm - idle);
    const n0 = this._revScript[0]?.from ?? 0.16;
    this._rpm = idle + span * n0;
    this._gear = 1;
    this._prevGear = 1;
    this._driveState = 'pull';
    this._shifting = false;
    this._effort = 1;
    this._effortHold = 1.2;
    return true;
  }

  get rpm() { return this._rpmDisplay ?? this._rpm; }
  get gearIndex() { return this._gear; }
  get gearCount() { return GEAR_COUNT; }
  get driveState() { return this._driveState; }
  get load() { return this._load; }
  get boost() { return this._boost; }
  get vtec() { return this._vtec; }
}
