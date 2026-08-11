/* ============================================================================
   VESSEL RUNTIME — AudioWorklet @ 48 kHz (ship + Lab).

   v1  Spec: vessel/vessel-dsp-fix-siro-zenith.md
     A) Bandlimited spectral envelope  A_k ∝ k^{-α} exp(-β k RPM/R)
     B) Multi-pole RPM-tracker LPF
     C) Combustion pressure envelope (no Dirac)
     D) tanh soft saturation

   v2  Spec: vessel/vesselfix_siro-zenithv2.md  (organic dynamics)
     A) Stochastic combustion jitter (per-fire, not per-sample RNG spam)
     B) Load lag → spectral / body breathing
     C) Micro-timing jitter (LFO phase, not raw 48 kHz RNG)
     D) Tip-in / overrun transient punch + light stochastic pops

   fix3 Spec: vessel/fix3.md  (purge noise / presence rasp)
     A) residualNoise / pinkBed hard-zero on excitation path
     B) spectral kill f_p > 1200 Hz; mute formants f ≥ 1900 Hz
     C) tracker LPF ceiling ≤ 1400 Hz (600 + rpmN·800)

   Rollback: js/vessel-runtime.worklet.pre-fix3-backup.js  (pre-fix3)
            js/vessel-runtime.worklet.siro-v1-backup.js     (siro v1)
            (or port message { organicV2: false } to soft-disable v2 blocks)
   Deterministic seeded PRNG. No neural nets.
   ============================================================================ */
const PI_OVER_360 = Math.PI / 360;
const TWO_PI = Math.PI * 2;
const SPEC_ALPHA = 1.9;
const SPEC_BETA0 = 1.35;
const MOD_TABLE = 1024;

