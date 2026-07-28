/* ============================================================================
   VESSEL RUNTIME — AudioWorklet @ 48 kHz (ship + Lab).

   v3.0 Spec: vessel/vessel-architecture-v3.md
     Modular Parallel Summing — three isolated buses → master tanh
       1) Sub & Body bus     — f ≲ 300 Hz, strict LPF ~250 Hz
       2) Exhaust Pulse bus  — lope / fire / mid partials, LPF ~1200 Hz
       3) Noise bus          — permanently 0 (no grit / hiss / rasp)
     Global Transmission: gear k-rate → volume scale before master clip
     Global HF kill (final stage): brickwall LPF @ 1800 Hz + notch @ 3 kHz (−18 dB)
     Optional Waveguide exhaust bus (DasEtwas/Baldan) — synthesis.waveguide

   Prior layers retained as bus *sources* (not monolithic mix):
     · VSL half-order harmonic bank (split by partial frequency into buses)
     · Combustion pressure envelope (pulse bus only)
     · v2 organic: load lag, timing LFO, per-fire amp (no noise pops)

   Rollback: js/vessel-runtime.worklet.pre-waveguide-backup.js
            js/vessel-runtime.worklet.pre-v3-backup.js
   Deterministic seeded PRNG. No neural nets.
   ============================================================================ */
const PI_OVER_360 = Math.PI / 360;
const TWO_PI = Math.PI * 2;
const SPEC_ALPHA = 1.9;
const SPEC_BETA0 = 1.35;
const MOD_TABLE = 1024;

/** Sub-bus hard ceiling (Hz) — pure low-end mass */
const SUB_LP_HZ = 250;
const SUB_PARTIAL_MAX_HZ = 300;
/** Pulse-bus hard ceiling (Hz) — mid-low exhaust / lope */
const PULSE_LP_HZ = 1200;
const PULSE_PARTIAL_MAX_HZ = 1200;

/** Parallel bus mix gains (v3 master sum) */
const GAIN_SUB = 1.3;
const GAIN_PULSE = 0.7;
const GAIN_NOISE = 0.0;

/** Final-stage HF kill — brickwall LPF + presence notch */
const MASTER_BRICK_LP_HZ = 1800;
const MASTER_NOTCH_HZ = 3000;
const MASTER_NOTCH_Q = 1.5;
const MASTER_NOTCH_DB = -18;

/**
 * Hybrid Classic↔VESSEL stability (enable via synthesis.hybridStability, default ON).
 * A) Smooth RPM/load  B) Sub HPF floor  C) Global LPF ceiling
 * D) Anti-static: filter-coeff smooth (zipper) + soft fire + noise hard-gate
 */
const GLOBAL_MAX_LPF = 1800;
const SUB_HPF_HZ = 30;
const SUB_MIN_HZ = 30;
/** RPM/load smoothing time constant (seconds) when hybridStability */
const HYBRID_RPM_TAU = 0.028;
const HYBRID_LOAD_TAU = 0.035;
/** Filter cutoff smoothing — kills radio-tuner zipper */
const FILTER_CUT_TAU = 0.014;
/** Soft fire min attack (ms) — bandlimited-ish combustion */
const FIRE_MIN_ATK_MS = 0.45;

/**
 * One-pole low-pass state helper (per-bus isolated).
 * y += (1-a)*(x-y)  with a = exp(-2π f / sr)
 */
function onePoleCoeff(hz, sr) {
  const f = Math.min(Math.max(hz, 1), sr * 0.45);
  return Math.exp(-TWO_PI * f / sr);
}

/* AUTO-GENERATED from js/dsp/waveguide.js — do not edit by hand.
 * node vessel/tools/embed-waveguide.mjs
 * MIT lineage: DasEtwas/enginesound + Antonio-R1 (Baldan 2015)
 */



const SPEED_OF_SOUND = 343; // m/s
const WAVEGUIDE_MAX_AMP = 20;

/** Convert tube length (meters, one-way) to delay samples at sampleRate. */
function metersToSamples(meters, sampleRate, roundTrip = false) {
  const t = Math.max(0, meters) / SPEED_OF_SOUND;
  const sec = roundTrip ? 2 * t : t;
  return Math.max(2, Math.min(8192, Math.round(sec * sampleRate)));
}

/** Convert delay seconds → samples. */
function secondsToSamples(sec, sampleRate) {
  return Math.max(2, Math.min(8192, Math.round(Math.max(0, sec) * sampleRate)));
}

class LoopBuffer {
  constructor(len) {
    this.data = new Float32Array(Math.max(2, len | 0));
    this.pos = 0;
  }

  push(v) {
    this.data[this.pos % this.data.length] = v;
  }

  pop() {
    return this.data[(this.pos + 1) % this.data.length];
  }

  advance() {
    this.pos++;
  }

  clear() {
    this.data.fill(0);
    this.pos = 0;
  }

  resize(len) {
    const n = Math.max(2, len | 0);
    if (n === this.data.length) return;
    const next = new Float32Array(n);
    const copy = Math.min(n, this.data.length);
    next.set(this.data.subarray(0, copy));
    // fade-fill remainder to reduce resize clicks (DasEtwas)
    if (copy < n && copy > 0) {
      const a = this.data[copy - 1];
      const b = this.data[0];
      for (let i = copy; i < n; i++) {
        next[i] = a + (b - a) * ((i - copy) / (n - copy));
      }
    }
    this.data = next;
    this.pos = 0;
  }
}

class DelayLine {
  constructor(len) {
    this.samples = new LoopBuffer(len);
  }
  pop() { return this.samples.pop(); }
  push(v) { this.samples.push(v); }
  advance() { this.samples.advance(); }
  clear() { this.samples.clear(); }
  setLength(len) { this.samples.resize(len); }
}

/**
 * Bidirectional waveguide (DasEtwas pop/push semantics).
 * alpha end → first return of pop; beta end → second.
 */
class WaveGuide {
  constructor(delaySamples, alpha = 0.01, beta = 0.01) {
    const d = Math.max(2, delaySamples | 0);
    this.chamber0 = new DelayLine(d);
    this.chamber1 = new DelayLine(d);
    this.alpha = alpha;
    this.beta = beta;
    this._c0 = 0;
    this._c1 = 0;
  }

  static dampen(sample) {
    const a = Math.abs(sample);
    if (a > WAVEGUIDE_MAX_AMP) {
      const s = sample >= 0 ? 1 : -1;
      return {
        y: s * (-1 / (a - WAVEGUIDE_MAX_AMP + 1) + 1 + WAVEGUIDE_MAX_AMP),
        dampened: true,
      };
    }
    return { y: sample, dampened: false };
  }

