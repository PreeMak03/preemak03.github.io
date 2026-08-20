#!/usr/bin/env node
/**
 * CRANK profile compiler  —  spec  →  assets/crank/{id}.crank.json
 *
 * WHY THIS EXISTS (Lab / Runtime split, same law as VESSEL):
 *   The CRANK prototype builds its voice by (a) laying every cylinder's pressure
 *   pulse onto a 720 deg crank table, then (b) running a 384-harmonic DFT over
 *   that table to get the coefficients for `createPeriodicWave`.
 *   Step (b) is ~800k float ops per wave, three waves per profile (L / R / mono),
 *   doubled again for a VTEC cam. On an MCU that is a visible hitch every time a
 *   card is selected — exactly the spike we must not ship.
 *
 *   So it runs HERE, offline, once. The webapp only ever sees the finished
 *   coefficients and calls createPeriodicWave(). No DFT, no table build, no
 *   allocation at runtime.
 *
 * Source of the physics + numbers: the CRANK prototype (soundforpreemak.grok.me),
 * ported 1:1 so the voice the owner approved is the voice TAS plays.
 *
 * Usage:  node vessel/tools/build-crank.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'assets', 'crank');

/* ---------------------------------------------------------------- specs -- */
/**
 * Engine specs, verbatim from the CRANK prototype.
 *   pulseWidthDeg / pulseDecayDeg  shape of one cylinder's pressure pulse
 *   harmonicTilt                   1/n^tilt spectral slope (low = bright)
 *   exhaustHz / exhaustHz2         the two tailpipe resonances
 *   intakeHz                       intake runner resonance
 *   pipeM                          pipe length in metres -> delay time
 *   inertia                        rotating-mass feel (drive model)
 *   vtecRpm                        cam crossover (vtec induction only)
 */
const SPECS = [
  {
    id: 'jz', code: '1JZ', name: '1JZ-GTE', car: 'Toyota JZA70 / JZX90',
    layout: 'inline', cylinders: 6, vAngle: 0, displacementL: 2.5,
    // Gen 1 (1990-1995) factory figures: 280 PS @ 6200, 363 Nm @ 4800,
    // 8.5:1, twin CT12A at 0.7 bar (10 psi).
    idleRpm: 750, redlineRpm: 7200, peakTorqueRpm: 4800,
    firing: 'even', pulseWidthDeg: 38, pulseDecayDeg: 58,
    harmonicTilt: 1.35, rasp: 0.22, body: 0.86, brightness: 0.48,
    intakeHz: 1380, exhaustHz: 275, exhaustHz2: 540,
    pipeM: 1.45, delayMix: 0.14, idleHunt: 4,
    induction: 'turbo', itb: false, overrun: 0.12,
    stereoWidth: 0.18, inertia: 0.95, vtecRpm: 0,
    // CORRECTION vs the prototype: the Gen-1 1JZ-GTE runs its two CT12A turbos
    // in PARALLEL — one turbo per bank of three cylinders. It is the 2JZ-GTE
    // that is sequential. So there is no second-turbo handover step; what you
    // hear is one early threshold and one continuous swell.
    notes: '2.5L closed-deck I6. Parallel twin CT12A, 0.7 bar. Silk, then spool.',
    boostBar: 0.7,                                      // factory 10 psi
    // Overrides — rev window only. Glide, inertia and the boost curve are
    // derived from the numbers above by the CRANK type defaults.
    drive: { revLo: 0.16, revHi: 0.52, revPull: 0.88 },
    dynamics: { idlePresence: 0.72 },
  },
  {
    id: 'civic', code: 'Civic', name: 'K20A', car: 'Civic Type R',
    layout: 'inline', cylinders: 4, vAngle: 0, displacementL: 2,
    idleRpm: 850, redlineRpm: 8400, peakTorqueRpm: 6200,
    firing: 'even', pulseWidthDeg: 32, pulseDecayDeg: 48,
    harmonicTilt: 1.08, rasp: 0.42, body: 0.4, brightness: 0.7,
    intakeHz: 2380, exhaustHz: 210, exhaustHz2: 1080,
    pipeM: 1.08, delayMix: 0.28, idleHunt: 8,
    induction: 'vtec', itb: false, overrun: 0.35,
    stereoWidth: 0.22, inertia: 0.5, vtecRpm: 5800,
    notes: '2.0 I4. i-VTEC locks a wilder cam at ~5,800 rpm.',
    drive: { revLo: 0.18, revHi: 0.58, revPull: 0.92 },
    dynamics: { idlePresence: 0.68 },
  },
];

