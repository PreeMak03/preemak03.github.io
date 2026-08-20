/**
 * TAS regression bench — dev harness, not shipped.
 *
 * WHY IT EXISTS
 *   Every regression in this project has had the same shape: a value that
 *   controls several behaviours gets changed, and only the behaviour being
 *   targeted is re-measured. The one that quietly broke is always a different
 *   metric.
 *
 *     deadband killed the judder AND the rev wander
 *     moving gain past the limiter stopped pumping AND started clipping
 *     curving accelLoad fixed quiet light throttle AND made the revs twitchy
 *     stacking three gain changes stopped nothing AND pumped the limiter
 *
 *   Writing "re-measure the old metrics" in a note did not work. This does it
 *   instead: one call, every metric that has ever caught a defect here, scored
 *   against classic-muscle measured in the SAME session — absolute numbers
 *   drift between runs, differences do not.
 *
 * USAGE, in the page console with the engine started:
 *   await import('/vessel/tools/crank-bench.js');
 *   await bench2.runAll();            // classic + both CRANK cards
 *   await bench2.run('jz-crank');     // one card
 *
 * Everything here reads; nothing is changed. Run it before and after any patch
 * that touches an audio path.
 */

const KNEE = 0.82;          // where the brick-wall waveshaper starts shaping
const ST = 12 / Math.LN2;   // semitones per (drpm/dt)/rpm

const $ = (s) => document.querySelector(s);
const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const dB = (x) => 20 * Math.log10(Math.max(1e-6, x));
const mean = (a) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0);

/**
 * Thresholds. Expressed against classic-muscle wherever a difference is what
 * matters, because that is the profile the owner drives by.
 */
const LIMITS = {
  cruiseAboveClassicDb: [0, 5],   // "slightly louder than classic", his words
  pullBelowClassicDb: 7,          // how far under classic a full pull may sit
  rangeDb: 12,                    // dynamic volume has to actually do something
  limiterAvgDb: -2.5,             // beyond this a limiter is levelling => pumping
  pctClipped: 1.0,                // classic runs 0%; the wall is for rare peaks
  prePeak: 1.0,                   // anything over full scale is the wall's problem
  pitchP99: 140,                  // semitones/sec; judder lives above this
  cruiseWanderRpm: [15, 220],     // too little reads dead, too much reads hunting
  sideMid: 0.03,                  // below this it collapses to a point source
};


/**
 * The drive loop runs on requestAnimationFrame, which Chrome freezes entirely
 * in a hidden tab. Audio keeps playing and rpm keeps breathing, so a run in a
 * background tab produces a full table of confident numbers measured on a car
 * that never moved. Refuse to run rather than report fiction.
 */