  pop() {
    const a = WaveGuide.dampen(this.chamber1.pop());
    const b = WaveGuide.dampen(this.chamber0.pop());
    this._c1 = a.y;
    this._c0 = b.y;
    return {
      alphaOut: this._c1 * (1 - Math.abs(this.alpha)),
      betaOut: this._c0 * (1 - Math.abs(this.beta)),
      dampened: a.dampened || b.dampened,
    };
  }

  push(x0, x1) {
    const c0In = this._c1 * this.alpha + x0;
    const c1In = this._c0 * this.beta + x1;
    this.chamber0.push(c0In);
    this.chamber1.push(c1In);
    this.chamber0.advance();
    this.chamber1.advance();
  }

  clear() {
    this.chamber0.clear();
    this.chamber1.clear();
    this._c0 = 0;
    this._c1 = 0;
  }

  setDelay(samples) {
    this.chamber0.setLength(samples);
    this.chamber1.setLength(samples);
  }
}

class OnePoleLP {
  constructor(freqHz, sampleRate) {
    this.setFreq(freqHz, sampleRate);
    this.last = 0;
  }

  setFreq(freqHz, sampleRate) {
    const f = Math.max(1, Math.min(freqHz, sampleRate * 0.45));
    const dt = 1 / sampleRate;
    this.alpha = (2 * Math.PI * dt * f) / (2 * Math.PI * dt * f + 1);
  }

  filter(x) {
    this.last += this.alpha * (x - this.last);
    return this.last;
  }

  clear() {
    this.last = 0;
  }
}

function intakeValve(x) {
  if (x > 0 && x < 0.25) return Math.sin(x * 4 * Math.PI);
  return 0;
}

function exhaustValve(x) {
  if (x > 0.75 && x < 1) return -Math.sin(x * 4 * Math.PI);
  return 0;
}

function pistonMotion(x) {
  return Math.cos(x * 4 * Math.PI);
}

function fuelIgnition(x, ignTime) {
  const t = Math.max(0.02, Math.min(0.4, ignTime));
  // DasEtwas: ignition around TDC after 0.5
  if (x > 0.5 && x < 0.5 + t * 0.5) {
    return Math.sin(2 * Math.PI * ((x - 0.5) / t));
  }
  return 0;
}

/**
 * Compact multi-cylinder waveguide engine (exhaust-focused for TAS cabin).
 * Returns mono exhaust (+ optional intake/vib for host mix).
 */
class CompactWaveguideEngine {
  /**
   * @param {object} opts
   * @param {number} sampleRate
   */
  constructor(opts, sampleRate) {
    this.sr = sampleRate || 48000;
    this.noise = 0;
    this._noiseState = 1;
    this.configure(opts || {});
  }

  /** Seeded-ish LCG noise (-1..1) */
  _noise() {
    this._noiseState = (this._noiseState * 1664525 + 1013904223) >>> 0;
    return this._noiseState / 2147483648 - 1;
  }

  configure(opts) {
    const o = opts || {};
    this.enabled = o.enabled !== false && o.waveguide !== false;
    this.nCyl = Math.max(1, Math.min(12, o.cylinders | 0 || 8));
    this.exhaustVol = o.exhaustVolume != null ? o.exhaustVolume : 0.55;
    this.intakeVol = o.intakeVolume != null ? o.intakeVolume : 0.0;
    this.vibVol = o.engineVibrationsVolume != null ? o.engineVibrationsVolume : 0.04;
    this.intakeNoiseFactor = o.intakeNoiseFactor != null ? o.intakeNoiseFactor : 0.0;
    this.pistonFactor = o.pistonMotionFactor != null ? o.pistonMotionFactor : 2.2;
    this.ignitionFactor = o.ignitionFactor != null ? o.ignitionFactor : 4.5;
    this.ignitionTime = o.ignitionTime != null ? o.ignitionTime : 0.06;
    this.intakeValveShift = o.intakeValveShift || 0;
    this.exhaustValveShift = o.exhaustValveShift || 0;
    this.crankFluct = o.crankshaftFluctuation != null ? o.crankshaftFluctuation : 0.12;
    this.master = o.master != null ? o.master : 0.35;

    // Reflections
    const iOpen = o.intakeOpenRefl != null ? o.intakeOpenRefl : 0.01;
    const iClosed = o.intakeClosedRefl != null ? o.intakeClosedRefl : 0.95;
    const eOpen = o.exhaustOpenRefl != null ? o.exhaustOpenRefl : 0.01;
    const eClosed = o.exhaustClosedRefl != null ? o.exhaustClosedRefl : 0.75;

    // Geometry → delay samples (meters preferred; fall back to seconds)
    const intakeM = o.intakeLenM != null ? o.intakeLenM : 0.35;
    const exhaustM = o.exhaustLenM != null ? o.exhaustLenM : 0.55;
    const extractM = o.extractorLenM != null ? o.extractorLenM : 0.4;
    const pipeM = o.straightPipeLenM != null ? o.straightPipeLenM : 1.1;
    const mufflerAction = o.mufflerAction != null ? o.mufflerAction : 0.12;

    const dIn = o.intakeDelaySec != null
      ? secondsToSamples(o.intakeDelaySec, this.sr)
      : metersToSamples(intakeM, this.sr, false);
    const dEx = o.exhaustDelaySec != null
      ? secondsToSamples(o.exhaustDelaySec, this.sr)
      : metersToSamples(exhaustM, this.sr, false);
    const dExt = o.extractorDelaySec != null
      ? secondsToSamples(o.extractorDelaySec, this.sr)
      : metersToSamples(extractM, this.sr, false);
    const dPipe = o.pipeDelaySec != null
      ? secondsToSamples(o.pipeDelaySec, this.sr)
      : metersToSamples(pipeM, this.sr, false);

    // Crank offsets: from fireAngles (0..720) or equal space
    let offsets = o.crankOffsets;
    if (!offsets || !offsets.length) {
      offsets = [];
      for (let i = 0; i < this.nCyl; i++) offsets.push(i / this.nCyl);
    }

    this.cylinders = [];
    for (let i = 0; i < this.nCyl; i++) {
      const off = offsets[i % offsets.length];
      this.cylinders.push({
        crankOffset: off,
        exhaust: new WaveGuide(dEx, eClosed, 0.05),
        intake: new WaveGuide(dIn, iClosed, -0.6),
        extractor: new WaveGuide(dExt, 0.0, -0.001),
        intakeOpen: iOpen,
        intakeClosed: iClosed,
        exhaustOpen: eOpen,
        exhaustClosed: eClosed,
        extractorEx: 0,
        cylSound: 0,
      });
    }

    this.straightPipe = new WaveGuide(dPipe, 0.06, 0.002);
    // Parallel muffler (4 elements, slight length spread)
    this.muffler = [];
    const baseMuff = Math.max(4, Math.round(dPipe * 0.04));
    for (let i = 0; i < 4; i++) {
      this.muffler.push(new WaveGuide(baseMuff + i * 3, 0.0, -mufflerAction));
    }

    this.intakeNoiseLp = new OnePoleLP(11000, this.sr);
    this.crankFluctLp = new OnePoleLP(12, this.sr);
    this.vibLp = new OnePoleLP(90, this.sr);
    this.exhaustLp = new OnePoleLP(o.exhaustLpfHz != null ? o.exhaustLpfHz : 1350, this.sr);
    this.dcLp = new OnePoleLP(20, this.sr);

    this.exhaustCollector = 0;
    this.intakeCollector = 0;
    this.crankPos = 0;
  }