/** Mixer defaults, verbatim from the prototype. */
const MIXER = { exhaust: 0.92, intake: 0.58, mechanical: 0.34, induction: 0.46, master: 0.72 };

/* ============================================================================
 * CRANK TYPE DEFAULTS
 *
 * Everything below applies to EVERY CRANK profile — the ones here today and any
 * engine added later — because it is DERIVED from the spec, not typed in per
 * engine. A spec may still override any single field via `drive:{}` /
 * `dynamics:{}` / `boost:{}`, but it never has to, and nothing can ship without
 * the anti-judder and forced-induction behaviour by forgetting to paste it.
 * ==========================================================================*/

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Rev window for the TAS virtual gearbox. Per-engine character; overridable. */
const DRIVE_BASE = { revLo: 0.17, revHi: 0.55, revPull: 0.9, floorLo: 1300, floorHi: 1800 };

/** In-car loudness curve (js/dynamic-volume.js). Gentle by default. */
// shiftDuck / overrunDuck are classic-muscle's values. CRANK's own were 0.4 and
// 0.7, i.e. -8 dB on every gear change and -3 dB entering overrun, against
// classic's -0.9 dB for both. That is not a duck, it is a hole, and it lands
// exactly where the owner hears the sound break up.
// dynDb 18 (not 7) and the loadBoost/floorBias pair. Measured against
// classic-muscle in the same session: at dynDb 7 CRANK sat 8.5 dB louder than
// classic at cruise with less than half its dynamic range, which is why dynamic
// volume was inaudible in the car.
const DYN_BASE = {
  dynDb: 16, dynCeiling: 0.5, shiftDuck: 0.9, overrunDuck: 0.9,
  idlePresence: 0.55, loadBoost: 0.22, floorBias: 0.7,
};

/**
 * How much acceleration counts as "full load".
 *
 * accelLoad = accel / accelRef, so a BIGGER number is LESS sensitive. The
 * classic engines use 26; CRANK reads as twitchier on the same input because
 * one oscillator turns load straight into pitch and level with nothing masking
 * it, so it gets a slacker reference.
 */
const ACCEL_REF_KMHPS = 28;

/**
 * Shapes how light acceleration lands. accelLoad ** this, so a value below 1
 * lifts the small-but-real end while leaving full throttle alone (1 ** k is 1).
 *
 * Without it, easing up at 3 km/h/s came out at exactly the cruise level: the
 * 1.5 km/h/s deadband takes the first slice, and what survives divides by
 * accelRef into almost nothing. That is why light acceleration needed the car
 * at 85% while a hard pull was right at 65%.
 */
const ACCEL_CURVE = 0.65;

/**
 * Cabin staging. Starts from the classic engine's layout, then pushes further
 * back and wider than classic does, which is what the owner asked for.
 *
 *   crossoverHz  how much of the engine is treated as "exhaust" and sent behind
 *                you. Raising it moves more of the body rearward.
 *   rearGain     how loud that rear image is against the dry front.
 *   rearZ        how far behind. Further = more clearly not in front of you.
 *   reverbWet    the decorrelated stereo tail. This is what actually produces
 *                side energy, and side energy is what Tesla's Immersive Sound
 *                upmixer needs in order to feed the rear speakers at all.
 *
 * Measured side/mid: classic-muscle 0.061, CRANK on classic's own values 0.035.
 */
