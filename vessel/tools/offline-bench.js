/**
 * TAS offline bench — dev harness, not shipped.
 *
 * WHY IT EXISTS
 *   The judder hunt cost several in-car drives and a run of wrong theories, and
 *   the cause was two oscillators ten cents apart beating against each other.
 *   It was never load. It would have happened on any machine. Every instrument
 *   we had needed a car, a driver and a live clock to see it, and each one lied
 *   in its own way:
 *
 *     crank-bench   drives the app on rAF, which Chrome freezes in a hidden
 *                   tab — it refuses to run rather than measure a parked car
 *     live A/B      the drive model pulls rpm to idle under a constant speed,
 *                   so the two halves get compared at different rpm
 *     the car        one number per drive, days apart, nothing held still
 *
 *   OfflineAudioContext has none of those problems. It renders the REAL node
 *   graph faster than real time, ignores tab visibility and has no timer
 *   jitter. Run it before shipping anything on an audio path and the
 *   before/after arrives without leaving the desk.
 *
 * IT IS NOT DETERMINISTIC, AND THAT MATTERS
 *   The engine breathes on Math.random() — rev wander, idle hunt, exhaust pops.
 *   Four renders of identical code spread 1.3 dB at idle, 0.8 through a pull,
 *   0.7 at cruise. So a single pair of numbers cannot tell a fix from a coin
 *   toss, and the first thing this bench reported was a 0.7 dB "regression"
 *   that was noise. compare() therefore renders each side `repeats` times and
 *   refuses to call anything real unless it clears that profile's own measured
 *   spread. Read the verdict, not the delta.
 *
 * USAGE, in the page console:
 *   const b = await import('/vessel/tools/offline-bench.js');
 *   await b.runAll();                          // classic + both CRANK
 *   await b.runAll(null, 'full');              // same, driven flat out
 *   await b.run('jz-crank');                   // one
 *   await b.compare('jz-crank', (v) => {       // measure a change against today
 *     v.oscL.detune.value = -5;
 *     v.oscR.detune.value = 5;
 *     v.preShape.gain.value = 1;
 *   });
 *
 * WHAT IT MEASURES
 *   swingDb      dB of level modulation over 0.5 s, per drive phase. The one
 *                that catches beating, pumping and dropouts. Steady phases
 *                belong near zero.
 *   crestDb      peak over rms — the ceiling on how loud this engine can ever
 *                be before the wall grabs it.
 *   clipPct      samples at full scale. Classic runs 0.
 *   offOrder     static wavetable check: energy on harmonics that are not
 *                multiples of the cylinder count. A question, never a verdict —
 *                some of it is deliberate and correct. Read the note on the
 *                function before calling any of it a bug.
 */

import { CrankAudio } from '/js/crank-audio.js';
import { AudioEngine } from '/js/audio-engine.js';
import { getProfileById } from '/js/profiles.js';
import { VehiclePhysics } from '/js/vehicle-physics.js';
import { engageManual, releaseManual, shiftManual } from '/js/gearbox.js';

const SR = 48000;
const QUANTUM = 128;
const STEP = QUANTUM * 8;              // 1024 frames = 21.3 ms; the engine ticks 20
const SECS = 19;
const dbOf = (x) => 20 * Math.log10(Math.max(1e-9, x));

/**
 * One drive, shared by every profile so the numbers compare. The script sets a
 * TARGET and lets the real VehiclePhysics produce speed, accel, throttle and
 * brake — the same four values app.js hands the engine. A first cut fed bare
 * setSpeed(kmh) and the revs never passed 1992 against ~4200 in the app, which
 * is the whole failure mode this bench exists to avoid: an instrument that
 * drives the engine differently from the product reports on a car nobody owns.
 *
 * The target ramps at 16 km/h/s — the Model 3 Standard figure the owner tunes
 * against, and the pace he actually drives.
 *
 * `from` is where measurement starts, not where the phase starts: the first
 * 0.7 s is the starter motor cranking at 240 rpm, which is not idle and would
 * dominate the idle numbers.
 */