class VesselRuntime extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm',  defaultValue: 850, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0,   minValue: 0, maxValue: 1,     automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this.profile = null;
    this.crankDeg = 0;
    this.textureGain = 0.42;
    this.softPulseMs = 1.8;
    this.pulseSharpness = 0.35;
    this.residualNoise = 0; // fix3 A: no residual grit on ship path
    this.cabinCutHz = 2000;
    this.tipInGain = 0.14;
    this.overrunTilt = 0.22;
    this.drive = 0.35;
    this.tipIn = 0;
    this.overrun = 0;
    /** v2 master switch — set organicV2:false for soft rollback */
    this.organicV2 = true;
    this.combustionRand = 0.03;   // maps DNA combustion_rand
    this.loadLag = 0.12;          // seconds ≈ manifold inertia
    this.timingJitterDeg = 0.35;  // max micro crank-angle wander
    this._seed = 1;

    // C) pressure envelope
    this.fireEnv = 0;
    this.firePhase = 0;
    this.fireActive = false;
    this.fireAmpMod = 1;          // v2 A: per-fire amplitude
    // pink residual
    this.pink0 = 0; this.pink1 = 0; this.pink2 = 0;
    // B) multi-pole LPF
    this.lp1 = 0; this.lp2 = 0; this.lp3 = 0;
    this.highLp = 0;
    // v2 B) load lag
    this.loadSmooth = 0;
    // v2 C) timing LFO phases (no per-sample RNG)
    this.timingPh1 = 0;
    this.timingPh2 = 0;
    // v2 D) overrun pop state
    this.overrunPop = 0;
    this.prevOverrun = 0;
    // precomputed modulation table (v2 directive: no raw RNG @ 48 kHz)
    this.modTable = null;
    this.modPhase = 0;

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
    };
  }

  _applySynthOpts(o) {
    if (!o) return;
    if (o.textureGain != null) this.textureGain = o.textureGain;
    if (o.softPulseMs != null) this.softPulseMs = o.softPulseMs;
    if (o.pulseSharpness != null) this.pulseSharpness = o.pulseSharpness;
    if (o.residualNoise != null) this.residualNoise = o.residualNoise;
    if (o.cabinCutHz != null) this.cabinCutHz = o.cabinCutHz;
    if (o.tipInGain != null) this.tipInGain = o.tipInGain;
    if (o.overrunTilt != null) this.overrunTilt = o.overrunTilt;
    if (o.drive != null) this.drive = o.drive;
    if (o.organicV2 != null) this.organicV2 = !!o.organicV2;
    if (o.combustionRand != null) this.combustionRand = o.combustionRand;
    if (o.loadLag != null) this.loadLag = o.loadLag;
    if (o.timingJitterDeg != null) this.timingJitterDeg = o.timingJitterDeg;
  }

  _buildModTable() {
    // filtered-ish bipolar table, deterministic from seed
    const t = new Float32Array(MOD_TABLE);
    let y = 0;
    for (let i = 0; i < MOD_TABLE; i++) {
      const w = this.rnd() * 2 - 1;
      y = y * 0.92 + w * 0.08; // very slow LPF → low-frequency modulation
      t[i] = y;
    }
    // normalize
    let peak = 1e-6;
    for (let i = 0; i < MOD_TABLE; i++) peak = Math.max(peak, Math.abs(t[i]));
    for (let i = 0; i < MOD_TABLE; i++) t[i] /= peak;
    this.modTable = t;
    this.modPhase = 0;
  }

  setProfile(p) {
    this.profile = p;
    const s = p.synth;
    this.N = s.N; this.K = s.rpmBreakpoints.length; this.J = s.loadLevels.length;
    this.iSin = new Float32Array(this.N);
    this.iCos = new Float32Array(this.N);
    this.harmRoll = new Float32Array(this.N);
    this._seed = (p.seed >>> 0) || 1;
    this.crankDeg = 0;
    this.fireEnv = 0; this.firePhase = 0; this.fireActive = false; this.fireAmpMod = 1;
    this.pink0 = 0; this.pink1 = 0; this.pink2 = 0;
    this.lp1 = 0; this.lp2 = 0; this.lp3 = 0; this.highLp = 0;
    this.loadSmooth = 0;
    this.timingPh1 = 0; this.timingPh2 = 0;
    this.overrunPop = 0; this.prevOverrun = 0;
    this._buildModTable();

    const bp = s.rpmBreakpoints;
    this.redline = (bp && bp.length) ? bp[bp.length - 1] : 7000;

    const fm = p.aux && p.aux.formants, src = p.aux && p.aux.source;
    this.fireAngles = (src && src.fireAngles) ? Float32Array.from(src.fireAngles) : new Float32Array(0);
    if (src && src.noise != null) this.residualNoise = src.noise;
    if (src && src.softPulseMs != null) this.softPulseMs = src.softPulseMs;
    if (src && src.cabinCutHz != null) this.cabinCutHz = src.cabinCutHz;
    if (src && src.pulseSharpness != null) this.pulseSharpness = src.pulseSharpness;

    // DNA combustion_rand baked into aux if present (compiler may add later)
    const comb = p.aux && p.aux.combustion;
    if (comb && comb.rand != null) this.combustionRand = comb.rand;
    // also accept idle.imbalance as related organic amount floor
    const idle = (p.aux && p.aux.idle) || {}, mech = (p.aux && p.aux.mechanical) || {};
    if (idle.combustionRand != null) this.combustionRand = idle.combustionRand;

    if (fm && fm.freqs) {
      const sr = sampleRate, Q = fm.Q || 2.2;
      this.B = fm.freqs.length;
      this.fb0 = new Float32Array(this.B); this.fb2 = new Float32Array(this.B);
      this.fa1 = new Float32Array(this.B); this.fa2 = new Float32Array(this.B);
      this.fy1 = new Float32Array(this.B); this.fy2 = new Float32Array(this.B);
      this.iBand = new Float32Array(this.B);
      this.bandGains = Float32Array.from(fm.gains);
      // Base formant weights. fix3 B: permanently mute f ≥ 1900 Hz (presence/air rasp).
      this.bandFreqs = Float32Array.from(fm.freqs);
      this.bandWeightBase = new Float32Array(this.B);
      this.bandWeight = new Float32Array(this.B);
      for (let b = 0; b < this.B; b++) {
        const f = fm.freqs[b];
        let w = 1;
        if (f > 600) w = Math.max(0.04, 1 - (f - 600) / 2400);
        if (f >= 4000) w *= 0.08;
        // fix3 B: hard-band upper formants (1950 / 3450 / 6000 → silent)
        if (f >= 1900) w = 0;
        this.bandWeightBase[b] = w;
        this.bandWeight[b] = w;
        const w0 = 2 * Math.PI * Math.min(f, sr * 0.45) / sr;
        const cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q), a0 = 1 + alpha;
        this.fb0[b] = alpha / a0; this.fb2[b] = -alpha / a0; this.fa1[b] = -2 * cw / a0; this.fa2[b] = (1 - alpha) / a0;
      }
    } else {
      this.B = 0;
      this.bandWeight = null;
      this.bandWeightBase = null;
      this.bandFreqs = null;
    }
    this.xh1 = 0; this.xh2 = 0;

    this.idleRpm = idle.idleRpm || 800;
    this.idleImb = idle.imbalance || 0;
    this.misfire = idle.misfireProb || 0;
    this.huntHz = idle.huntHz || 5;
    this.huntDepth = idle.huntDepth || 0;
    this.mValve = mech.valvetick != null ? mech.valvetick : 0.06;
    this.mInj = mech.injector != null ? mech.injector : 0.04;
    this.mChain = mech.timingchain != null ? mech.timingchain : 0.05;
    this.mAlt = mech.alternator != null ? mech.alternator : 0.03;
    this.mBelt = mech.beltratio || 2.7;
    this.eventAmp = 1; this.huntPhase = 0; this.tickEnv = 0; this.altPhase = 0; this.chainPhase = 0;

    // tip-in / overrun from DNA transient if present
    const tr = (p.aux && p.aux.transient) || {};
    if (tr.tipinLead != null) this.tipInLead = tr.tipinLead;
    else this.tipInLead = 0.4;
    if (tr.overrunBackfire != null) this.overrunBackfire = tr.overrunBackfire;
    else this.overrunBackfire = 0.12;
  }

  rnd() { this._seed = (this._seed * 1664525 + 1013904223) >>> 0; return this._seed / 4294967296; }

  /** Table lookup LFO (no raw RNG in render hot path) */
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

  _pink() {
    const w = this.rnd() * 2 - 1;
    this.pink0 = 0.99886 * this.pink0 + w * 0.0555179;
    this.pink1 = 0.99332 * this.pink1 + w * 0.0750759;
    this.pink2 = 0.96900 * this.pink2 + w * 0.1538520;
    return (this.pink0 + this.pink1 + this.pink2 + w * 0.12) * 0.22;
  }

  _spectralEnv(p, rpm, loadEff) {
    const red = this.redline || 7000;
    const beta = SPEC_BETA0 + loadEff * 0.45 + Math.max(0, (rpm / red) - 0.4) * 0.8;
    const pow = Math.pow(p, -SPEC_ALPHA);
    const expk = Math.exp(-beta * p * (rpm / red));
    const fApprox = p * (rpm / 120);
    const nyqKill = fApprox > sampleRate * 0.22 ? Math.exp(-(fApprox - sampleRate * 0.22) / 800) : 1;
    // fix3 B: steep secondary rolloff — no additive energy above ~2 kHz
    let roll = pow * expk * nyqKill;
    if (fApprox > 1200) {
      roll *= Math.max(0.0, 1.0 - (fApprox - 1200) / 800);
    }
    return roll;
  }

  _interpolate(rpm, loadEff) {
    const s = this.profile.synth, N = this.N, K = this.K, J = this.J;
    const bp = s.rpmBreakpoints, lv = s.loadLevels, cs = s.coefSin, cc = s.coefCos;
    let k0 = 0; while (k0 < K - 2 && rpm > bp[k0 + 1]) k0++;
    const k1 = Math.min(K - 1, k0 + 1);
    let fr = (rpm - bp[k0]) / ((bp[k1] - bp[k0]) || 1); fr = fr < 0 ? 0 : fr > 1 ? 1 : fr;
    let j0 = 0, j1 = 0, fl = 0;
    if (J > 1) {
      while (j0 < J - 2 && loadEff > lv[j0 + 1]) j0++;
      j1 = Math.min(J - 1, j0 + 1);
      fl = (loadEff - lv[j0]) / ((lv[j1] - lv[j0]) || 1); fl = fl < 0 ? 0 : fl > 1 ? 1 : fl;
    }
    const bil = (v00, v10, v01, v11) =>
      (v00 * (1 - fr) + v10 * fr) * (1 - fl) + (v01 * (1 - fr) + v11 * fr) * fl;
    const hIdx = (m, k, j) => (m * K + k) * J + j;

    // v2 B: body breathing — low partials swell with lagged load
    const bodyBreath = this.organicV2 ? (1 + 0.12 * loadEff) : 1;
    const brightBreath = this.organicV2 ? (1 + 0.06 * loadEff - 0.04 * (1 - loadEff)) : 1;

    for (let m = 0; m < N; m++) {
      const roll = this._spectralEnv(m + 1, rpm, loadEff);
      // low-order (body) vs high-order split around partial 8
      const bodyW = m < 8 ? bodyBreath : brightBreath;
      this.harmRoll[m] = roll * bodyW;
      this.iSin[m] = bil(cs[hIdx(m, k0, j0)], cs[hIdx(m, k1, j0)], cs[hIdx(m, k0, j1)], cs[hIdx(m, k1, j1)]) * this.harmRoll[m];
      this.iCos[m] = bil(cc[hIdx(m, k0, j0)], cc[hIdx(m, k1, j0)], cc[hIdx(m, k0, j1)], cc[hIdx(m, k1, j1)]) * this.harmRoll[m];
    }
    if (this.B) {
      const g = this.bandGains;
      const bIdx = (b, k, j) => (b * K + k) * J + j;
      for (let b = 0; b < this.B; b++)
        this.iBand[b] = bil(g[bIdx(b, k0, j0)], g[bIdx(b, k1, j0)], g[bIdx(b, k0, j1)], g[bIdx(b, k1, j1)]);
    }
  }

  _saturate(x, driveBoost) {
    const d = Math.max(0, (this.drive || 0) + (driveBoost || 0));
    const k = 1 + d * 5.5;
    const y = Math.tanh(x * k);
    const nrm = Math.tanh(k);
    return nrm > 1e-6 ? y / nrm : y;
  }

  _updateFireEnv(fired, dt, pulseSharpBoost) {
    const totalMs = Math.max(0.6, this.softPulseMs || 1.8);
    const sharp = Math.max(0.05, Math.min(1, (this.pulseSharpness != null ? this.pulseSharpness : 0.35) + (pulseSharpBoost || 0)));
    const atkMs = Math.max(0.15, totalMs * (0.28 - sharp * 0.18));
    const decMs = Math.max(0.4, totalMs - atkMs);
    if (fired) {
      this.fireActive = true;
      this.firePhase = 0;
      // v2 A: cycle-to-cycle amplitude (ONLY on fire — not every sample)
      if (this.organicV2) {
        const sig = Math.max(0.005, Math.min(0.08, this.combustionRand || 0.03));
        // table sample + tiny seed step for variety (event-rate only)
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

  process(_inputs, outputs, params) {
    const out = outputs[0][0];
    if (!this.profile || !out) return true;
    const n = out.length, sr = sampleRate, N = this.N;
    const rpm = params.rpm[0], loadRaw = params.load[0];
    const dt = 1 / sr;
    const v2 = this.organicV2;

    // v2 B: 1-pole lag on load (manifold inertia) — k-rate update once/block is enough
    // but also advance per-sample for smoothness at block edges; cheap.
    const lagTau = Math.max(0.02, this.loadLag || 0.12);
    const lagA = Math.exp(-dt / lagTau);

    // v2 D: tip-in / overrun from host (already smoothed) + local punch
    const tip = this.tipIn || 0;
    const over = this.overrun || 0;
    // overrun rising edge → schedule soft pop energy (event-like)
    if (v2 && over > this.prevOverrun + 0.08) {
      const popAmt = (this.overrunBackfire || 0.12) * (0.5 + 0.5 * this.rnd());
      this.overrunPop = Math.max(this.overrunPop, popAmt);
    }
    this.prevOverrun = over;
    this.overrunPop *= Math.exp(-dt / 0.045); // ~45 ms tail

    const tipSharpBoost = v2 ? tip * (this.tipInLead || 0.4) * 0.35 : 0;
    const tipDriveBoost = v2 ? tip * 0.22 : 0;
    const overDriveBoost = v2 ? over * 0.08 : 0;

    // k-rate interpolate uses lagged load — update loadSmooth mid-block once first
    // Initial lag step for this quantum
    this.loadSmooth = loadRaw + lagA * (this.loadSmooth - loadRaw);
    // for first interpolate of block use smoothed load
    let loadEff = v2 ? this.loadSmooth : loadRaw;
    this._interpolate(rpm, loadEff);

    const iSin = this.iSin, iCos = this.iCos;
    const degStepBase = (rpm / 60) * 360 / sr;
    const loadAmp = 0.28 + 0.72 * loadEff;
    const B = this.B, fa = this.fireAngles, nFire = fa.length;
    // fix3 A: residual grit hard-off (ignore profile residualNoise if non-zero)
    const residual = 0;
    const red = this.redline || 7000;
    const rpmN = Math.max(0, Math.min(1.2, rpm / red));

    // Ensure formant weights stay muted (f ≥ 1900) even if rebased later
    if (B && this.bandWeightBase) {
      for (let b = 0; b < B; b++) this.bandWeight[b] = this.bandWeightBase[b];
    }

    // High-band texture (low-formant residual path only — upper bands already zero)
    const texG = Math.min(0.55, this.textureGain
      * (1 + this.tipInGain * tip)
      * (1 - this.overrunTilt * over * 0.85)
      * (v2 ? (1 + tip * 0.15) : 1));
    const highMix = 0.55;

    // fix3 C: precision tracker LPF — never above ~1400 Hz
    const trackCut = Math.min(
      this.cabinCutHz || 1400,
      600 + rpmN * 800
    );
    const lpA = Math.exp(-TWO_PI * Math.min(trackCut, sr * 0.45) / sr);
    const highCut = Math.min(trackCut * 0.85, 1200);
    const highLpA = Math.exp(-TWO_PI * Math.min(highCut, sr * 0.45) / sr);

    const idleFactor = Math.max(0, Math.min(1, (this.idleRpm * 1.8 - rpm) / (this.idleRpm * 0.8)));
    const mechMask = 0.22 + 0.45 * idleFactor;
    const rev = rpm / 60;
    const altW = TWO_PI * this.mBelt * rev * dt, chainW = TWO_PI * rev * 3.5 * dt;

    // v2 C: micro-timing LFO rates (Hz)
    const tJ = v2 ? (this.timingJitterDeg || 0.35) : 0;

    for (let i = 0; i < n; i++) {
      // keep load lag moving (cheap)
      if (v2) this.loadSmooth = loadRaw + lagA * (this.loadSmooth - loadRaw);

      // v2 C: timing jitter as crank phase wander (LFO only)
      this.timingPh1 += TWO_PI * (2.1 + loadEff * 1.4) * dt;
      this.timingPh2 += TWO_PI * (3.7 + loadEff * 0.8) * dt;
      if (this.timingPh1 > TWO_PI) this.timingPh1 -= TWO_PI;
      if (this.timingPh2 > TWO_PI) this.timingPh2 -= TWO_PI;
      const dTheta = tJ * (0.65 * Math.sin(this.timingPh1) + 0.35 * Math.sin(this.timingPh2));

      const prev = this.crankDeg;
      let cd = prev + degStepBase; let wrapped = false;
      if (cd >= 720) { cd -= 720; wrapped = true; }
      this.crankDeg = cd;

      // fire detect with micro timing offset on fire angles
      let fired = 0;
      for (let f = 0; f < nFire; f++) {
        let a = fa[f] + dTheta;
        if (a < 0) a += 720; else if (a >= 720) a -= 720;
        if (wrapped ? (a >= prev || a < cd) : (a >= prev && a < cd)) { fired = 1; break; }
      }

      const fireEnv = this._updateFireEnv(fired, dt, tipSharpBoost);

      // A) tonal bank
      const a1 = cd * PI_OVER_360;
      const c = Math.cos(a1), s = Math.sin(a1), twoC = 2 * c;
      let sp2 = 0, cp2 = 1, sp1 = s, cp1 = c;
      let tonal = iSin[0] * sp1 + iCos[0] * cp1;
      for (let p = 2; p <= N; p++) {
        const sp = twoC * sp1 - sp2, cp = twoC * cp1 - cp2;
        tonal += iSin[p - 1] * sp + iCos[p - 1] * cp;
        sp2 = sp1; sp1 = sp; cp2 = cp1; cp1 = cp;
      }

      // high band (low formants only; residual noise purged — fix3 A)
      let high = 0;
      if (B && texG > 0) {
        const jet = fireEnv * loadAmp;
        const pinkBed = 0; // Completely purged to eliminate sandy noise artifacts
        const exc = jet * 0.85 + pinkBed * residual;
        const xh2 = this.xh2, iBand = this.iBand, bw = this.bandWeight;
        const fb0 = this.fb0, fb2 = this.fb2, fa1 = this.fa1, fa2 = this.fa2, fy1 = this.fy1, fy2 = this.fy2;
        for (let b = 0; b < B; b++) {
          const y = fb0[b] * exc + fb2[b] * xh2 - fa1[b] * fy1[b] - fa2[b] * fy2[b];
          fy2[b] = fy1[b]; fy1[b] = y;
          high += iBand[b] * y * (bw ? bw[b] : 1);
        }
        this.xh2 = this.xh1; this.xh1 = exc;
        this.highLp = high + highLpA * (this.highLp - high);
        high = this.highLp;
      }

      if (fired) {
        this.eventAmp = (this.rnd() < this.misfire) ? 0.25 : (1 + this.idleImb * (this.rnd() * 2 - 1));
        if (this.mValve || this.mInj) this.tickEnv = 1;
      }
      this.huntPhase += TWO_PI * this.huntHz * dt; if (this.huntPhase > TWO_PI) this.huntPhase -= TWO_PI;
      // v2 A: slow breathing on lope via mod table
      const breath = v2 ? (1 + 0.018 * this._mod(0.35 + loadEff * 0.2, dt)) : 1;
      const lope = (1 + idleFactor * ((this.eventAmp - 1) + this.huntDepth * Math.sin(this.huntPhase))) * breath;

      let mech = 0;
      if (this.mValve || this.mInj) {
        this.tickEnv *= Math.exp(-dt / 0.0028);
        mech += this._pink() * this.tickEnv * (this.mInj + this.mValve) * 0.14;
      }
      if (this.mAlt) {
        this.altPhase += altW; if (this.altPhase > TWO_PI) this.altPhase -= TWO_PI;
        mech += (Math.sin(this.altPhase) + 0.25 * Math.sin(2 * this.altPhase)) * this.mAlt * 0.09;
      }
      if (this.mChain) {
        this.chainPhase += chainW; if (this.chainPhase > TWO_PI) this.chainPhase -= TWO_PI;
        mech += Math.sin(this.chainPhase) * this.mChain * 0.045;
      }

      // v2 D: tip-in body punch (overrun pink pops disabled — fix3 zero-noise path)
      const bodyLift = 1.1 + 0.08 * tip - 0.04 * over + (v2 ? tip * 0.12 * (this.tipInLead || 0.4) : 0);
      let mix = (tonal * bodyLift + high * texG * highMix) * lope + mech * mechMask;
      // overrunPop noise ticks stripped (sandy crackles under lift-off)

      // multi-pole LPF
      this.lp1 = mix + lpA * (this.lp1 - mix);
      this.lp2 = this.lp1 + lpA * (this.lp2 - this.lp1);
      this.lp3 = this.lp2 + lpA * (this.lp3 - this.lp2);
      mix = this.lp3;

      out[i] = this._saturate(mix, tipDriveBoost + overDriveBoost);
    }
    return true;
  }
}

registerProcessor('vessel-runtime', VesselRuntime);