const SPACE = {
  crossoverHz: 420,
  rearDelaySec: 0.024,
  rearZ: 2.4,
  rearGain: 1.45,
  frontGain: 0.9,
  reverbSec: 0.3,
  reverbDecay: 3.2,
  reverbWet: 0.22,
  frontSend: 0.45,
};

/** Slider 100 lands here. The mix is conservative, so 100 alone was quiet. */
// Level lives AFTER the limiter on purpose. Putting it before would feed the
// limiter a hotter signal and bring back the multi-dB gain reduction that was
// pumping; after it, the only thing in the way is the memoryless brick wall,
// which cannot pump because it has no time constants.
/**
 * Level, before the limiter. Bounded by CREST FACTOR, not by taste.
 *
 * Measured at full pull, peak against RMS: classic-muscle runs about 2 dB of
 * crest and never touches its brick wall. CRANK runs about 10 dB — sharp
 * exhaust pulses over a much lower average — so the same RMS arrives with peaks
 * four times higher. Push the level for loudness and those peaks land in the
 * wall, and 15-20% of samples being shaped is what the owner heard as heavy
 * judder. This is set where the wall goes idle, and cannot go higher until the
 * VOICE is made denser, which is a tone change and not one to sneak in.
 */
const MASTER_SCALE = 0.88;

/**
 * Output trim — levels the CARDS, not the engines.
 *
 * `body` is a voicing figure (1JZ 0.86, K20 0.40), so left alone the I4 card
 * simply plays quieter than the I6 card — measured 3.6 dB down at cruise. An
 * engine being intrinsically thinner is correct; a card you have to reach for
 * the volume knob for is not. This puts them in the same window and leaves the
 * voicing difference intact.
 */
function deriveOutputTrim(spec) {
  const body = spec.body || 0.5;
  return round3(Math.min(1.5, Math.max(0.9, (0.86 / body) ** 0.45)));
}

/**
 * MOTION — how fast the sound is allowed to move. This is the anti-judder half
 * and it is mandatory for every CRANK profile.
 *
 * Why it must exist: CRANK is one oscillator, so rpm IS pitch. The virtual
 * gearbox snaps rpm at an upshift (6,426 -> 2,056 rpm in a single tick) and the
 * sim slams demand from 0 to full in one frame. Followed literally, both land as
 * clicks. Launch Rev never exposed this because its script ramps rpm smoothly.
 *
 *   glideSec / shiftGlideSec  how fast the oscillator tracks rpm; the shift
 *                             value is the ~0.1-0.2 s a real engine takes to
 *                             drop that far with the clutch out
 *   glideHoldSec              how long the slow glide stays engaged after a shift
 *   riseRpmPerSec             crank + flywheel angular acceleration. Scaled off
 *                             the engine's own redline and inertia: roughly
 *                             "seconds to sweep the tacho under load".
 *   fallRpmPerSec             overrun drops faster than it climbs
 */
/**
 * Played-pitch ceiling, ported from the classic engine.
 *
 * Classic maps idle..redline onto idle..rpmCeiling for everything that sets an
 * actual frequency, while the rev counter still shows the real number. It has
 * been 4800 there since drivers called the top end harsh on Tesla's speakers.
 * classic-muscle redlines at 4500, so the cap never touches it — which is part
 * of why muscle is the profile that sounds settled in this car.
 *
 * CRANK had no cap, so a 7,200 or 8,400 rpm profile played its whole range:
 * brighter than anything classic ever plays, and 1.6x more semitones of pitch
 * for the same rev error.
 */
const PITCH_CEILING_RPM = 4800;
/** Cylinders the 4800 figure was tuned on. classic-muscle is a V8. */
const PITCH_CEILING_CYL = 8;