async function assertLoopAlive() {
  let ticks = 0;
  const stop = Date.now() + 700;
  const loop = () => { ticks++; if (Date.now() < stop) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  await wait(800);
  if (ticks < 10) {
    throw new Error(
      `drive loop frozen (${ticks} rAF ticks in 0.7 s, visibilityState=${document.visibilityState}). ` +
      `Bring the tab to the front and run again — numbers measured now would come from a stationary car.`
    );
  }
  const ph = window.TAS && window.TAS.physics;
  if (ph && ph.targetSpeed > 5 && ph.vehicleSpeed === 0) {
    throw new Error('physics is not following targetSpeed — the sim slider is not driving the car.');
  }
  return ticks;
}

/**
 * Drive to a speed and wait until the car is actually there, then hold long
 * enough for the engine's own smoothing to settle. Polling beats a fixed sleep:
 * decelerating 150 -> 0 takes far longer than accelerating 0 -> 60, and a fixed
 * sleep silently mislabels the measurement that follows.
 */
async function settle(sl, speed, holdMs = 2500, timeoutMs = 20000) {
  sl.value = String(speed);
  sl.dispatchEvent(new Event('input', { bubbles: true }));
  const ph = window.TAS && window.TAS.physics;
  const tol = Math.max(2.5, speed * 0.06);
  const deadline = Date.now() + timeoutMs;
  if (ph) {
    while (Math.abs(ph.vehicleSpeed - speed) > tol) {
      if (Date.now() > deadline) {
        throw new Error(
          `settle(${speed}) timed out — car stuck at ${ph.vehicleSpeed.toFixed(1)} km/h. ` +
          `Not measuring what the label says.`
        );
      }
      await wait(60);
    }
  }
  await wait(holdMs);   // let rev smoothing and dynamic volume reach steady state
}

/** Pick the card and wait for the engine swap to finish. */
async function select(id) {
  const sc = $('#profile-scroller');
  const el = document.querySelector(`.pcard[data-profile-id="${id}"]`);
  if (!el) throw new Error(`no card ${id} — is Dev mode on?`);
  sc.scrollTo({ left: el.offsetLeft + el.offsetWidth / 2 - sc.clientWidth / 2, behavior: 'auto' });
  sc.dispatchEvent(new Event('scroll'));
  await wait(2400);
  return window.TAS.audio;
}

const bench2 = {
  /** One profile, every metric. */
  async run(id) {
    await assertLoopAlive();
    const a = await select(id);

    // Pin every level control the app exposes before measuring. Absolute dB is
    // meaningless without it: between two runs the master volume came back at a
    // different default and moved classic-muscle — which nothing had touched —
    // 2.6 dB, turning 0% brick-wall shaping into 2%. Differences taken WITHIN a
    // run (range, light lift) survive that; anything absolute does not.
    if (typeof a.setMasterVolume === 'function') a.setMasterVolume(1);
    if (typeof a.setBass === 'function') a.setBass(0.5);
    await wait(300);
    const ctx = a.ctx;
    const sl = $('#sim-speed');
    const an = a.getAnalyser();
    const buf = new Float32Array(an.fftSize);

    // CRANK exposes its chain on _nodes; the classic engine puts master on the
    // instance. Everything below degrades gracefully when a node is absent.
    const N = a._nodes || {};
    const masterNode = N.master || a.master;
    const limiter = N.limiter || a.limiter || null;

    // Tap ahead of the brick wall, to see what is actually arriving at it.
    const preTap = ctx.createAnalyser();
    preTap.fftSize = 2048;
    const pre = new Float32Array(2048);
    if (masterNode) masterNode.connect(preTap);

    // Stereo, for the point-source check.
    const split = ctx.createChannelSplitter(2);
    const L = ctx.createAnalyser(); const R = ctx.createAnalyser();
    L.fftSize = 2048; R.fftSize = 2048;
    const bl = new Float32Array(2048); const br = new Float32Array(2048);
    if (masterNode) { masterNode.connect(split); split.connect(L, 0); split.connect(R, 1); }

    const played = () =>
      a._voices ? a._voices[a._active].oscL.frequency.value
        : (a._layers && a._layers.low ? a._layers.low.src.playbackRate.value : 0);

    const grab = async (ms) => {
      const rms = []; const red = []; const side = []; const rpm = []; const freq = []; const effort = []; const accel = [];
      let peak = 0; let prePeak = 0; let over = 0; let total = 0; let nan = 0;
      const end = Date.now() + ms;
      while (Date.now() < end) {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          if (!Number.isFinite(v)) nan++;
          const x = Math.abs(v);
          if (x > peak) peak = x;
          s += v * v;
        }
        rms.push(Math.sqrt(s / buf.length));

        preTap.getFloatTimeDomainData(pre);
        for (let i = 0; i < pre.length; i++) {
          const x = Math.abs(pre[i]);
          total++;
          if (x > KNEE) over++;
          if (x > prePeak) prePeak = x;
        }

        L.getFloatTimeDomainData(bl); R.getFloatTimeDomainData(br);
        let dif = 0; let tot = 0;
        for (let i = 0; i < bl.length; i++) { dif += (bl[i] - br[i]) ** 2; tot += (bl[i] + br[i]) ** 2; }
        if (tot > 1e-12) side.push(Math.sqrt(dif / tot));

        if (limiter) red.push(limiter.reduction);
        rpm.push(a.rpm || 0);
        freq.push(played());
        effort.push(a._effort ?? 0);
        accel.push((window.TAS.physics && window.TAS.physics.accelKmhps) || 0);
        await wait();
      }
      return { rms: mean(rms), peak, prePeak, pctClipped: (100 * over) / Math.max(1, total),
        nan, red: mean(red), redWorst: red.length ? Math.min(...red) : 0,
        side: mean(side), rpm, freq,
        effortMax: effort.length ? Math.max(...effort) : 0,
        accelMax: accel.length ? Math.max(...accel) : 0 };
    };

    // --- the three operating points the owner actually describes -----------
    await settle(sl, 60, 3500);
    const cruise = await grab(2200);

    // light throttle: the case that was silent for weeks
    let v = 60;
    const iv = setInterval(() => {
      v += 3; sl.value = String(v); sl.dispatchEvent(new Event('input', { bubbles: true }));
    }, 1000);
    await wait(3000);
    const light = await grab(3000);
    clearInterval(iv);

    // A pull is the CLIMB, not the arrival. Settling at 150 and measuring there
    // measures a cruise at 150: the classic drive model ties revs to
    // acceleration, so once the car stops accelerating the revs and the
    // dynamic volume fall back to the gear floor. Measured directly: civic
    // dynGain read 0.493 mid-climb and 0.417 after arrival — the earlier
    // version of this bench was reporting the second number as "pull".
    await settle(sl, 0, 1200);
    sl.value = '140';
    sl.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(1500);                 // let the climb establish
    const pull = await grab(4000);    // sampled while the car is still climbing
    if (pull.accelMax < 3) {
      throw new Error(
        `pull window peaked at ${pull.accelMax.toFixed(1)} km/h/s — the car was not ` +
        `pulling. Not measuring what the label says.`
      );
    }

    // --- pitch rate through a full climb, which is where judder shows ------
    await settle(sl, 0, 1500);
    sl.value = '140'; sl.dispatchEvent(new Event('input', { bubbles: true }));
    const climb = await grab(6000);
    await settle(sl, 0, 500);

    const rates = [];
    for (let i = 1; i < climb.freq.length; i++) {
      const f0 = climb.freq[i - 1]; const f1 = climb.freq[i];
      if (f0 > 1 && f1 > 1) rates.push(Math.abs(12 * Math.log2(f1 / f0)) / 0.025);
    }
    rates.sort((x, y) => x - y);

    const wander = Math.max(...cruise.rpm) - Math.min(...cruise.rpm);

    if (masterNode) {
      try { masterNode.disconnect(preTap); } catch (_) {}
      try { masterNode.disconnect(split); } catch (_) {}
    }

    return {
      id,
      cruiseDb: +dB(cruise.rms).toFixed(1),
      lightDb: +dB(light.rms).toFixed(1),
      pullDb: +dB(pull.rms).toFixed(1),
      rangeDb: +(dB(pull.rms) - dB(cruise.rms)).toFixed(1),
      lightLiftDb: +(dB(light.rms) - dB(cruise.rms)).toFixed(1),
      limiterAvgDb: +pull.red.toFixed(2),
      limiterWorstDb: +pull.redWorst.toFixed(2),
      prePeak: +pull.prePeak.toFixed(3),
      pctClipped: +pull.pctClipped.toFixed(1),
      pitchP90: +(rates[Math.floor(rates.length * 0.9)] || 0).toFixed(1),
      pitchP99: +(rates[Math.floor(rates.length * 0.99)] || 0).toFixed(1),
      pullEffortMax: +pull.effortMax.toFixed(2),
      pullAccelMax: +pull.accelMax.toFixed(1),
      master: a._masterOverride ?? a.masterVolume ?? null,
      bass: a._bass ?? null,
      cruiseWanderRpm: +wander.toFixed(0),
      sideMid: +mean([cruise.side, light.side, pull.side]).toFixed(3),
      peak: +Math.max(cruise.peak, light.peak, pull.peak).toFixed(3),
      nan: cruise.nan + light.nan + pull.nan,
      tickMs: a._tickJitterMs != null ? +a._tickJitterMs.toFixed(2) : null,
    };
  },

  /** Score a CRANK result against classic measured in the same session. */
  score(r, classic) {
    const f = [];
    const cruiseVs = +(r.cruiseDb - classic.cruiseDb).toFixed(1);
    const pullVs = +(classic.pullDb - r.pullDb).toFixed(1);
    const [lo, hi] = LIMITS.cruiseAboveClassicDb;
    if (cruiseVs < lo || cruiseVs > hi) f.push(`cruise ${cruiseVs >= 0 ? '+' : ''}${cruiseVs} dB vs classic (want ${lo}..${hi})`);
    if (pullVs > LIMITS.pullBelowClassicDb) f.push(`pull ${pullVs} dB under classic (max ${LIMITS.pullBelowClassicDb})`);
    if (r.rangeDb < LIMITS.rangeDb) f.push(`range ${r.rangeDb} dB (min ${LIMITS.rangeDb}) — dynamic volume not doing much`);
    if (r.lightLiftDb < 2) f.push(`light throttle only +${r.lightLiftDb} dB over cruise — inaudible`);
    if (r.limiterAvgDb < LIMITS.limiterAvgDb) f.push(`limiter ${r.limiterAvgDb} dB average — levelling, will pump`);
    if (r.pctClipped > LIMITS.pctClipped) f.push(`${r.pctClipped}% of samples in the brick wall (max ${LIMITS.pctClipped}%)`);
    if (r.prePeak > LIMITS.prePeak) f.push(`peak ${r.prePeak} arriving at the wall (max ${LIMITS.prePeak})`);
    if (r.pitchP99 > LIMITS.pitchP99) f.push(`pitch p99 ${r.pitchP99} st/s (max ${LIMITS.pitchP99}) — judder`);
    const [wlo, whi] = LIMITS.cruiseWanderRpm;
    if (r.cruiseWanderRpm < wlo) f.push(`cruise wander ${r.cruiseWanderRpm} rpm — reads dead`);
    if (r.cruiseWanderRpm > whi) f.push(`cruise wander ${r.cruiseWanderRpm} rpm — reads like hunting`);
    if (r.sideMid < LIMITS.sideMid) f.push(`side/mid ${r.sideMid} — collapsing to a point source`);
    if (r.nan > 0) f.push(`${r.nan} non-finite samples`);
    if (r.peak >= 0.999) f.push('clipping at full scale');
    return f;
  },

  /** Classic first as the reference, then every CRANK card. */
  async runAll(ids = ['jz-crank', 'civic-crank']) {
    const classic = await this.run('classic-muscle');
    const rows = [classic];
    const verdicts = {};
    for (const id of ids) {
      const r = await this.run(id);
      rows.push(r);
      verdicts[id] = this.score(r, classic);
    }
    console.table(rows);
    for (const [id, f] of Object.entries(verdicts)) {
      if (f.length) { console.warn(`FAIL ${id}`); f.forEach((x) => console.warn('   ' + x)); }
      else console.log(`PASS ${id}`);
    }
    return { rows, verdicts };
  },
};

window.bench2 = bench2;
export default bench2;
