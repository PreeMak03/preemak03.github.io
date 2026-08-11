/* ============================================================================
   VESSEL RUNTIME — AudioWorklet @ 48 kHz (ship + Lab).

   v3.0 Spec: vessel/vessel-architecture-v3.md
     Modular Parallel Summing — three isolated buses → master tanh
       1) Sub & Body bus     — f ≲ 300 Hz, strict LPF ~250 Hz
       2) Exhaust Pulse bus  — lope / fire / mid partials, LPF ~1200 Hz
       3) Noise bus          — permanently 0 (no grit / hiss / rasp)
     Global Transmission: gear k-rate → volume scale before master clip
     Global HF kill (final stage): brickwall LPF @ 1800 Hz + notch @ 3 kHz (−18 dB)

   Prior layers retained as bus *sources* (not monolithic mix):
     · VSL half-order harmonic bank (split by partial frequency into buses)
     · Combustion pressure envelope (pulse bus only)
     · v2 organic: load lag, timing LFO, per-fire amp (no noise pops)

   Rollback: js/vessel-runtime.worklet.pre-v3-backup.js
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
 * One-pole low-pass state helper (per-bus isolated).
 * y += (1-a)*(x-y)  with a = exp(-2π f / sr)
 */
function onePoleCoeff(hz, sr) {
  const f = Math.min(Math.max(hz, 1), sr * 0.45);
  return Math.exp(-TWO_PI * f / sr);
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
    const s = this.profile.synth, N = this.N, K = this.K, J = this.J;
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
    const atkMs = Math.max(0.15, totalMs * (0.28 - sharp * 0.18));
    const decMs = Math.max(0.4, totalMs - atkMs);
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

  // ─── BUS 1: Sub & Body — locked sine, floor 30 Hz, HPF anti-rumble ─────
  _processSubBus(rpm, load) {
    // 1) Fundamental, never below 30 Hz (avoids mud / sub-rumble)
    const targetFreq = Math.max(30, (rpm / 120) * 2);

    // 2) Phase advance (locked)
    this.phaseSub = (this.phaseSub + targetFreq / sampleRate) % 1.0;

    // 3) Soft sine, volume tracks load
    let subSignal = Math.sin(this.phaseSub * TWO_PI) * (0.5 + load * 0.5);

    // 4) Internal HPF @ 30 Hz — dump “บื๊ด” ultra-lows
    subSignal = this._applySimpleHPF(subSignal, 30);

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
    const N = this.N;
    const rpm = params.rpm[0];
    const loadRaw = params.load[0];
    const gearIndex = params.gear && params.gear.length ? params.gear[0] : 1;
    const dt = 1 / sr;
    const v2 = this.organicV2;

    const lagTau = Math.max(0.02, this.loadLag || 0.12);
    const lagA = Math.exp(-dt / lagTau);

    const tip = this.tipIn || 0;
    const over = this.overrun || 0;
    const tipSharpBoost = v2 ? tip * (this.tipInLead || 0.4) * 0.35 : 0;
    const tipDriveBoost = v2 ? tip * 0.18 : 0;
    const overDriveBoost = v2 ? over * 0.05 : 0;

    this.loadSmooth = loadRaw + lagA * (this.loadSmooth - loadRaw);
    let loadEff = v2 ? this.loadSmooth : loadRaw;
    this._interpolate(rpm, loadEff);

    // Per-bus LPF coeffs (isolated ceilings — never share one global tracker cut)
    this._subA = onePoleCoeff(SUB_LP_HZ, sr);
    this._pulseA = onePoleCoeff(PULSE_LP_HZ, sr);

    const iSin = this.iSin, iCos = this.iCos;
    const degStepBase = (rpm / 60) * 360 / sr;
    const fa = this.fireAngles;
    const nFire = fa.length;
    const tJ = v2 ? (this.timingJitterDeg || 0.35) : 0;

    const idleFactor = Math.max(0, Math.min(1, (this.idleRpm * 1.8 - rpm) / (this.idleRpm * 0.8)));
    const bodyLift = 1.08 + 0.1 * tip - 0.05 * over + (v2 ? tip * 0.1 * (this.tipInLead || 0.4) : 0);

    // Transmission layer (host txScale includes shift mute)
    const gearScale = this._gearVolumeScale(gearIndex) * Math.max(0.15, this.txScale || 1);
    const globalVolumeScale = gearScale;

    // Precompute partial → bus routing threshold in Hz terms at this RPM
    const fUnit = rpm / 120; // Hz per half-order partial index

    for (let i = 0; i < n; i++) {
      if (v2) this.loadSmooth = loadRaw + lagA * (this.loadSmooth - loadRaw);
      loadEff = v2 ? this.loadSmooth : loadRaw;

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

      const fireEnv = this._updateFireEnv(fired, dt, tipSharpBoost);

      if (fired) {
        this.eventAmp = (this.rnd() < this.misfire)
          ? 0.25
          : (1 + this.idleImb * (this.rnd() * 2 - 1));
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
        else if (f <= PULSE_PARTIAL_MAX_HZ) partialPulse += sample;
      }
      for (let p = 2; p <= N; p++) {
        const sp = twoC * sp1 - sp2;
        const cp = twoC * cp1 - cp2;
        const sample = iSin[p - 1] * sp + iCos[p - 1] * cp;
        const f = fUnit * p;
        if (f <= SUB_PARTIAL_MAX_HZ) partialSub += sample;
        else if (f <= PULSE_PARTIAL_MAX_HZ) partialPulse += sample;
        // else: above pulse ceiling — discarded (no presence bus)
        sp2 = sp1; sp1 = sp; cp2 = cp1; cp1 = cp;
      }

      // ── Parallel buses (strict local LPF each) ──
      // Sub bus: pure locked sine path (partialSub reserved for future blend)
      const subSignal = this._processSubBus(rpm, loadEff) * lope * bodyLift;
      const pulseSignal = this._processPulseBus(partialPulse, fireEnv, loadEff, lope, gearIndex);
      const noiseSignal = this._processNoiseBus();

      // ── Master summing (raw engine bus output) ──
      const summedBus =
        subSignal * GAIN_SUB +
        pulseSignal * GAIN_PULSE +
        noiseSignal * GAIN_NOISE;

      const scaled = summedBus * globalVolumeScale;
      let rawEngineOutput = this._tanhSoftClip(scaled, tipDriveBoost + overDriveBoost);

      // ── Final stage: hard HF kill (brickwall LPF + presence notch) ──
      // Kill rasp / “แบร๊ด” before it leaves the worklet
      let cleanedOutput = this._applyBrickwallLowPass(rawEngineOutput, MASTER_BRICK_LP_HZ);
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
