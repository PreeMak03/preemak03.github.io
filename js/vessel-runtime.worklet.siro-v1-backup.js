/* ============================================================================
   VESSEL RUNTIME — AudioWorklet @ 48 kHz (ship + Lab).
   Spec: vessel/vessel-dsp-fix-siro-zenith.md

   A) Bandlimited spectral envelope on half-order harmonic bank
      A_k ∝ k^{-α} · exp(-β · k · RPM/Redline)   α≥1.8
   B) Multi-pole RPM-tracker LPF (anti-alias + kill cyber-HF)
   C) Combustion pressure envelope (asymmetric attack/decay — no Dirac)
   D) Native tanh soft-clip saturation before output

   Still deterministic (seeded PRNG only). No neural nets.
   ============================================================================ */
const PI_OVER_360 = Math.PI / 360;
const TWO_PI = Math.PI * 2;
/** Spectral envelope power-law (spec α ≥ 1.8) */
const SPEC_ALPHA = 1.9;
/** Base exponential HF kill vs order×rpm */
const SPEC_BETA0 = 1.35;

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
    this.pulseSharpness = 0.35;   // 0=slow attack, 1=faster (still not Dirac)
    this.residualNoise = 0.01;
    this.cabinCutHz = 2000;
    this.tipInGain = 0.14;
    this.overrunTilt = 0.22;
    this.drive = 0.35;            // D) saturation amount
    this.tipIn = 0;
    this.overrun = 0;
    this._seed = 1;
    // C) pressure envelope state
    this.fireEnv = 0;
    this.firePhase = 0;           // seconds since last fire open
    this.fireActive = false;
    // pink residual
    this.pink0 = 0; this.pink1 = 0; this.pink2 = 0;
    // B) multi-pole LPF state (3× one-pole cascade ≈ multi-pole)
    this.lp1 = 0; this.lp2 = 0; this.lp3 = 0;
    this.highLp = 0;
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
  }

  setProfile(p) {
    this.profile = p;
    const s = p.synth;
    this.N = s.N; this.K = s.rpmBreakpoints.length; this.J = s.loadLevels.length;
    this.iSin = new Float32Array(this.N);
    this.iCos = new Float32Array(this.N);
    this.harmRoll = new Float32Array(this.N); // A) per-partial envelope (k-rate)
    this._seed = (p.seed >>> 0) || 1;
    this.crankDeg = 0;
    this.fireEnv = 0; this.firePhase = 0; this.fireActive = false;
    this.pink0 = 0; this.pink1 = 0; this.pink2 = 0;
    this.lp1 = 0; this.lp2 = 0; this.lp3 = 0; this.highLp = 0;

    // redline for spectral β tracking
    const bp = s.rpmBreakpoints;
    this.redline = (bp && bp.length) ? bp[bp.length - 1] : 7000;

    const fm = p.aux && p.aux.formants, src = p.aux && p.aux.source;
    this.fireAngles = (src && src.fireAngles) ? Float32Array.from(src.fireAngles) : new Float32Array(0);
    if (src && src.noise != null) this.residualNoise = src.noise;
    if (src && src.softPulseMs != null) this.softPulseMs = src.softPulseMs;
    if (src && src.cabinCutHz != null) this.cabinCutHz = src.cabinCutHz;
    if (src && src.pulseSharpness != null) this.pulseSharpness = src.pulseSharpness;

    if (fm && fm.freqs) {
      const sr = sampleRate, Q = fm.Q || 2.2;
      this.B = fm.freqs.length;
      this.fb0 = new Float32Array(this.B); this.fb2 = new Float32Array(this.B);
      this.fa1 = new Float32Array(this.B); this.fa2 = new Float32Array(this.B);
      this.fy1 = new Float32Array(this.B); this.fy2 = new Float32Array(this.B);
      this.iBand = new Float32Array(this.B);
      this.bandGains = Float32Array.from(fm.gains);
      this.bandWeight = new Float32Array(this.B);
      for (let b = 0; b < this.B; b++) {
        const f = fm.freqs[b];
        // formant HF kill (spec: no free-field 6 kHz rasp)
        let w = 1;
        if (f > 600) w = Math.max(0.04, 1 - (f - 600) / 2400);
        if (f >= 4000) w *= 0.08;
        this.bandWeight[b] = w;
        const w0 = 2 * Math.PI * Math.min(f, sr * 0.45) / sr;
        const cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q), a0 = 1 + alpha;
        this.fb0[b] = alpha / a0; this.fb2[b] = -alpha / a0; this.fa1[b] = -2 * cw / a0; this.fa2[b] = (1 - alpha) / a0;
      }
    } else { this.B = 0; this.bandWeight = null; }
    this.xh1 = 0; this.xh2 = 0;

    const idle = (p.aux && p.aux.idle) || {}, mech = (p.aux && p.aux.mechanical) || {};
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
  }

  rnd() { this._seed = (this._seed * 1664525 + 1013904223) >>> 0; return this._seed / 4294967296; }

  _pink() {
    const w = this.rnd() * 2 - 1;
    this.pink0 = 0.99886 * this.pink0 + w * 0.0555179;
    this.pink1 = 0.99332 * this.pink1 + w * 0.0750759;
    this.pink2 = 0.96900 * this.pink2 + w * 0.1538520;
    return (this.pink0 + this.pink1 + this.pink2 + w * 0.12) * 0.22;
  }

  /**
   * A) Spectral envelope for partial index p (1..N):
   *    A_p = p^{-α} · exp(-β · p · rpm/redline)
   */
  _spectralEnv(p, rpm, load) {
    const red = this.redline || 7000;
    const beta = SPEC_BETA0 + load * 0.45 + Math.max(0, (rpm / red) - 0.4) * 0.8;
    const pow = Math.pow(p, -SPEC_ALPHA);
    const expk = Math.exp(-beta * p * (rpm / red));
    // Nyquist safety: kill partials whose half-order f would be high
    // f ≈ p * (rpm/60) / 2  for half-order model at high p
    const fApprox = p * (rpm / 120);
    const nyqKill = fApprox > sampleRate * 0.22 ? Math.exp(-(fApprox - sampleRate * 0.22) / 800) : 1;
    return pow * expk * nyqKill;
  }

  _interpolate(rpm, load) {
    const s = this.profile.synth, N = this.N, K = this.K, J = this.J;
    const bp = s.rpmBreakpoints, lv = s.loadLevels, cs = s.coefSin, cc = s.coefCos;
    let k0 = 0; while (k0 < K - 2 && rpm > bp[k0 + 1]) k0++;
    const k1 = Math.min(K - 1, k0 + 1);
    let fr = (rpm - bp[k0]) / ((bp[k1] - bp[k0]) || 1); fr = fr < 0 ? 0 : fr > 1 ? 1 : fr;
    let j0 = 0, j1 = 0, fl = 0;
    if (J > 1) {
      while (j0 < J - 2 && load > lv[j0 + 1]) j0++;
      j1 = Math.min(J - 1, j0 + 1);
      fl = (load - lv[j0]) / ((lv[j1] - lv[j0]) || 1); fl = fl < 0 ? 0 : fl > 1 ? 1 : fl;
    }
    const bil = (v00, v10, v01, v11) =>
      (v00 * (1 - fr) + v10 * fr) * (1 - fl) + (v01 * (1 - fr) + v11 * fr) * fl;
    const hIdx = (m, k, j) => (m * K + k) * J + j;
    for (let m = 0; m < N; m++) {
      const roll = this._spectralEnv(m + 1, rpm, load);
      this.harmRoll[m] = roll;
      this.iSin[m] = bil(cs[hIdx(m, k0, j0)], cs[hIdx(m, k1, j0)], cs[hIdx(m, k0, j1)], cs[hIdx(m, k1, j1)]) * roll;
      this.iCos[m] = bil(cc[hIdx(m, k0, j0)], cc[hIdx(m, k1, j0)], cc[hIdx(m, k0, j1)], cc[hIdx(m, k1, j1)]) * roll;
    }
    if (this.B) {
      const g = this.bandGains;
      const bIdx = (b, k, j) => (b * K + k) * J + j;
      for (let b = 0; b < this.B; b++)
        this.iBand[b] = bil(g[bIdx(b, k0, j0)], g[bIdx(b, k1, j0)], g[bIdx(b, k0, j1)], g[bIdx(b, k1, j1)]);
    }
  }

  /** D) Soft hyperbolic saturation (normalized tanh) */
  _saturate(x) {
    const d = Math.max(0, this.drive || 0);
    const k = 1 + d * 5.5;
    const y = Math.tanh(x * k);
    const nrm = Math.tanh(k);
    return nrm > 1e-6 ? y / nrm : y;
  }

  /**
   * C) Asymmetric combustion pressure envelope (not a unit impulse).
   * Attack rise governed by sharpness; decay ~ softPulseMs.
   */
  _updateFireEnv(fired, dt) {
    const totalMs = Math.max(0.6, this.softPulseMs || 1.8);
    const sharp = Math.max(0.05, Math.min(1, this.pulseSharpness != null ? this.pulseSharpness : 0.35));
    // attack fraction of total: sharper → shorter attack (still ≥ 0.15 ms)
    const atkMs = Math.max(0.15, totalMs * (0.28 - sharp * 0.18));
    const decMs = Math.max(0.4, totalMs - atkMs);
    if (fired) {
      this.fireActive = true;
      this.firePhase = 0;
    }
    if (!this.fireActive) {
      this.fireEnv = 0;
      return 0;
    }
    this.firePhase += dt;
    const tMs = this.firePhase * 1000;
    let env;
    if (tMs < atkMs) {
      // smoothstep attack (flame propagation)
      const u = tMs / atkMs;
      env = u * u * (3 - 2 * u);
    } else {
      // exponential expansion / exhaust open
      env = Math.exp(-(tMs - atkMs) / decMs);
    }
    if (env < 1e-4) {
      this.fireActive = false;
      env = 0;
    }
    this.fireEnv = env;
    return env;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0][0];
    if (!this.profile || !out) return true;
    const n = out.length, sr = sampleRate, N = this.N;
    const rpm = params.rpm[0], load = params.load[0];
    this._interpolate(rpm, load);
    const iSin = this.iSin, iCos = this.iCos;
    const degStep = (rpm / 60) * 360 / sr;
    const loadAmp = 0.28 + 0.72 * load;
    const texG = Math.min(0.55, this.textureGain
      * (1 + this.tipInGain * this.tipIn)
      * (1 - this.overrunTilt * this.overrun * 0.85));
    const B = this.B, fa = this.fireAngles, nFire = fa.length;
    const dt = 1 / sr;
    const residual = this.residualNoise;
    const red = this.redline || 7000;
    const rpmN = Math.max(0, Math.min(1.2, rpm / red));

    // B) Tracker-linked multi-pole LPF cutoff (Hz) — clamps digital harsh zone
    // idle dark ~900 Hz → redline still capped ~2400 (not 6–9 kHz cyber)
    const trackCut = Math.min(
      this.cabinCutHz || 2000,
      850 + rpmN * 1400 + load * 200
    );
    const lpA = Math.exp(-TWO_PI * Math.min(trackCut, sr * 0.45) / sr);
    // high-band only cut (stricter)
    const highCut = Math.min(trackCut * 0.85, 1800);
    const highLpA = Math.exp(-TWO_PI * Math.min(highCut, sr * 0.45) / sr);

    const idleFactor = Math.max(0, Math.min(1, (this.idleRpm * 1.8 - rpm) / (this.idleRpm * 0.8)));
    const mechMask = 0.22 + 0.45 * idleFactor;
    const rev = rpm / 60;
    const altW = TWO_PI * this.mBelt * rev * dt, chainW = TWO_PI * rev * 3.5 * dt;

    for (let i = 0; i < n; i++) {
      const prev = this.crankDeg;
      let cd = prev + degStep; let wrapped = false;
      if (cd >= 720) { cd -= 720; wrapped = true; }
      this.crankDeg = cd;

      let fired = 0;
      for (let f = 0; f < nFire; f++) {
        const a = fa[f];
        if (wrapped ? (a >= prev || a < cd) : (a >= prev && a < cd)) { fired = 1; break; }
      }

      // C) pressure envelope
      const fireEnv = this._updateFireEnv(fired, dt);

      // --- LOW band: Chebyshev recurrence × spectral envelope (coefs pre-rolled) ---
      const a1 = cd * PI_OVER_360;
      const c = Math.cos(a1), s = Math.sin(a1), twoC = 2 * c;
      let sp2 = 0, cp2 = 1, sp1 = s, cp1 = c;
      let tonal = iSin[0] * sp1 + iCos[0] * cp1;
      for (let p = 2; p <= N; p++) {
        const sp = twoC * sp1 - sp2, cp = twoC * cp1 - cp2;
        tonal += iSin[p - 1] * sp + iCos[p - 1] * cp;
        sp2 = sp1; sp1 = sp; cp2 = cp1; cp1 = cp;
      }

      // --- HIGH band: pressure envelope × pink residual → formants → HF LPF ---
      let high = 0;
      if (B && texG > 0) {
        // no Dirac: excitation is continuous pressure shape
        const jet = fireEnv * loadAmp;
        const pinkBed = residual * this._pink() * loadAmp * (0.15 + 0.85 * fireEnv);
        const exc = jet * 0.85 + pinkBed;
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

      // idle lope
      if (fired) {
        this.eventAmp = (this.rnd() < this.misfire) ? 0.25 : (1 + this.idleImb * (this.rnd() * 2 - 1));
        if (this.mValve || this.mInj) this.tickEnv = 1;
      }
      this.huntPhase += TWO_PI * this.huntHz * dt; if (this.huntPhase > TWO_PI) this.huntPhase -= TWO_PI;
      const lope = 1 + idleFactor * ((this.eventAmp - 1) + this.huntDepth * Math.sin(this.huntPhase));

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

      // body-first mix
      const bodyLift = 1.1 + 0.08 * this.tipIn - 0.04 * this.overrun;
      let mix = (tonal * bodyLift + high * texG * 0.55) * lope + mech * mechMask;

      // B) multi-pole tracker LPF on full path (3 cascaded one-poles)
      this.lp1 = mix + lpA * (this.lp1 - mix);
      this.lp2 = this.lp1 + lpA * (this.lp2 - this.lp1);
      this.lp3 = this.lp2 + lpA * (this.lp3 - this.lp2);
      mix = this.lp3;

      // D) non-linear analog saturation (required before destination)
      out[i] = this._saturate(mix);
    }
    return true;
  }
}

registerProcessor('vessel-runtime', VesselRuntime);