const SCRIPTS = {
  // How he actually drives. Peaks here are the peaks he hears.
  owner: [
    { from: 1.2, until: 3,  phase: 'idle',   target: () => 0 },
    { from: 3.4, until: 10, phase: 'pull',   target: (t) => Math.min(112, (t - 3) * 16) },
    { from: 10.4, until: 15, phase: 'cruise', target: () => 112 },
    { from: 15.4, until: 19, phase: 'lift',   target: () => 40 },
  ],
  // Manual mode, which had never been benched at all despite being live for
  // users. `shifts` are {t, dir}; `lift` is how long the throttle is off around
  // each one, because whether the driver lifts to shift decides which fall rate
  // applies and that is the whole question.
  manual: [
    { from: 1.2, until: 3,  phase: 'idle',   target: () => 0 },
    { from: 3.4, until: 16, phase: 'pull',   target: (t) => Math.min(150, (t - 3) * 16) },
    { from: 16.4, until: 19, phase: 'lift',   target: () => 40 },
  ],
  // Everything the physics will give, for headroom questions only. A headroom
  // claim measured on a gentle drive is how "4-8 dB spare" got reported once
  // and was wrong: the loud case was never rendered.
  full: [
    { from: 1.2, until: 3,  phase: 'idle',   target: () => 0 },
    { from: 3.2, until: 10, phase: 'pull',   target: () => 180 },
    { from: 10.4, until: 15, phase: 'cruise', target: () => 180 },
    { from: 15.4, until: 19, phase: 'lift',   target: () => 40 },
  ],
};
const SCRIPT = SCRIPTS.owner;

function phaseAt(t, script) {
  for (const s of script) if (t < s.until) return s;
  return script[script.length - 1];
}

/** Assert the render actually exercised the engine, rather than reporting on a
 *  car that never left idle. Every metric below is meaningless without this. */
function assertDriven(log, spec) {
  const rpms = log.map((x) => x.rpm).filter(Number.isFinite);
  const top = Math.max(...rpms);
  const reached = top / spec.redlineRpm;
  if (reached < 0.35) {
    throw new Error(
      `render never loaded the engine: peak ${Math.round(top)} rpm is ${(reached * 100).toFixed(0)}% ` +
      `of a ${spec.redlineRpm} redline. The drive inputs are wrong, not the audio.`);
  }
  const pull = log.filter((x) => x.phase === 'pull');
  if (pull.length && Math.max(...pull.map((x) => x.speed)) < 60) {
    throw new Error('render never got the car moving; check VehiclePhysics limits');
  }
}

/**
 * Render one profile through SCRIPT. `tweak` runs once on every live voice just
 * after the graph is built, which is how a before/after gets measured without
 * editing source between the two runs.
 */
const MANUAL_SHIFTS = [
  { t: 5.5, dir: 1 }, { t: 8.0, dir: 1 }, { t: 10.5, dir: 1 }, { t: 13.0, dir: 1 },
];
const MANUAL_LIFT_S = 0.35;   // throttle off around each shift, as a driver does

export async function render(profileId, tweak, scriptName = 'owner') {
  const script = SCRIPTS[scriptName] || SCRIPTS.owner;
  const manual = scriptName === 'manual';
  const profile = getProfileById(profileId);
  if (!profile) throw new Error(`no such profile: ${profileId}`);
  const oc = new OfflineAudioContext(2, SR * SECS, SR);
  // CRANK ticks _tick(dt); classic ticks update(dt). Same seam, different name.
  const isCrank = !!profile.crank;
  const audio = isCrank ? new CrankAudio() : new AudioEngine();
  audio.setProfile(profile);
  await audio.start({ ctx: oc, manualTick: true });
  const tick = isCrank ? (dt) => audio._tick(dt) : (dt) => audio.update(dt);
  if (tweak && audio._voices) for (const k of Object.keys(audio._voices)) tweak(audio._voices[k], audio);
  else if (tweak) tweak(null, audio);

  const dt = STEP / SR;
  const physics = new VehiclePhysics();
  const log = [];
  if (manual) engageManual(1);
  const shifted = new Set();
  for (let f = 0; f + STEP <= SR * SECS; f += STEP) {
    const t = f / SR;
    oc.suspend(t).then(() => {
      const ph = phaseAt(t, script);
      physics.setTarget(Math.max(0, ph.target(t)));
      const p = physics.update(dt);
      let thr = p.throttle;
      let acc = p.accelKmhps;
      if (manual) {
        for (const sh of MANUAL_SHIFTS) {
          if (t >= sh.t && !shifted.has(sh.t)) { shiftManual(sh.dir); shifted.add(sh.t); }
          // The driver lifts across the shift. accel has to go with the pedal,
          // or the engine is told the car is still pulling while the throttle
          // is shut and the blip path never arms.
          if (Math.abs(t - sh.t) < MANUAL_LIFT_S) { thr = 0; acc = Math.min(acc, 0); }
        }
      }
      audio.setSpeed(p.speed, { throttle: thr, brake: p.brake, accelKmhps: acc });
      tick(dt);
      log.push({ t, phase: ph.phase, rpm: audio.rpm, speed: p.speed, accel: p.accelKmhps });
      oc.resume();
    });
  }
  const buf = await oc.startRendering();
  if (manual) releaseManual();
  audio.running = false;                 // never stop(): the context is not ours
  assertDriven(log, audio._spec || {
    redlineRpm: (profile.engine && profile.engine.redlineRpm) || 7000,
  });
  return { buf, log, audio, isCrank, script };
}

