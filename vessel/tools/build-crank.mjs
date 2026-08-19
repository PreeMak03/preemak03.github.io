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
    drive: { revLo: 0.16, revHi: 0.52, revPull: 0.88, floorLo: 1250, floorHi: 1750 },
    dynamics: { overrunDuck: 0.72, idlePresence: 0.72 },
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
    drive: { revLo: 0.18, revHi: 0.58, revPull: 0.92, floorLo: 1400, floorHi: 1950 },
    dynamics: { dynDb: 8, shiftDuck: 0.38, idlePresence: 0.68 },
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
const DYN_BASE = { dynDb: 7, dynCeiling: 0.9, shiftDuck: 0.4, overrunDuck: 0.7, idlePresence: 0.7 };

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
function deriveMotion(spec) {
  const inertia = spec.inertia ?? 0.7;
  const shiftGlideSec = round3(0.055 + inertia * 0.038);
  const rise = Math.round(spec.redlineRpm / (0.35 + inertia * 0.7) / 100) * 100;
  return {
    glideSec: round3(0.022 + inertia * 0.012),
    shiftGlideSec,
    glideHoldSec: round3(shiftGlideSec * 2.2),
    riseRpmPerSec: rise,
    fallRpmPerSec: Math.round(rise * 1.25 / 100) * 100,
  };
}

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
    drive: { ...DRIVE_BASE, ...deriveMotion(spec), ...(spec.drive || {}) },
    dynamics: { ...DYN_BASE, ...(spec.dynamics || {}) },
    boost: deriveBoost(spec) ? { ...deriveBoost(spec), ...(spec.boost || {}) } : null,
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
  console.log(`         motion  glide ${d.glideSec}s / shift ${d.shiftGlideSec}s  rise ${d.riseRpmPerSec} rpm/s  fall ${d.fallRpmPerSec}`);
  console.log(
    doc.boost
      ? `         boost   on ${doc.boost.onsetRpm} -> full ${doc.boost.fullRpm} @ ${doc.boost.peakBar} bar, taper from ${doc.boost.taperRpm} to ${doc.boost.taperTo}, offGain ${doc.boost.offGain}`
      : `         boost   none (${spec.induction})`,
  );
}
console.log('CRANK compile done.');