  reset() {
    for (const c of this.cylinders) {
      c.exhaust.clear();
      c.intake.clear();
      c.extractor.clear();
      c.extractorEx = 0;
      c.cylSound = 0;
    }
    this.straightPipe.clear();
    for (const m of this.muffler) m.clear();
    this.intakeNoiseLp.clear();
    this.crankFluctLp.clear();
    this.vibLp.clear();
    this.exhaustLp.clear();
    this.dcLp.clear();
    this.exhaustCollector = 0;
    this.intakeCollector = 0;
    this.crankPos = 0;
  }

  /**
   * One sample.
   * @param {number} rpm
   * @param {number} load 0..1 — scales ignition / noise
   * @param {number} [crank01] optional external crank 0..1 (else internal integrate)
   * @returns {{ exhaust:number, intake:number, vib:number, mix:number, dampened:boolean }}
   */
  process(rpm, load = 0.5, crank01 = null) {
    if (!this.enabled) {
      return { exhaust: 0, intake: 0, vib: 0, mix: 0, dampened: false };
    }

    const L = Math.max(0, Math.min(1, load));
    const nCyl = this.cylinders.length;
    const inv = 1 / nCyl;

    if (crank01 == null) {
      this.crankPos = (this.crankPos + (rpm / (this.sr * 120))) % 1;
    } else {
      this.crankPos = ((crank01 % 1) + 1) % 1;
    }

    const fluct = this.crankFluctLp.filter(this._noise()) * this.crankFluct;
    const crankBase = (this.crankPos + fluct + 1) % 1;

    const intakeNoise =
      this.intakeNoiseLp.filter(this._noise()) * this.intakeNoiseFactor * (0.3 + 0.7 * L);

    let vib = 0;
    let dampened = false;
    const lastEx = this.exhaustCollector * inv;
    this.exhaustCollector = 0;
    this.intakeCollector = 0;

    // POP
    for (const cyl of this.cylinders) {
      const crank = (crankBase + cyl.crankOffset) % 1;
      const ign = fuelIgnition(crank, this.ignitionTime) * (0.55 + 0.45 * L);
      cyl.cylSound =
        pistonMotion(crank) * this.pistonFactor + ign * this.ignitionFactor;

      const exV = exhaustValve((crank + this.exhaustValveShift + 1) % 1);
      const inV = intakeValve((crank + this.intakeValveShift + 1) % 1);
      cyl.exhaust.alpha =
        cyl.exhaustClosed + (cyl.exhaustOpen - cyl.exhaustClosed) * Math.abs(exV);
      cyl.intake.alpha =
        cyl.intakeClosed + (cyl.intakeOpen - cyl.intakeClosed) * inV;

      const ex = cyl.exhaust.pop();
      const inn = cyl.intake.pop();
      const ext = cyl.extractor.pop();
      dampened = dampened || ex.dampened || inn.dampened || ext.dampened;
      cyl.extractorEx = ext.alphaOut;
      cyl.extractor.push(ex.betaOut, lastEx);

      this.intakeCollector += inn.betaOut;
      this.exhaustCollector += ext.betaOut;
      vib += cyl.cylSound;
    }

    const pipe = this.straightPipe.pop();
    dampened = dampened || pipe.dampened;

    let muffA = 0;
    let muffB = 0;
    for (const m of this.muffler) {
      const r = m.pop();
      muffA += r.alphaOut;
      muffB += r.betaOut;
      dampened = dampened || r.dampened;
    }
    const nM = this.muffler.length || 1;

    // PUSH
    for (const cyl of this.cylinders) {
      const crank = (crankBase + cyl.crankOffset) % 1;
      const inV = intakeValve((crank + this.intakeValveShift + 1) % 1);
      const exIn = (1 - Math.abs(cyl.exhaust.alpha)) * cyl.cylSound * 0.5;
      const inIn = (1 - Math.abs(cyl.intake.alpha)) * cyl.cylSound * 0.5;
      cyl.exhaust.push(exIn, cyl.extractorEx);
      cyl.intake.push(
        inIn,
        this.intakeCollector * inv + intakeNoise * inV
      );
    }

    this.straightPipe.push(this.exhaustCollector, muffA);
    this.exhaustCollector += pipe.alphaOut;

    for (const m of this.muffler) {
      m.push(pipe.betaOut / nM, 0);
    }

    vib = this.vibLp.filter(vib);
    let exhaust = this.exhaustLp.filter(muffB);
    let intake = this.intakeCollector;

    // Scale + soft master
    exhaust *= this.exhaustVol * (0.4 + 0.6 * L);
    intake *= this.intakeVol;
    vib *= this.vibVol;

    let mix = (intake + vib + exhaust) * this.master;
    mix -= this.dcLp.filter(mix);

    // Safety soft limit
    if (mix > 1.2) mix = 1.2;
    if (mix < -1.2) mix = -1.2;

    return { exhaust, intake, vib, mix, dampened };
  }
}