/** Level-modulation depth over a 0.5 s window — the metric the car reports. */
function swing(mono, from, to) {
  const N = 2048, hop = SR / 50, win = [];
  for (let i = from; i + N <= to; i += hop) {
    let s = 0;
    for (let k = i; k < i + N; k++) s += mono[k] * mono[k];
    win.push(Math.sqrt(s / N));
  }
  const out = [];
  for (let i = 25; i < win.length; i++) {
    const w = win.slice(i - 25, i + 1);
    const hi = Math.max(...w), lo = Math.min(...w);
    if (lo > 1e-7) out.push(dbOf(hi / lo));
  }
  if (!out.length) return { p50: 0, p95: 0 };
  out.sort((a, b) => a - b);
  return {
    p50: +out[out.length >> 1].toFixed(1),
    p95: +out[Math.floor(out.length * 0.95)].toFixed(1),
  };
}

/**
 * An even-firing four-stroke fires `cylinders` times per 720 degrees, so a
 * table with perfectly identical pulses carries energy ONLY on multiples of the
 * cylinder count. Anything else is off-order: at cruise the table repeats at
 * rpm/120, so a first harmonic puts 15-30 Hz into the cabin.
 *
 * READ THIS BEFORE CALLING IT A BUG. Off-order energy is not automatically a
 * defect — it is what makes a four sound like a four instead of a synth. Real
 * cylinders are not identical, and build-crank models that: the I4 tables set
 * cylinders 2 and 3 to 0.94 because the inner runners are longer on a 4-into-1
 * header. That single line is the whole of civic's -15.5 dB; set the pulses
 * equal and it drops to -240, i.e. exactly zero.
 *
 * So use this to spot the UNEXPLAINED. jz reads -66.7 because an I6 is modelled
 * as balanced; civic reads -15.5 on purpose, and its measured cruise swing
 * (1.1 dB) is better than jz's. A number here is a question, not a verdict —
 * and this comment exists because the first reading of it produced two wrong
 * diagnoses in one day.
 */
export function offOrder(doc) {
  const cyl = doc.spec.cylinders;
  const W = doc.waves.base.left;
  const mag = (h) => Math.hypot(W.real[h] || 0, W.imag[h] || 0);
  let on = 0, off = 0, peak = 0, worst = { h: 0, db: -99 };
  for (let h = 1; h < W.real.length; h++) {
    const m = mag(h);
    if (m > peak) peak = m;
    if (h % cyl === 0) on += m * m; else off += m * m;
  }
  for (let h = 1; h < W.real.length; h++) {
    if (h % cyl === 0) continue;
    const db = dbOf(mag(h) / Math.max(1e-12, peak));
    if (db > worst.db) worst = { h, db: +db.toFixed(0) };
  }
  return {
    cyl,
    ratioDb: +dbOf(Math.sqrt(off / Math.max(1e-12, on))).toFixed(1),
    worstHarmonic: worst.h,
    worstDb: worst.db,
  };
}