/**
 * The ceiling is really a FIRING-frequency limit, not an rpm limit.
 *
 * What the ear gets is rpm/120 x cylinders. classic's 4800 was tuned on a V8,
 * where that works out at 320 Hz. Reusing the raw rpm number on an engine with
 * fewer cylinders quietly halves the frequency:
 *
 *   at 1500 rpm, played firing frequency
 *     V8  @4800 cap ->  100 Hz     a note
 *     I6  @4800 cap ->   61 Hz     a note
 *     I4  @4800 cap ->   40 Hz     separate thuds, which IS the judder
 *
 * Below roughly 50 Hz the ear stops hearing a pitch and starts counting
 * individual combustion events. So scale the cap to hold the frequency the cap
 * was actually chosen for. A V8 lands on 4800 exactly, as before.
 */
function derivePitchCeiling(spec) {
  return Math.round((PITCH_CEILING_RPM * PITCH_CEILING_CYL) / spec.cylinders);
}

/**
 * Same reasoning for where each gear CRUISES. A four-cylinder loafing at the
 * rpm a V8 loafs at is firing half as often, so its cruise has to sit higher to
 * stay a note. Keeps whatever the profile asks for if that is already enough.
 */
function deriveGearFloors(spec, drive) {
  const forHz = (hz) => Math.round((hz * 120) / spec.cylinders);
  return {
    floorLo: Math.max(drive.floorLo, forHz(60)),
    floorHi: Math.max(drive.floorHi, forHz(75)),
  };
}

function deriveMotion(spec, drive) {
  const inertia = spec.inertia ?? 0.7;
  const span = spec.redlineRpm - spec.idleRpm;

  // How far the revs actually fall at an upshift, in SEMITONES — because that,
  // not the engine's weight, is what the ear has to sit through. Sizing the
  // glide off the drop keeps the swoop RATE comparable between engines instead
  // of letting a wide-rev-range engine whip through the same arc in less time.
  const topRpm = spec.idleRpm + span * drive.revPull;
  const landRpm = spec.idleRpm + span * (drive.revLo + 0.03);
  const dropSt = 12 * Math.log2(topRpm / landRpm);

  const rise = Math.round(spec.redlineRpm / (0.35 + inertia * 0.7) / 100) * 100;
  return {
    glideSec: round3(0.022 + inertia * 0.012),
    shiftGlideSec: round3(Math.min(0.16, Math.max(0.07, dropSt / 220))),
    glideHoldSec: round3(Math.min(0.35, Math.max(0.15, (dropSt / 220) * 2.2))),
    riseRpmPerSec: rise,
    fallRpmPerSec: Math.round(rise * 1.25 / 100) * 100,
    // Pitch-rate ceiling for the whole CRANK type, in semitones/second. The
    // rpm/s caps above are engine character (a K20 does rev faster than a 1JZ);
    // this is the ear's limit, and it only bites low in the rev range right
    // after a shift, where rpm/s translates into the most pitch per second.
    // Measured: without it the K20 spent 63% more frames above 80 st/s than the
    // 1JZ and read as judder, while sounding identical by every level metric.
    maxRiseStPerSec: 58,
    maxFallStPerSec: 72,
  };
}

/**
 * CAM — variable valve timing crossover, for `induction: 'vtec'`.
 *
 * Real VTEC latches: the rocker engages as revs climb past the switch point and
 * does NOT release until well below it. Without that hysteresis the cam chases
 * every rev swing — measured 10 swaps in 4 seconds of sim driving, because each
 * gearshift drops the K20 from ~7,800 back to ~2,400 rpm straight through the
 * threshold, flipping the engine's whole voice out and in each time.
 *
 * onAt/offAt are on the smoothed 0..1 cam signal, so the gap is a real latch
 * rather than a second threshold the same noise can still straddle.
 */