class VesselRuntime extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm',  defaultValue: 850, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0,   minValue: 0, maxValue: 1,     automationRate: 'k-rate' },
      { name: 'gear', defaultValue: 1,   minValue: 1, maxValue: 8,     automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this.profile = null;
    this.crankDeg = 0;
    this.textureGain = 0.05; // unused on noise bus (kept for host API parity)
    this.softPulseMs = 1.8;
    this.pulseSharpness = 0.35;
    this.residualNoise = 0;
    this.cabinCutHz = 1400;
    this.tipInGain = 0.14;
    this.overrunTilt = 0.22;
    this.drive = 0.35;
    this.tipIn = 0;
    this.overrun = 0;
    this.organicV2 = true;
    this.combustionRand = 0.03;
    this.loadLag = 0.12;
    this.timingJitterDeg = 0.35;
    /** Host shift mute / transmission scale (1 = full) */
    this.txScale = 1;
    this._seed = 1;
    // Waveguide exhaust bus (optional — DasEtwas lineage) — soft disable anytime
    this.waveguideEnabled = false;
    this.waveguideGain = 0.28;
    this.wgOpts = null;
    this.wg = null;
    /** Hybrid stability: Classic-like smooth params + hard HF/sub floors (default on) */
    this.hybridStability = true;
    this.rpmSmoothed = null;
    this.loadParamSmoothed = null;
    this.globalMaxLpf = GLOBAL_MAX_LPF;
    this.subHpfHz = SUB_HPF_HZ;
    /** Perf self-throttle: cap active partials (0 = uncapped/full; e.g. 16 on Tesla/lite).
     *  Set by host from control.global.perf via processorOptions/port — CPU only, no NaN risk
     *  (never touches sampleRate). Fewer partials on the per-sample Chebyshev bank = big MCU2 win. */
    this.perfMaxPartials = 0;
    /** Anti-static / anti-alias radio swish (default ON with hybridStability) */
    this.antiStatic = true;
    this._pulseCutSm = null;
    this._subCutSm = null;
    this._brickCutSm = null;
    this._fireEnvSm = 0;
    this._gearScaleSm = 1;

    // Combustion envelope (pulse bus only)
    this.fireEnv = 0;
    this.firePhase = 0;
    this.fireActive = false;
    this.fireAmpMod = 1;

    // Isolated multi-pole LPF state per bus (3 cascaded one-poles each)
    this.subLp = [0, 0, 0];
    this.pulseLp = [0, 0, 0];
    // Sub bus: phase-locked sine + simple HPF (anti-rumble)
    this.phaseSub = 0;
    this._hpfX1 = 0;
    this._hpfY = 0;
    this._hpfA = 0;
    this._hpfHz = -1;
    // Master brickwall LPF (4× one-pole) + peaking notch
    this._brickLp = [0, 0, 0, 0];
    this._brickA = 0;
    this._brickHz = -1;
    this._notchX1 = 0; this._notchX2 = 0;
    this._notchY1 = 0; this._notchY2 = 0;
    this._notchB0 = 1; this._notchB1 = 0; this._notchB2 = 0;
    this._notchA1 = 0; this._notchA2 = 0;
    this._notchReady = false;

    this.loadSmooth = 0;
    this.timingPh1 = 0;
    this.timingPh2 = 0;
    this.modTable = null;
    this.modPhase = 0;

    this.eventAmp = 1;
    this.huntPhase = 0;

    if (options && options.processorOptions) {
      const o = options.processorOptions;
      this._applySynthOpts(o);
      if (o.profile) this.setProfile(o.profile);
    }
    this.port.onmessage = (e) => {
      if (e.data.profile) this.setProfile(e.data.profile);
      this._applySynthOpts(e.data);
      if (e.data.tipIn != null) this.tipIn = e.data.tipIn;
      if (e.data.overrun != null) this.overrun = e.data.overrun;
      if (e.data.txScale != null) this.txScale = e.data.txScale;
    };
  }

  _applySynthOpts(o) {
    if (!o) return;
    if (o.textureGain != null) this.textureGain = o.textureGain;
    if (o.softPulseMs != null) this.softPulseMs = o.softPulseMs;
    if (o.pulseSharpness != null) this.pulseSharpness = o.pulseSharpness;
    if (o.residualNoise != null) this.residualNoise = 0; // v3: noise bus always 0
    if (o.cabinCutHz != null) this.cabinCutHz = o.cabinCutHz;
    if (o.tipInGain != null) this.tipInGain = o.tipInGain;
    if (o.overrunTilt != null) this.overrunTilt = o.overrunTilt;
    if (o.drive != null) this.drive = o.drive;
    if (o.organicV2 != null) this.organicV2 = !!o.organicV2;
    if (o.combustionRand != null) this.combustionRand = o.combustionRand;
    if (o.loadLag != null) this.loadLag = o.loadLag;
    if (o.timingJitterDeg != null) this.timingJitterDeg = o.timingJitterDeg;
    if (o.txScale != null) this.txScale = o.txScale;
    // Feature toggles (soft enable/disable — no file restore needed)
    if (o.waveguide != null) this.waveguideEnabled = !!o.waveguide;
    if (o.waveguideGain != null) this.waveguideGain = +o.waveguideGain;
    if (o.waveguideOpts) this.wgOpts = o.waveguideOpts;
    if (o.waveguide != null || o.waveguideOpts || o.waveguideGain != null) {
      if (this.waveguideEnabled) this._rebuildWaveguide();
      else this.wg = null;
    }
    if (o.resetWaveguide && this.wg) this.wg.reset();
    if (o.hybridStability != null) this.hybridStability = !!o.hybridStability;
    if (o.globalMaxLpf != null) this.globalMaxLpf = Math.max(400, +o.globalMaxLpf);
    if (o.subHpfHz != null) this.subHpfHz = Math.max(10, +o.subHpfHz);
    if (o.antiStatic != null) this.antiStatic = !!o.antiStatic;
    if (o.perfMaxPartials != null) this.perfMaxPartials = Math.max(0, o.perfMaxPartials | 0);
  }

  /** Active partial count = profile N, capped by perf tier (lite). */
  _effectiveN() {
    const cap = this.perfMaxPartials;
    return cap > 0 && cap < this.N ? cap : this.N;
  }

  _buildModTable() {
    const t = new Float32Array(MOD_TABLE);
    let y = 0;
    for (let i = 0; i < MOD_TABLE; i++) {
      const w = this.rnd() * 2 - 1;
      y = y * 0.92 + w * 0.08;
      t[i] = y;
    }
    let peak = 1e-6;
    for (let i = 0; i < MOD_TABLE; i++) peak = Math.max(peak, Math.abs(t[i]));
    for (let i = 0; i < MOD_TABLE; i++) t[i] /= peak;
    this.modTable = t;
    this.modPhase = 0;
  }

  setProfile(p) {
    this.profile = p;
    const s = p.synth;
    this.N = s.N;
    this.K = s.rpmBreakpoints.length;
    this.J = s.loadLevels.length;
    this.firesPerRev = s.firesPerRev || 4;
    this.iSin = new Float32Array(this.N);
    this.iCos = new Float32Array(this.N);
    this.harmRoll = new Float32Array(this.N);
    this._seed = (p.seed >>> 0) || 1;
    this.crankDeg = 0;
    this.fireEnv = 0; this.firePhase = 0; this.fireActive = false; this.fireAmpMod = 1;
    this.subLp[0] = this.subLp[1] = this.subLp[2] = 0;
    this.pulseLp[0] = this.pulseLp[1] = this.pulseLp[2] = 0;
    this.phaseSub = 0;
    this._hpfX1 = 0;
    this._hpfY = 0;
    this._hpfHz = -1;
    this._brickLp[0] = this._brickLp[1] = this._brickLp[2] = this._brickLp[3] = 0;
    this._brickHz = -1;
    this._notchX1 = 0; this._notchX2 = 0;
    this._notchY1 = 0; this._notchY2 = 0;
    this._notchReady = false;
    this.loadSmooth = 0;
    this.timingPh1 = 0; this.timingPh2 = 0;
    this.eventAmp = 1; this.huntPhase = 0;
    this._buildModTable();

    const bp = s.rpmBreakpoints;
    this.redline = (bp && bp.length) ? bp[bp.length - 1] : 7000;

    const src = p.aux && p.aux.source;
    this.fireAngles = (src && src.fireAngles) ? Float32Array.from(src.fireAngles) : new Float32Array(0);
    this._rebuildWaveguideFromProfile(p);
    if (src && src.softPulseMs != null) this.softPulseMs = src.softPulseMs;
    if (src && src.pulseSharpness != null) this.pulseSharpness = src.pulseSharpness;

    const comb = p.aux && p.aux.combustion;
    if (comb && comb.rand != null) this.combustionRand = comb.rand;
    const idle = (p.aux && p.aux.idle) || {};
    if (idle.combustionRand != null) this.combustionRand = idle.combustionRand;

    // v3: formant / noise banks not used on audio path (noise bus = 0)
    this.B = 0;

    this.idleRpm = idle.idleRpm || 800;
    this.idleImb = idle.imbalance || 0;
    this.misfire = idle.misfireProb || 0;
    this.huntHz = idle.huntHz || 5;
    this.huntDepth = idle.huntDepth || 0;

    const tr = (p.aux && p.aux.transient) || {};
    this.tipInLead = tr.tipinLead != null ? tr.tipinLead : 0.4;
    this.overrunBackfire = 0; // v3: no noise pops
  }

  rnd() {
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    return this._seed / 4294967296;
  }

  _mod(rateHz, dt) {
    if (!this.modTable) return 0;
    this.modPhase += rateHz * dt * MOD_TABLE;
    if (this.modPhase >= MOD_TABLE) this.modPhase -= MOD_TABLE;
    if (this.modPhase < 0) this.modPhase += MOD_TABLE;
    const i = this.modPhase | 0;
    const f = this.modPhase - i;
    const a = this.modTable[i];
    const b = this.modTable[(i + 1) & (MOD_TABLE - 1)];
    return a + (b - a) * f;
  }

  _spectralEnv(p, rpm, loadEff) {
    const red = this.redline || 7000;
    const beta = SPEC_BETA0 + loadEff * 0.45 + Math.max(0, (rpm / red) - 0.4) * 0.8;
    const pow = Math.pow(p, -SPEC_ALPHA);
    const expk = Math.exp(-beta * p * (rpm / red));
    const fApprox = p * (rpm / 120);
    // Hard kill anything that cannot feed either bus cleanly
    if (fApprox > PULSE_PARTIAL_MAX_HZ) return 0;
    let roll = pow * expk;
    if (fApprox > 900) {
      roll *= Math.max(0, 1.0 - (fApprox - 900) / 300);
    }
    return roll;
  }

  _interpolate(rpm, loadEff) {
    const s = this.profile.synth, N = this._effectiveN(), K = this.K, J = this.J;
    const bp = s.rpmBreakpoints, lv = s.loadLevels, cs = s.coefSin, cc = s.coefCos;
    let k0 = 0; while (k0 < K - 2 && rpm > bp[k0 + 1]) k0++;
    const k1 = Math.min(K - 1, k0 + 1);
    let fr = (rpm - bp[k0]) / ((bp[k1] - bp[k0]) || 1);
    fr = fr < 0 ? 0 : fr > 1 ? 1 : fr;
    let j0 = 0, j1 = 0, fl = 0;
    if (J > 1) {
      while (j0 < J - 2 && loadEff > lv[j0 + 1]) j0++;
      j1 = Math.min(J - 1, j0 + 1);
      fl = (loadEff - lv[j0]) / ((lv[j1] - lv[j0]) || 1);
      fl = fl < 0 ? 0 : fl > 1 ? 1 : fl;
    }
    const bil = (v00, v10, v01, v11) =>
      (v00 * (1 - fr) + v10 * fr) * (1 - fl) + (v01 * (1 - fr) + v11 * fr) * fl;
    const hIdx = (m, k, j) => (m * K + k) * J + j;

    const bodyBreath = this.organicV2 ? (1 + 0.14 * loadEff) : 1;
    const midBreath = this.organicV2 ? (1 + 0.05 * loadEff) : 1;

    for (let m = 0; m < N; m++) {
      const p = m + 1;
      const fApprox = p * (rpm / 120);
      const roll = this._spectralEnv(p, rpm, loadEff);
      // Prefer body on low partials feeding the sub bus
      const bodyW = fApprox <= SUB_PARTIAL_MAX_HZ ? bodyBreath : midBreath;
      this.harmRoll[m] = roll * bodyW;
      this.iSin[m] = bil(
        cs[hIdx(m, k0, j0)], cs[hIdx(m, k1, j0)],
        cs[hIdx(m, k0, j1)], cs[hIdx(m, k1, j1)]
      ) * this.harmRoll[m];
      this.iCos[m] = bil(
        cc[hIdx(m, k0, j0)], cc[hIdx(m, k1, j0)],
        cc[hIdx(m, k0, j1)], cc[hIdx(m, k1, j1)]
      ) * this.harmRoll[m];
    }
  }

  /** Master soft clip (normalized tanh) */
  _tanhSoftClip(x, driveBoost) {
    const d = Math.max(0, (this.drive || 0) + (driveBoost || 0));
    const k = 1 + d * 5.5;
    const y = Math.tanh(x * k);
    const nrm = Math.tanh(k);
    return nrm > 1e-6 ? y / nrm : y;
  }

  /**
   * Global hard LPF — 4 cascaded one-poles ≈ steep “brickwall” before output.
   * Kills residual presence / rasp above cut (default 1800 Hz).
   */
  _applyBrickwallLowPass(x, hz) {
    const cut = hz != null ? hz : MASTER_BRICK_LP_HZ;
    if (this._brickHz !== cut) {
      this._brickHz = cut;
      this._brickA = onePoleCoeff(cut, sampleRate);
    }
    const a = this._brickA;
    const s = this._brickLp;
    s[0] = x + a * (s[0] - x);
    s[1] = s[0] + a * (s[1] - s[0]);
    s[2] = s[1] + a * (s[2] - s[1]);
    s[3] = s[2] + a * (s[3] - s[2]);
    return s[3];
  }

  /**
   * Peaking notch — cuts harsh 2.5–4 kHz “แบร๊ด” band.
   * RBJ peaking EQ with negative dB (default 3000 Hz, Q=1.5, −18 dB).
   */
  _applyNotchFilter(x, freq, Q, dB) {
    if (!this._notchReady) {
      const f0 = freq != null ? freq : MASTER_NOTCH_HZ;
      const q = Q != null ? Q : MASTER_NOTCH_Q;
      const gainDb = dB != null ? dB : MASTER_NOTCH_DB;
      const sr = sampleRate;
      const w0 = TWO_PI * Math.min(f0, sr * 0.45) / sr;
      const cosw = Math.cos(w0);
      const sinw = Math.sin(w0);
      const alpha = sinw / (2 * Math.max(0.05, q));
      const A = Math.pow(10, gainDb / 40);
      const b0 = 1 + alpha * A;
      const b1 = -2 * cosw;
      const b2 = 1 - alpha * A;
      const a0 = 1 + alpha / A;
      const a1 = -2 * cosw;
      const a2 = 1 - alpha / A;
      this._notchB0 = b0 / a0;
      this._notchB1 = b1 / a0;
      this._notchB2 = b2 / a0;
      this._notchA1 = a1 / a0;
      this._notchA2 = a2 / a0;
      this._notchReady = true;
    }
    const y =
      this._notchB0 * x +
      this._notchB1 * this._notchX1 +
      this._notchB2 * this._notchX2 -
      this._notchA1 * this._notchY1 -
      this._notchA2 * this._notchY2;
    this._notchX2 = this._notchX1;
    this._notchX1 = x;
    this._notchY2 = this._notchY1;
    this._notchY1 = y;
    return y;
  }

  /** 3× cascaded one-pole on isolated bus state array */
  _busLPF(state, x, a) {
    state[0] = x + a * (state[0] - x);
    state[1] = state[0] + a * (state[1] - state[0]);
    state[2] = state[1] + a * (state[2] - state[1]);
    return state[2];
  }

  _updateFireEnv(fired, dt, pulseSharpBoost) {
    const totalMs = Math.max(0.6, this.softPulseMs || 1.8);
    const sharp = Math.max(0.05, Math.min(1,
      (this.pulseSharpness != null ? this.pulseSharpness : 0.35) + (pulseSharpBoost || 0)));
    // Anti-static: longer min attack → less HF foldover than Dirac / hard step
    const minAtk = this.antiStatic !== false ? FIRE_MIN_ATK_MS : 0.15;
    const atkMs = Math.max(minAtk, totalMs * (0.28 - sharp * 0.15));
    const decMs = Math.max(0.5, totalMs - atkMs);
    if (fired) {
      this.fireActive = true;
      this.firePhase = 0;
      if (this.organicV2) {
        const sig = Math.max(0.005, Math.min(0.08, this.combustionRand || 0.03));
        const n = this._mod(0.7, 0.02) * 0.6 + (this.rnd() * 2 - 1) * 0.4;
        this.fireAmpMod = 1 + n * sig * 2.2;
        if (this.fireAmpMod < 0.75) this.fireAmpMod = 0.75;
        if (this.fireAmpMod > 1.25) this.fireAmpMod = 1.25;
      } else {
        this.fireAmpMod = 1;
      }
    }
    if (!this.fireActive) {
      this.fireEnv = 0;
      return 0;
    }
    this.firePhase += dt;
    const tMs = this.firePhase * 1000;
    let env;
    if (tMs < atkMs) {
      const u = tMs / atkMs;
      env = u * u * (3 - 2 * u);
    } else {
      env = Math.exp(-(tMs - atkMs) / decMs);
    }
    if (env < 1e-4) {
      this.fireActive = false;
      env = 0;
    }
    this.fireEnv = env * this.fireAmpMod;
    return this.fireEnv;
  }

  /**
   * Simple one-pole HPF — strips sub-audible rumble / DC (e.g. 30 Hz floor).
   * y[n] = α · (y[n−1] + x[n] − x[n−1])
   */
  _applySimpleHPF(x, hz) {
    const sr = sampleRate;
    if (this._hpfHz !== hz) {
      this._hpfHz = hz;
      const rc = 1 / (TWO_PI * Math.max(1, hz));
      const dt = 1 / sr;
      this._hpfA = rc / (rc + dt);
    }
    const a = this._hpfA;
    this._hpfY = a * (this._hpfY + x - this._hpfX1);
    this._hpfX1 = x;
    return this._hpfY;
  }

  _rebuildWaveguideFromProfile(p) {
    const aux = (p && p.aux) || {};
    const src = aux.source || {};
    const pipe = aux.pipe || aux.geometry || {};
    let offsets = null;
    if (this.fireAngles && this.fireAngles.length) {
      offsets = Array.from(this.fireAngles).map((a) => (((a % 720) + 720) % 720) / 720);
    }
    const nCyl = offsets && offsets.length
      ? offsets.length
      : (this.firesPerRev ? this.firesPerRev * 2 : 8);
    this.wgOpts = Object.assign({
      enabled: this.waveguideEnabled,
      cylinders: Math.min(12, Math.max(4, nCyl)),
      crankOffsets: offsets,
      intakeLenM: pipe.intakeLenM != null ? pipe.intakeLenM : 0.4,
      exhaustLenM: pipe.exhaustLenM != null ? pipe.exhaustLenM : 0.6,
      extractorLenM: pipe.extractorLenM != null ? pipe.extractorLenM : 0.45,
      straightPipeLenM: pipe.tailpipeLenM != null
        ? pipe.tailpipeLenM
        : (pipe.straightPipeLenM != null ? pipe.straightPipeLenM : 1.0),
      mufflerAction: pipe.mufflerAction != null ? pipe.mufflerAction : 0.14,
      ignitionTime: this.pulseSharpness != null ? 0.04 + this.pulseSharpness * 0.08 : 0.06,
      pistonMotionFactor: 2.1,
      ignitionFactor: 4.2,
      intakeVolume: 0,
      exhaustVolume: 0.65,
      engineVibrationsVolume: 0.03,
      intakeNoiseFactor: 0,
      crankshaftFluctuation: Math.min(0.35, (this.combustionRand || 0.03) * 6),
      exhaustLpfHz: 1280,
      master: 0.4,
    }, this.wgOpts || {});
    this._rebuildWaveguide();
  }

  _rebuildWaveguide() {
    if (typeof CompactWaveguideEngine === 'undefined') {
      this.wg = null;
      return;
    }
    if (!this.waveguideEnabled) {
      this.wg = null;
      return;
    }
    const opts = Object.assign({}, this.wgOpts || {}, { enabled: true });
    this.wg = new CompactWaveguideEngine(opts, sampleRate);
    this.wg.reset();
  }

  // ─── BUS 1: Sub & Body — locked sine, floor 30 Hz, HPF anti-rumble (B) ─
  _processSubBus(rpm, load) {
    const floorHz = this.subHpfHz != null ? this.subHpfHz : SUB_HPF_HZ;
    // 1) Fundamental, never below floor (prevents sub-sonic / “Mario die” hum)
    const targetFreq = Math.max(SUB_MIN_HZ, floorHz, (rpm / 120) * 2);

    // 2) Phase advance (locked) — continuous, no hard jumps
    this.phaseSub = (this.phaseSub + targetFreq / sampleRate) % 1.0;

    // 3) Soft sine, volume tracks load
    let subSignal = Math.sin(this.phaseSub * TWO_PI) * (0.5 + load * 0.5);

    // 4) Strict HPF — strip DC / sub-sonic accumulation
    subSignal = this._applySimpleHPF(subSignal, floorHz);

    return subSignal;
  }

  // ─── BUS 2: Exhaust Pulse / Lope (mid-low, ≤1200 Hz) ──────────────────
  _processPulseBus(partialPulse, fireEnv, loadEff, lope, gearIndex) {
    const loadAmp = 0.28 + 0.72 * loadEff;
    // Soft combustion pressure (not Dirac) rides mid partials
    const camPulse = fireEnv * loadAmp * (1.05 + (gearIndex <= 2 ? 0.08 : 0));
    const raw = (partialPulse * 0.95 + camPulse * 0.55) * lope;
    return this._busLPF(this.pulseLp, raw, this._pulseA);
  }

  // ─── BUS 3: Air / Mechanical Noise — permanently zero ─────────────────
  _processNoiseBus() {
    return 0.0;
  }

  /**
   * Global Transmission volume scale from gear index (1…5).
   * Low gears slightly louder / rawer; tall gears slightly quieter master.
   */
  _gearVolumeScale(gearIndex) {
    const g = Math.max(1, Math.min(8, gearIndex | 0));
    const t = (g - 1) / 4; // 0…1 across 5 gears
    // G1 ≈ 1.10, G5 ≈ 0.92
    return 1.10 - t * 0.18;
  }

  // ─── Master frame: parallel sum → gear scale → tanh ───────────────────
  process(_inputs, outputs, params) {
    const out = outputs[0][0];
    if (!this.profile || !out) return true;

    const n = out.length;
    const sr = sampleRate;
    const N = this._effectiveN();
    const rpmRaw = params.rpm[0];
    const loadRaw = params.load[0];
    const gearIndex = params.gear && params.gear.length ? params.gear[0] : 1;
    const dt = 1 / sr;
    const v2 = this.organicV2;
    const hybrid = this.hybridStability !== false;

    // ── A) Classic-style stability: smooth RPM / host load (no step pops) ──
    // Exponential approach toward AudioParam targets (block-rate, continuous feel)
    if (this.rpmSmoothed == null || !Number.isFinite(this.rpmSmoothed)) this.rpmSmoothed = rpmRaw;
    if (this.loadParamSmoothed == null || !Number.isFinite(this.loadParamSmoothed)) {
      this.loadParamSmoothed = loadRaw;
    }
    const blockSec = n / sr;
    if (hybrid) {
      const aRpm = 1 - Math.exp(-blockSec / HYBRID_RPM_TAU);
      const aLoad = 1 - Math.exp(-blockSec / HYBRID_LOAD_TAU);
      this.rpmSmoothed += (rpmRaw - this.rpmSmoothed) * aRpm;
      this.loadParamSmoothed += (loadRaw - this.loadParamSmoothed) * aLoad;
    } else {
      this.rpmSmoothed = rpmRaw;
      this.loadParamSmoothed = loadRaw;
    }
    const rpm = this.rpmSmoothed;
    const loadHost = this.loadParamSmoothed;

    const lagTau = Math.max(0.02, this.loadLag || 0.12);
    const lagA = Math.exp(-dt / lagTau);

    const tip = this.tipIn || 0;
    const over = this.overrun || 0;
    // Soft organic only when v2 on (no pink pops — already stripped)
    const tipSharpBoost = v2 ? tip * (this.tipInLead || 0.4) * 0.35 : 0;
    const tipDriveBoost = v2 ? tip * 0.18 : 0;
    const overDriveBoost = v2 ? over * 0.05 : 0;

    // Manifold load lag (v2) on top of host-smoothed load
    this.loadSmooth = loadHost + lagA * (this.loadSmooth - loadHost);
    let loadEff = v2 ? this.loadSmooth : loadHost;
    this._interpolate(rpm, loadEff);

    // ── C) Global HF ceiling + zipper-free filter coeffs (smooth cutoffs) ──
    const maxLpf = Math.min(
      this.globalMaxLpf != null ? this.globalMaxLpf : GLOBAL_MAX_LPF,
      GLOBAL_MAX_LPF
    );
    const pulseCutT = Math.min(PULSE_LP_HZ, maxLpf);
    const subCutT = Math.min(SUB_LP_HZ, maxLpf);
    const brickT = Math.min(MASTER_BRICK_LP_HZ, maxLpf);
    const anti = this.antiStatic !== false && hybrid;
    // Never jump one-pole α (radio-tuner zipper) — lag cutoff Hz then recompute α
    if (this._pulseCutSm == null) this._pulseCutSm = pulseCutT;
    if (this._subCutSm == null) this._subCutSm = subCutT;
    if (this._brickCutSm == null) this._brickCutSm = brickT;
    if (anti) {
      const aF = 1 - Math.exp(-blockSec / FILTER_CUT_TAU);
      this._pulseCutSm += (pulseCutT - this._pulseCutSm) * aF;
      this._subCutSm += (subCutT - this._subCutSm) * aF;
      this._brickCutSm += (brickT - this._brickCutSm) * aF;
    } else {
      this._pulseCutSm = pulseCutT;
      this._subCutSm = subCutT;
      this._brickCutSm = brickT;
    }
    this._subA = onePoleCoeff(this._subCutSm, sr);
    this._pulseA = onePoleCoeff(this._pulseCutSm, sr);

    const iSin = this.iSin, iCos = this.iCos;
    const degStepBase = (rpm / 60) * 360 / sr;
    const fa = this.fireAngles;
    const nFire = fa.length;
    // Anti-static: reduce micro-timing jitter (phase FM → swish)
    const tJ = (v2 ? (this.timingJitterDeg || 0.35) : 0) * (anti ? 0.45 : 1);

    const idleFactor = Math.max(0, Math.min(1, (this.idleRpm * 1.8 - rpm) / (this.idleRpm * 0.8)));
    const bodyLift = 1.08 + 0.1 * tip - 0.05 * over + (v2 ? tip * 0.1 * (this.tipInLead || 0.4) : 0);

    // Transmission layer — smooth gear/tx scale (gain zipper)
    const gearScaleT = this._gearVolumeScale(gearIndex) * Math.max(0.15, this.txScale || 1);
    if (this._gearScaleSm == null) this._gearScaleSm = gearScaleT;
    if (anti) {
      const aG = 1 - Math.exp(-blockSec / 0.02);
      this._gearScaleSm += (gearScaleT - this._gearScaleSm) * aG;
    } else {
      this._gearScaleSm = gearScaleT;
    }
    const globalVolumeScale = this._gearScaleSm;

    // Precompute partial → bus routing threshold in Hz terms at this RPM
    const fUnit = rpm / 120; // Hz per half-order partial index
    // Anti-alias: hard cap partials entering pulse path (foldover kill)
    const maxPartialHz = anti ? Math.min(PULSE_PARTIAL_MAX_HZ, maxLpf * 0.92) : PULSE_PARTIAL_MAX_HZ;

    // Fire-env smoother (per-sample applied in loop)
    const fireSmA = anti ? Math.exp(-dt / 0.00035) : 0; // ~0.35 ms

    for (let i = 0; i < n; i++) {
      if (v2) this.loadSmooth = loadHost + lagA * (this.loadSmooth - loadHost);
      loadEff = v2 ? this.loadSmooth : loadHost;

      // Micro timing (organic v2) — phase only, no noise
      this.timingPh1 += TWO_PI * (2.1 + loadEff * 1.4) * dt;
      this.timingPh2 += TWO_PI * (3.7 + loadEff * 0.8) * dt;
      if (this.timingPh1 > TWO_PI) this.timingPh1 -= TWO_PI;
      if (this.timingPh2 > TWO_PI) this.timingPh2 -= TWO_PI;
      const dTheta = tJ * (0.65 * Math.sin(this.timingPh1) + 0.35 * Math.sin(this.timingPh2));

      const prev = this.crankDeg;
      let cd = prev + degStepBase;
      let wrapped = false;
      if (cd >= 720) { cd -= 720; wrapped = true; }
      this.crankDeg = cd;

      let fired = 0;
      for (let f = 0; f < nFire; f++) {
        let a = fa[f] + dTheta;
        if (a < 0) a += 720; else if (a >= 720) a -= 720;
        if (wrapped ? (a >= prev || a < cd) : (a >= prev && a < cd)) { fired = 1; break; }
      }

      let fireEnv = this._updateFireEnv(fired, dt, tipSharpBoost);
      // Soft-gate fire envelope (bandlimited-ish step) — kills static swish on edges
      if (anti && fireSmA > 0) {
        this._fireEnvSm = fireEnv + fireSmA * (this._fireEnvSm - fireEnv);
        fireEnv = this._fireEnvSm;
      } else {
        this._fireEnvSm = fireEnv;
      }

      if (fired) {
        // Soft event amp (no hard 0.25 jump → zipper)
        const nextAmp = (this.rnd() < this.misfire)
          ? 0.25
          : (1 + this.idleImb * (this.rnd() * 2 - 1));
        this.eventAmp = anti
          ? this.eventAmp + (nextAmp - this.eventAmp) * 0.35
          : nextAmp;
      }
      this.huntPhase += TWO_PI * this.huntHz * dt;
      if (this.huntPhase > TWO_PI) this.huntPhase -= TWO_PI;
      const breath = v2 ? (1 + 0.018 * this._mod(0.35 + loadEff * 0.2, dt)) : 1;
      const lope = (1 + idleFactor * ((this.eventAmp - 1) + this.huntDepth * Math.sin(this.huntPhase))) * breath;

      // ── Shared partial generator → split into isolated bus accumulators ──
      const a1 = cd * PI_OVER_360;
      const c = Math.cos(a1), s = Math.sin(a1), twoC = 2 * c;
      let sp2 = 0, cp2 = 1, sp1 = s, cp1 = c;
      let partialSub = 0;
      let partialPulse = 0;

      // p = 1
      {
        const sample = iSin[0] * sp1 + iCos[0] * cp1;
        const f = fUnit * 1;
        if (f <= SUB_PARTIAL_MAX_HZ) partialSub += sample;
        else if (f <= maxPartialHz) partialPulse += sample;
      }
      for (let p = 2; p <= N; p++) {
        const sp = twoC * sp1 - sp2;
        const cp = twoC * cp1 - cp2;
        const sample = iSin[p - 1] * sp + iCos[p - 1] * cp;
        const f = fUnit * p;
        if (f <= SUB_PARTIAL_MAX_HZ) partialSub += sample;
        else if (f <= maxPartialHz) partialPulse += sample;
        // else: above pulse ceiling — discarded (anti-alias / no presence bus)
        sp2 = sp1; sp1 = sp; cp2 = cp1; cp1 = cp;
      }

      // ── Parallel buses (strict local LPF each) ──
      // Sub bus: pure locked sine path (partialSub reserved for future blend)
      const subSignal = this._processSubBus(rpm, loadEff) * lope * bodyLift;
      const pulseSignal = this._processPulseBus(partialPulse, fireEnv, loadEff, lope, gearIndex);
      // C) Stochastic noise hard-gated (always 0 on ship path)
      const noiseSignal = this._processNoiseBus();

      // Waveguide exhaust bus (optional — DasEtwas/Baldan)
      let wgSignal = 0;
      if (this.wg && this.waveguideEnabled && this.waveguideGain > 0.001) {
        const crank01 = cd / 720;
        const wgr = this.wg.process(rpm, loadEff, crank01);
        // Extra HF tame on WG when antiStatic
        wgSignal = wgr.mix * this.waveguideGain * (0.85 + 0.15 * lope) * (anti ? 0.92 : 1);
      }

      // ── Master summing (raw engine bus output) ──
      const summedBus =
        subSignal * GAIN_SUB +
        pulseSignal * GAIN_PULSE +
        wgSignal +
        noiseSignal * GAIN_NOISE;

      const scaled = summedBus * globalVolumeScale;
      let rawEngineOutput = this._tanhSoftClip(scaled, tipDriveBoost + overDriveBoost);

      // ── Final stage: hard HF kill (C) brickwall ≤ GLOBAL_MAX_LPF + notch ──
      // Use smoothed brick cutoff (no zipper on master LPF)
      const brickHz = this._brickCutSm != null ? this._brickCutSm : Math.min(MASTER_BRICK_LP_HZ, maxLpf);
      let cleanedOutput = this._applyBrickwallLowPass(rawEngineOutput, brickHz);
      cleanedOutput = this._applyNotchFilter(
        cleanedOutput,
        MASTER_NOTCH_HZ,
        MASTER_NOTCH_Q,
        MASTER_NOTCH_DB
      );

      out[i] = cleanedOutput;
    }
    return true;
  }
}

registerProcessor('vessel-runtime', VesselRuntime);
