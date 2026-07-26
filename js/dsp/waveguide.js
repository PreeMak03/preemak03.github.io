/**
 * Acoustic waveguide primitives for TAS (Classic + VESSEL).
 *
 * Ported / adapted from:
 *   - DasEtwas/enginesound (MIT) — pop/push, dampening, delay in seconds
 *   - Antonio-R1/engine-sound-generator (MIT) — Baldan et al. 2015 lineage
 *
 * Paper: Baldan et al., Physically informed car engine sound synthesis (SIVE 2015).
 *
 * Use from host modules via import. AudioWorklets embed a copy (no bundler).
 */

export const SPEED_OF_SOUND = 343; // m/s
export const WAVEGUIDE_MAX_AMP = 20;

/** Convert tube length (meters, one-way) to delay samples at sampleRate. */
export function metersToSamples(meters, sampleRate, roundTrip = false) {
  const t = Math.max(0, meters) / SPEED_OF_SOUND;
  const sec = roundTrip ? 2 * t : t;
  return Math.max(2, Math.min(8192, Math.round(sec * sampleRate)));
}

/** Convert delay seconds → samples. */
export function secondsToSamples(sec, sampleRate) {
  return Math.max(2, Math.min(8192, Math.round(Math.max(0, sec) * sampleRate)));
}

export class LoopBuffer {
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

export class DelayLine {
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
export class WaveGuide {
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

export class OnePoleLP {
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
export class CompactWaveguideEngine {
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

export default {
  SPEED_OF_SOUND,
  WAVEGUIDE_MAX_AMP,
  metersToSamples,
  secondsToSamples,
  LoopBuffer,
  DelayLine,
  WaveGuide,
  OnePoleLP,
  CompactWaveguideEngine,
};
