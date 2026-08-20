/**
 * CRANK judder bench — dev harness, not shipped.
 *
 * Reproduces the case the owner reports: the car HOLDING a speed while the
 * engine warbles. The app's sim slider cannot show this because it delivers
 * perfectly smooth speed; a real GPS delivers ~1 fix/s with noise, and the app
 * differentiates that to get acceleration.
 *
 * Usage in the page console:
 *   await bench.rig('jz-crank'); await bench.suite();
 */

/** Seeded RNG so an A/B between two builds compares the same noise. */
function mkRnd(seed) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
}

const bench = {
  a: null,

  /** Rig the CLASSIC engine instead, as the reference mechanism. */
  async rigClassic(id = 'classic-muscle') {
    if (this.a) { try { this.a.stop(); } catch (_) {} this.a = null; }
    const { AudioEngine } = await import(`/js/audio-engine.js?v=${Date.now()}`);
    const m = await import('/js/profiles.js');
    await m.loadClassicStandards();
    const a = new AudioEngine();
    a.setProfile(m.getProfileById(id));
    await a.start();
    a.setMasterVolume(0.0001);
    this.a = a;
    this.classic = true;
    return `${id} (classic) · pitchCeiling=${a._rpmCeiling}`;
  },

  /** Whatever the engine actually plays, as a frequency. */
  played() {
    const a = this.a;
    if (this.classic) {
      const src = a._layers && a._layers.low && a._layers.low.src;
      return src ? src.playbackRate.value : 0;
    }
    return a._voices ? a._voices[a._active].oscL.frequency.value : 0;
  },

  async rig(id = 'jz-crank') {
    this.classic = false;
    // Chrome caps how many AudioContexts a page may hold; leaking one per rig
    // silently starts handing back contexts that never run, which quietly
    // invalidates every measurement taken after it.
    if (this.a) { try { this.a.stop(); } catch (_) {} this.a = null; }
    const { CrankAudio } = await import(`/js/crank-audio.js?v=${Date.now()}`);
    const { getProfileById } = await import('/js/profiles.js');
    const a = new CrankAudio();
    a.setProfile(getProfileById(id));
    await a.start();
    a.setMasterVolume(0.0001);          // measuring the maths, not the room
    this.a = a;
    return `${id} · mechSweep=${a._drive.mechSweep} liftFloor=${a._drive.liftFloor}`;
  },

  /** Reach the hold speed from BELOW so gear hysteresis lands where real
   *  driving would put it — and never leaves the revs sitting on a clamp. */
  async settle(sp) {
    const a = this.a;
    for (let i = 0; i < 20; i++) { a.setSpeed(0, { accelKmhps: 0 }); await this.wait(); }
    for (let i = 0; i <= 60; i++) { a.setSpeed((sp * i) / 60, { accelKmhps: 8 }); await this.wait(); }
    for (let i = 0; i < 200; i++) { a.setSpeed(sp, { accelKmhps: 0 }); await this.wait(); }
  },

  wait(ms = 25) { return new Promise((r) => setTimeout(r, ms)); },

  /** Hold a speed while GPS delivers noisy 1 Hz fixes. */
  async hold({ label, holdSpeed, excursionKmh = 0, featherHz = 0.5, noiseKmh, seed, seconds = 16 }) {
    const a = this.a;
    await this.settle(holdSpeed);
    const rnd = mkRnd(seed);
    const gear0 = a.gearIndex;
    let prevSpeed = null, prevT = 0, reported = holdSpeed, accel = 0, lastFix = 0;
    const R = [], AL = [], F = [];
    const t0 = performance.now();
    while ((performance.now() - t0) / 1000 < seconds) {
      const t = (performance.now() - t0) / 1000;
      const trueSpeed = holdSpeed + excursionKmh * Math.sin(2 * Math.PI * featherHz * t);
      if (t - lastFix >= 1.0) {                       // GPS fix rate
        lastFix = t;
        reported = trueSpeed + (rnd() * 2 - 1) * noiseKmh;
        if (prevSpeed != null) accel = (reported - prevSpeed) / (t - prevT);
        prevSpeed = reported; prevT = t;
      }
      a.setSpeed(reported, { accelKmhps: accel });
      R.push(a.rpm); AL.push(accel);
      // The ear hears the OSCILLATOR, not the model's rpm. Once a pitch ceiling
      // maps one onto the other they are no longer the same number, so the
      // judder metric has to come from the played frequency.
      F.push(this.played());
      await this.wait();
    }
    const mean = (x) => x.reduce((p, c) => p + c, 0) / x.length;
    const sd = (x) => { const m = mean(x); return Math.sqrt(mean(x.map((v) => (v - m) ** 2))); };
    // Pitch statistics from the played frequency.
    let mx = 0; const rates = [];
    for (let i = 1; i < F.length; i++) {
      if (F[i] > 1 && F[i - 1] > 1) {
        const r = Math.abs(12 * Math.log2(F[i] / F[i - 1])) / 0.025;
        rates.push(r); if (r > mx) mx = r;
      }
    }
    rates.sort((x, y) => x - y);
    const swing = Math.max(...R) - Math.min(...R);
    const fSwingSt = 12 * Math.log2(Math.max(...F) / Math.max(1e-6, Math.min(...F)));
    return {
      label, gear: gear0, meanRpm: +mean(R).toFixed(0), swingRpm: +swing.toFixed(0),
      playedSwingSt: +fSwingSt.toFixed(2),
      pitchP90: +(rates[Math.floor(rates.length * 0.9)] || 0).toFixed(2),
      pitchMax: +mx.toFixed(1), accelSd: +sd(AL).toFixed(2),
    };
  },

  /** A genuine pull — the fix must not cost responsiveness. */
  async pull() {
    const a = this.a;
    await this.settle(60);
    const base = a.rpm; const S = []; const t0 = performance.now();
    while ((performance.now() - t0) / 1000 < 3) {
      const t = (performance.now() - t0) / 1000;
      a.setSpeed(60 + 25 * t, { accelKmhps: 25 });
      S.push({ t, r: a.rpm });
      await this.wait();
    }
    const at = (x) => (S.find((p) => p.t >= x) || {}).r;
    return {
      label: 'H hard pull', baseRpm: +base.toFixed(0), at0s3: +at(0.3).toFixed(0),
      at0s6: +at(0.6).toFixed(0), finalRpm: +S[S.length - 1].r.toFixed(0),
    };
  },

  async suite() {
    const res = [];
    res.push(await this.hold({ label: 'D steady 60, good GPS', holdSpeed: 60, noiseKmh: 0.6, seed: 11 }));
    res.push(await this.hold({ label: 'E feathering 60', holdSpeed: 60, excursionKmh: 1.0, noiseKmh: 0.5, seed: 22 }));
    res.push(await this.hold({ label: 'G city 60, poor GPS', holdSpeed: 60, excursionKmh: 1.5, featherHz: 0.3, noiseKmh: 1.0, seed: 33 }));
    res.push(await this.pull());
    return res;
  },
};

window.bench = bench;
export default bench;