// duckTo: how far the voice dips for the single tick the waveform is replaced.
// setPeriodicWave swaps the oscillator's entire harmonic content in one sample —
// free in CPU, but a step in the signal, and the classic engine never does
// anything like it (it crossfades layers with gains). Measured 9 swaps in a
// 6 second run through the gears, since every upshift drops the cam back out
// and the climb puts it straight back in.
const CAM = { onAt: 0.62, offAt: 0.34, dwellSec: 0.28, duckTo: 0.35 };

/**
 * BOOST — forced induction, derived from the engine's own published numbers.
 * Emitted for every spec with `induction: 'turbo'`; null otherwise.
 *
 * The shape is a real turbo's, not a ramp and not a step:
 *   threshold  below it the turbine has no exhaust energy at all
 *   swell      steep climb to the wastegate limit
 *   plateau    held flat — torque still peaks later, from volumetric
 *              efficiency, NOT from more boost
 *   taper      small turbos run out of compressor near the top
 *
 * Anchors come from the spec so a different engine lands somewhere different:
 *   onset  = 0.375 x peak-torque rpm      (early for small turbos)
 *   full   = 0.79  x peak-torque rpm      (wastegate takes over)
 *   taper  = the power peak, estimated as torque peak + 62% of the way to redline
 *   spool  = lag rises with rotating inertia
 *   offGain= how much voice survives off boost; bigger engines keep more of it
 *
 * A spec sets `boostBar` for its real factory pressure (default 0.7 bar).
 */
function deriveBoost(spec) {
  if (spec.induction !== 'turbo') return null;
  const peak = spec.peakTorqueRpm;
  const inertia = spec.inertia ?? 0.7;
  const onsetRpm = Math.round(peak * 0.375 / 50) * 50;
  const fullRpm = Math.round(peak * 0.79 / 50) * 50;
  const spoolSec = round3(0.26 + inertia * 0.15);
  return {
    onsetRpm,
    fullRpm,
    peakBar: spec.boostBar ?? 0.7,
    taperRpm: Math.round((peak + 0.62 * (spec.redlineRpm - peak)) / 100) * 100,
    taperTo: 0.88,
    crossRpm: Math.round((onsetRpm + fullRpm) / 2 / 50) * 50,
    spoolSec,
    spoolFastSec: round3(spoolSec * 0.5),
    bleedSec: 0.16,
    loadLo: 0.08,
    loadHi: 0.55,
    offGain: round3(Math.min(0.75, Math.max(0.5, 0.42 + spec.displacementL * 0.072))),
    intakeGain: 0.45,
  };
}

/**
 * The full default set for one engine, with the spec's own overrides on top.
 * Add an engine to SPECS and it inherits all of this automatically.
 */
function defaultsFor(spec) {
  return {
    drive: (() => {
      const window_ = { ...DRIVE_BASE, ...(spec.drive || {}) };   // rev window first
      return {
        ...window_,
        ...deriveMotion(spec, window_),
        rpmCeiling: derivePitchCeiling(spec),
        accelRef: ACCEL_REF_KMHPS,
        accelCurve: ACCEL_CURVE,
        ...deriveGearFloors(spec, window_),
        ...(spec.drive || {}),
      };
    })(),
    dynamics: { ...DYN_BASE, ...(spec.dynamics || {}) },
    boost: deriveBoost(spec) ? { ...deriveBoost(spec), ...(spec.boost || {}) } : null,
    cam: spec.induction === 'vtec' ? { ...CAM, ...(spec.cam || {}) } : null,
    masterScale: spec.masterScale ?? MASTER_SCALE,
    space: { ...SPACE, ...(spec.space || {}) },
    outputTrim: spec.outputTrim ?? deriveOutputTrim(spec),
  };
}

/* ------------------------------------------------------------- prototype -- */
const TABLE = 2048;      // samples across one 720 deg cycle
const HARMONICS = 384;   // partials kept in the compiled wave

const norm720 = (d) => ((d % 720) + 720) % 720;