export async function run(profileId, tweak, scriptName = 'owner') {
  const { buf, log, isCrank, script } = await render(profileId, tweak, scriptName);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;

  let sum = 0, peak = 0, clipped = 0;
  for (let i = 0; i < mono.length; i++) {
    sum += mono[i] * mono[i];
    const a = Math.abs(mono[i]);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
  }
  const rms = Math.sqrt(sum / mono.length);

  const swingDb = {};
  for (const s of script) {
    swingDb[s.phase] = swing(mono, Math.floor(s.from * SR), Math.floor(s.until * SR));
  }
  const drivenRpm = log.filter((x) => x.t > 1.2).map((x) => x.rpm).filter(Number.isFinite);
  // offOrder reads a compiled firing table, which only CRANK profiles have.
  let oo = null;
  if (isCrank) {
    const doc = await (await fetch(`/assets/crank/${profileId.replace('-crank', '')}.crank.json`)).json();
    oo = offOrder(doc);
  }

  return {
    profile: profileId,
    drive: scriptName,
    rpmRange: [Math.round(Math.min(...drivenRpm)), Math.round(Math.max(...drivenRpm))],
    topSpeed: Math.round(Math.max(...log.map((x) => x.speed))),
    swingDb,
    rmsDb: +dbOf(rms).toFixed(2),
    crestDb: +dbOf(peak / rms).toFixed(1),
    peak: +peak.toFixed(3),
    clipPct: +((clipped / mono.length) * 100).toFixed(3),
    offOrder: oo,
  };
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const range = (a) => Math.max(...a) - Math.min(...a);

/**
 * Before/after — same build, same session, nothing rebuilt between them.
 * `before` is a function applied to each voice to restore the OLD behaviour, so
 * the two sides differ only by the thing under test.
 *
 * Each side renders `repeats` times. The spread within a side is that phase's
 * noise floor; a delta smaller than the larger of the two spreads is reported
 * as noise, because that is what it is.
 */
export async function compare(profileId, before, { repeats = 3 } = {}) {
  const side = async (tweak) => {
    const runs = [];
    for (let i = 0; i < repeats; i++) runs.push(await run(profileId, tweak));
    return runs;
  };
  const A = await side(before);
  const B = await side(null);

  const phases = SCRIPTS.owner.map((s) => s.phase);
  const swing = {};
  for (const p of phases) {
    const a = A.map((r) => r.swingDb[p].p50);
    const b = B.map((r) => r.swingDb[p].p50);
    const delta = median(b) - median(a);
    const noise = Math.max(range(a), range(b));
    swing[p] = {
      before: +median(a).toFixed(1),
      after: +median(b).toFixed(1),
      deltaDb: +delta.toFixed(1),
      noiseDb: +noise.toFixed(1),
      verdict: Math.abs(delta) <= noise ? 'noise'
        : (delta < 0 ? 'BETTER' : 'WORSE'),
    };
  }
  const ra = A.map((r) => r.rmsDb), rb = B.map((r) => r.rmsDb);
  return {
    profile: profileId,
    repeats,
    swing,
    dLevelDb: +(median(rb) - median(ra)).toFixed(2),
    levelNoiseDb: +Math.max(range(ra), range(rb)).toFixed(2),
    clip: { before: median(A.map((r) => r.clipPct)), after: median(B.map((r) => r.clipPct)) },
    crest: { before: median(A.map((r) => r.crestDb)), after: median(B.map((r) => r.crestDb)) },
  };
}

/**
 * Every profile the bench can drive, CRANK and classic alike. classic is where
 * most users actually live and had never been measured this way — the whole
 * judder hunt compared CRANK against a reference nobody had put on a bench.
 */
export async function runAll(ids, scriptName = 'owner') {
  const list = ids || ['classic-muscle', 'jz-crank', 'civic-crank'];
  const out = [];
  for (const id of list) {
    try { out.push(await run(id, null, scriptName)); }
    catch (e) { out.push({ profile: id, error: String(e.message || e) }); }
  }
  return out;
}

if (typeof window !== 'undefined') {
  window.offlineBench = { run, runAll, compare, render, offOrder };
}
export default { run, runAll, compare, render, offOrder };
