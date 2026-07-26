/**
 * Shared Dynamic Volume — Classic AudioEngine + VesselAudio.
 *
 * Goals:
 *  - Wide dynamic range (idle/light audible, WOT opens up)
 *  - Soft ceiling so master/limiter/drive never brick-wall into “flat”
 *  - Per-gear loudness scale (low gears leave headroom; mid gears open)
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Sample piecewise-linear volume curve: [[rpm, mul], ...]
 * Same model as Vessel deploy.dynamics.curve (easy to graph / drag).
 * @returns {number} multiplier (typically ~0.4–1.1)
 */
export function sampleVolumeCurve(rpm, points) {
  const c = points;
  if (!Array.isArray(c) || c.length < 1) return 1;
  if (c.length === 1) return +c[0][1] || 1;
  if (rpm <= c[0][0]) return +c[0][1];
  if (rpm >= c[c.length - 1][0]) return +c[c.length - 1][1];
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i];
    const b = c[i + 1];
    if (rpm >= a[0] && rpm <= b[0]) {
      const t = (rpm - a[0]) / ((b[0] - a[0]) || 1);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return +c[c.length - 1][1];
}

/** Sensible Classic Muscle-style default (idle audible → mid open → soft top) */
export const DEFAULT_CLASSIC_DYN_CURVE = [
  [600, 0.58],
  [1200, 0.7],
  [2500, 0.88],
  [4000, 0.98],
  [5800, 0.9],
];

/**
 * Soft-knee approach toward a gain ceiling (linear gain domain).
 * Below (ceiling - knee) → linear; near ceiling → asymptotic approach.
 */
export function softCeilGain(x, ceiling = 0.88, knee = 0.18) {
  const c = Math.max(0.2, ceiling);
  const k = Math.max(0.05, Math.min(knee, c * 0.5));
  const start = c - k;
  if (x <= start) return Math.max(0, x);
  const t = clamp((x - start) / k, 0, 1);
  // smooth ease into ceiling (never quite bricks)
  const eased = 1 - Math.pow(1 - t, 2.2);
  return start + k * eased * 0.97; // 97% of knee → slight air under hard limit
}

/**
 * Per-gear loudness multipliers.
 * G1–G2 slightly quieter under dyn (headroom on hard launch)
 * G3 peak presence · G4–G5 ease off for cruise
 */
export function gearDynVolume(gear, gearCount = 5) {
  const n = Math.max(1, gearCount | 0);
  const g = clamp(Math.round(gear) || 1, 1, n);
  // default 5-speed curve
  const five = [0.86, 0.91, 1.0, 0.97, 0.93];
  if (n === 5) return { volScale: five[g - 1], gear: g };
  // interpolate for other counts
  const t = (g - 1) / Math.max(1, n - 1);
  // U-shape inverted: mid gears loudest
  const volScale = 0.86 + 0.14 * Math.sin(Math.PI * t) + t * 0.02;
  return { volScale: clamp(volScale, 0.8, 1.05), gear: g };
}

/**
 * Core dynamic volume (linear gain into dynGain node).
 *
 * @param {object} p
 * @param {number} p.effort        0..1 smoothed drive effort
 * @param {number} p.rpmNorm       0..1+ rpm in idle–redline
 * @param {number} [p.accelLoad]
 * @param {number} [p.decelLoad]
 * @param {number} [p.speed]       km/h
 * @param {number} [p.idlePresence]
 * @param {number} [p.gear]
 * @param {number} [p.gearCount]
 * @param {boolean} [p.shifting]
 * @param {boolean} [p.overrun]
 * @param {number} [p.dynDb]       full swing in dB (default 20)
 * @param {number} [p.curveMul]    RPM volume curve sample (default 1)
 * @param {number} [p.loadBoost]
 * @param {number} [p.load]        0..1 instantaneous load
 * @param {number} [p.softCeiling] max dyn gain (default 0.88)
 * @param {number} [p.floorBias]   raise light-driving floor (default 1)
 */
export function computeDynamicVolume(p) {
  const effort = clamp(p.effort ?? 0, 0, 1);
  const rpmNorm = clamp(p.rpmNorm ?? 0, 0, 1.15);
  const accelLoad = clamp(p.accelLoad ?? 0, 0, 1);
  const decelLoad = clamp(p.decelLoad ?? 0, 0, 1);
  const speed = Math.max(0, p.speed ?? 0);
  const idlePresence = clamp(p.idlePresence ?? 0.75, 0, 1.2);
  const dynDb = p.dynDb != null ? p.dynDb : 20;
  const softCeiling = p.softCeiling != null ? p.softCeiling : 0.88;
  const floorBias = p.floorBias != null ? p.floorBias : 1;

  // Drive energy: slightly compressed at high rpmNorm so redline doesn't slam ceiling
  const rpmTerm = Math.pow(Math.min(1, rpmNorm), 0.82) * 0.26;
  const driveEnergy = clamp(
    0.15 + effort * 0.5 + rpmTerm + accelLoad * 0.1 - decelLoad * 0.14,
    0,
    1
  );

  // Log loudness model: energy 0 → -dynDb dB, energy 1 → 0 dB
  let dynVol = Math.pow(10, (-dynDb * (1 - driveEnergy)) / 20);

  // Optional RPM curve + load boost (Vessel deploy.dynamics)
  const curveMul = p.curveMul != null ? p.curveMul : 1;
  const load = p.load != null ? p.load : 0.3;
  const loadBoost = p.loadBoost != null ? p.loadBoost : 0;
  dynVol *= curveMul * (1 + loadBoost * (load - 0.3));

  // Soft ceiling — primary anti-flat
  dynVol = softCeilGain(dynVol, softCeiling, 0.2);

  // Light-driving / idle floor — stay audible without filling the whole range
  const idleFloor = (0.09 + idlePresence * 0.11) * floorBias; // ~0.09–0.22
  const cruiseFloor = (0.07 + (1 - effort) * 0.05 + (1 - Math.min(1, rpmNorm)) * 0.03) * floorBias;
  dynVol = Math.max(dynVol, Math.min(cruiseFloor, softCeiling * 0.45));

  if (speed < 5) {
    const stopPresence =
      (1 - speed / 5) * (0.14 + idlePresence * 0.12) + idleFloor * 0.55;
    dynVol = Math.max(dynVol, stopPresence);
  }

  // Per-gear scale
  const gDyn = gearDynVolume(p.gear ?? 1, p.gearCount ?? 5);
  dynVol *= gDyn.volScale;

  if (p.shifting) dynVol *= 0.55;
  if (p.overrun) dynVol *= 0.72;

  // Absolute rails
  const lo = 0.055 * floorBias;
  const hi = softCeiling;
  return {
    dynVol: clamp(dynVol, lo, hi),
    driveEnergy,
    gearScale: gDyn.volScale,
    softCeiling: hi,
  };
}

export default {
  computeDynamicVolume,
  softCeilGain,
  gearDynVolume,
  sampleVolumeCurve,
  DEFAULT_CLASSIC_DYN_CURVE,
};