/** Firing events for one 720 deg cycle: crank angle, bank, relative amplitude. */
function firingOrder(spec) {
  const events = [];
  if (spec.firing === 'uneven-v10') {
    let deg = 0;
    for (let i = 0; i < 10; i++) {
      events.push({ deg, bank: i % 2 === 0 ? 'L' : 'R', amp: 1 });
      deg += i % 2 === 0 ? 90 : 54;
    }
    return events;
  }
  const step = 720 / spec.cylinders;
  for (let i = 0; i < spec.cylinders; i++) {
    let bank = 'C';
    if (spec.layout === 'v' || spec.layout === 'boxer') bank = i % 2 === 0 ? 'L' : 'R';
    // I4 inner cylinders sit further from the collector — very slightly quieter
    const amp = spec.layout === 'inline' && spec.cylinders === 4 && (i === 1 || i === 2) ? 0.94 : 1;
    events.push({ deg: norm720(i * step), bank, amp });
  }
  return spec.layout === 'boxer'
    ? events.map((e) => (e.bank === 'R' ? { ...e, deg: norm720(e.deg + 6) } : e))
    : events;
}

/** One cylinder's pressure pulse: fast rise, exponential blow-down. */
function pulseEnv(deg, widthDeg, decayDeg) {
  if (deg < 0 || deg > widthDeg * 5) return 0;
  return Math.min(1, deg / Math.max(1.2, widthDeg * 0.12)) * Math.exp(-deg / decayDeg);
}

/** Lay every firing event onto the 720 deg table (+ a reflected echo per pulse). */
function pulseTable(events, widthDeg, decayDeg, vtec = 0) {
  const table = new Float32Array(TABLE);
  const w = widthDeg * (1 - vtec * 0.35);   // wilder cam = shorter, sharper pulse
  const d = decayDeg * (1 - vtec * 0.4);
  for (let i = 0; i < TABLE; i++) {
    const deg = (i / TABLE) * 720;
    let s = 0;
    for (const ev of events) {
      const rel = norm720(deg - ev.deg);
      s += ev.amp * pulseEnv(rel, w, d);
      const echo = norm720(rel - widthDeg * 1.6);
      s += ev.amp * 0.18 * pulseEnv(echo, w * 0.8, d * 1.2);
    }
    table[i] = s;
  }
  let peak = 1e-6;
  for (let i = 0; i < TABLE; i++) peak = Math.max(peak, Math.abs(table[i]));
  const g = 0.92 / peak;
  for (let i = 0; i < TABLE; i++) table[i] *= g;
  return table;
}

/**
 * DFT the crank table into PeriodicWave coefficients.
 * Harmonic index n is per 720 deg, so n = cylinders IS the firing order — that
 * partial and its octave get the resonant lift (`lift`, `lift2`).
 */
function waveCoeffs(table, tilt, cylinders) {
  const real = new Float32Array(HARMONICS + 1);
  const imag = new Float32Array(HARMONICS + 1);
  for (let n = 1; n <= HARMONICS; n++) {
    let re = 0, im = 0;
    for (let i = 0; i < TABLE; i++) {
      const ang = (2 * Math.PI * n * i) / TABLE;
      re += table[i] * Math.cos(ang);
      im -= table[i] * Math.sin(ang);
    }
    re /= TABLE;
    im /= TABLE;
    const dOrder = Math.abs(n - cylinders);
    const lift = 1 + 0.55 * Math.exp(-dOrder * dOrder * 0.08);              // firing order
    const lift2 = 1 + 0.28 * Math.exp(-((n - cylinders * 2) ** 2) * 0.04);  // its octave
    const tiltGain = (1 / n ** tilt) * lift * lift2;
    real[n] = re * tiltGain;
    imag[n] = im * tiltGain;
  }
  return { real, imag };
}

/** L / R / mono waves. V and boxer layouts split banks; inline shares one. */
function buildWaves(spec, vtec = 0) {
  const events = firingOrder(spec);
  const left = events.filter((e) => e.bank === 'L' || e.bank === 'C');
  const right = events.filter((e) => e.bank === 'R' || e.bank === 'C');
  const make = (ev) =>
    waveCoeffs(
      pulseTable(ev, spec.pulseWidthDeg, spec.pulseDecayDeg, vtec),
      spec.harmonicTilt * (1 - vtec * 0.25),
      spec.cylinders,
    );
  return { left: make(left), right: make(right), mono: make(events) };
}

/* ---------------------------------------------------------------- output -- */
/** 4 significant digits keeps every partial alive (they span 1 -> 1e-7) and
 *  still halves the file next to full float64 text. */
const q = (arr) => Array.from(arr, (v) => Number(v.toPrecision(4)));
const packWave = (w) => ({ real: q(w.real), imag: q(w.imag) });
const packSet = (s) => ({ left: packWave(s.left), right: packWave(s.right), mono: packWave(s.mono) });

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const spec of SPECS) {
  const t0 = Date.now();
  const doc = {
    format: 'crank/1',
    id: spec.id,
    code: spec.code,
    name: spec.name,
    car: spec.car,
    notes: spec.notes,
    builtAt: new Date().toISOString(),
    harmonics: HARMONICS,
    spec,
    mixer: { ...MIXER },
    ...defaultsFor(spec),
    waves: {
      base: packSet(buildWaves(spec, 0)),
      // Second cam profile — only VTEC engines cross over to it
      vtec: spec.induction === 'vtec' ? packSet(buildWaves(spec, 1)) : null,
    },
  };
  const out = path.join(OUT_DIR, `${spec.id}.crank.json`);
  fs.writeFileSync(out, JSON.stringify(doc));
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`  ${spec.code.padEnd(6)} -> assets/crank/${spec.id}.crank.json  ${kb} KB  (${Date.now() - t0} ms)`);
  // Show what the type defaults derived, so a new engine can be sanity-checked
  const d = doc.drive;
  console.log(`         motion  glide ${d.glideSec}s / shift ${d.shiftGlideSec}s  rise ${d.riseRpmPerSec} rpm/s (<= ${d.maxRiseStPerSec} st/s)  fall ${d.fallRpmPerSec}`);
  const ceil = Math.min(spec.redlineRpm, d.rpmCeiling);
  const firing = (rpm) => ((spec.idleRpm + ((rpm - spec.idleRpm) * (ceil - spec.idleRpm)) / (spec.redlineRpm - spec.idleRpm)) / 120) * spec.cylinders;
  console.log(`         pitch   plays ${spec.idleRpm}-${ceil} rpm (readout ${spec.idleRpm}-${spec.redlineRpm})  firing ${firing(1500).toFixed(0)} Hz @1500, ${firing(spec.redlineRpm).toFixed(0)} Hz @redline`);
  console.log(`         floors  gear cruise ${d.floorLo}-${d.floorHi} rpm`);
  console.log(`         space   rear below ${doc.space.crossoverHz} Hz at ${doc.space.rearGain}x, z ${doc.space.rearZ} m, wet ${doc.space.reverbWet}`);
  console.log(`         loud    dynDb ${doc.dynamics.dynDb}  accelRef ${d.accelRef} km/h/s  masterScale ${doc.masterScale}x  trim ${doc.outputTrim}x`);
  console.log(
    doc.boost
      ? `         boost   on ${doc.boost.onsetRpm} -> full ${doc.boost.fullRpm} @ ${doc.boost.peakBar} bar, taper from ${doc.boost.taperRpm} to ${doc.boost.taperTo}, offGain ${doc.boost.offGain}`
      : `         boost   none (${spec.induction})`,
  );
  if (doc.cam) console.log(`         cam     latch on ${doc.cam.onAt} / off ${doc.cam.offAt}, dwell ${doc.cam.dwellSec}s`);
}
console.log('CRANK compile done.');
