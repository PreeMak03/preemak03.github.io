/**
 * Shared Dynamic Volume — Classic AudioEngine + VesselAudio.
 *
 * Goals:
 *  - Wide but SMOOTH dynamic range (no pump / stutter on GPS noise)
 *  - Soft ceiling so master/limiter never brick-walls
 *  - Per-gear scale without hard steps
 *  - Clamp extreme CommandRoom curves so car audio stays driveable
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Sample piecewise-linear volume curve: [[rpm, mul], ...]
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

/** Safe car-default curve (idle present → mid open → soft top) */
export const DEFAULT_CLASSIC_DYN_CURVE = [
  [600, 0.62],
  [1200, 0.74],
  [2500, 0.9],
  [4000, 1.0],
  [5800, 0.9],
];

/**
 * Keep CommandRoom curves from collapsing to silence (stutter / pump on GPS).
 * Extreme low points amplify every accel blip into a volume jump.
 */
export function sanitizeCurveMul(mul) {
  return clamp(mul == null ? 1 : +mul, 0.42, 1.15);
}

/**
 * Soft-knee approach toward a gain ceiling (linear gain domain).
 */
export function softCeilGain(x, ceiling = 0.88, knee = 0.18) {
  const c = Math.max(0.2, ceiling);
  const k = Math.max(0.05, Math.min(knee, c * 0.5));
  const start = c - k;
  if (x <= start) return Math.max(0, x);
  const t = clamp((x - start) / k, 0, 1);
  const eased = 1 - Math.pow(1 - t, 2.2);
  return start + k * eased * 0.97;
}

/**
 * Per-gear loudness — gentle steps (was more stepped → audible "thumps").
 */
export function gearDynVolume(gear, gearCount = 5) {
  const n = Math.max(1, gearCount | 0);
  const g = clamp(Math.round(gear) || 1, 1, n);
  const five = [0.94, 0.97, 1.0, 0.98, 0.96];
  if (n === 5) return { volScale: five[g - 1], gear: g };
  const t = (g - 1) / Math.max(1, n - 1);
  const volScale = 0.94 + 0.06 * Math.sin(Math.PI * t);
  return { volScale: clamp(volScale, 0.9, 1.02), gear: g };
}

/**
 * Core dynamic volume (linear gain into dynGain node).
 */
export function computeDynamicVolume(p) {
  const effort = clamp(p.effort ?? 0, 0, 1);
  const rpmNorm = clamp(p.rpmNorm ?? 0, 0, 1.15);
  const accelLoad = clamp(p.accelLoad ?? 0, 0, 1);
  const decelLoad = clamp(p.decelLoad ?? 0, 0, 1);
  const speed = Math.max(0, p.speed ?? 0);
  // Never treat missing idlePresence as "silent bed"
  const idlePresence = clamp(
    p.idlePresence == null || p.idlePresence < 0.15 ? 0.75 : p.idlePresence,
    0.15,
    1.2
  );
  // Milder default swing — 14 dB is enough drama without GPS pump
  const dynDb = clamp(p.dynDb != null ? p.dynDb : 14, 8, 22);
  const softCeiling = p.softCeiling != null ? p.softCeiling : 0.88;
  const floorBias = p.floorBias != null ? p.floorBias : 1;

  // Compress drive energy so tiny GPS accel blips don't slam volume
  const rpmTerm = Math.pow(Math.min(1, rpmNorm), 0.85) * 0.28;
  const driveEnergy = clamp(
    0.22 + effort * 0.42 + rpmTerm + accelLoad * 0.08 - decelLoad * 0.1,
    0,
    1
  );

  let dynVol = Math.pow(10, (-dynDb * (1 - driveEnergy)) / 20);

  const curveMul = sanitizeCurveMul(p.curveMul);
  const load = p.load != null ? p.load : 0.3;
  const loadBoost = clamp(p.loadBoost != null ? p.loadBoost : 0.22, 0, 0.55);
  // Soft load term (was linear and noisy on GPS)
  const loadTerm = 1 + loadBoost * (load - 0.3) * 0.85;
  dynVol *= curveMul * clamp(loadTerm, 0.75, 1.35);

  dynVol = softCeilGain(dynVol, softCeiling, 0.22);

  // Higher floors so cruise never dives into silence then pops up
  const idleFloor = (0.14 + idlePresence * 0.12) * floorBias;
  const cruiseFloor =
    (0.12 + (1 - effort) * 0.06 + (1 - Math.min(1, rpmNorm)) * 0.04) * floorBias;
  dynVol = Math.max(dynVol, Math.min(cruiseFloor, softCeiling * 0.55));

  if (speed < 5) {
    const stopPresence =
      (1 - speed / 5) * (0.16 + idlePresence * 0.14) + idleFloor * 0.65;
    dynVol = Math.max(dynVol, stopPresence);
  }

  const gDyn = gearDynVolume(p.gear ?? 1, p.gearCount ?? 5);
  dynVol *= gDyn.volScale;

  // Soft shift / overrun — hard 0.55 mute was a main "stutter" on real roads
  if (p.shifting) dynVol *= 0.9;
  if (p.overrun) dynVol *= 0.9;

  const lo = 0.1 * floorBias;
  const hi = softCeiling;
  return {
    dynVol: clamp(dynVol, lo, hi),
    driveEnergy,
    gearScale: gDyn.volScale,
    softCeiling: hi,
    curveMul,
  };
}

export default {
  computeDynamicVolume,
  softCeilGain,
  gearDynVolume,
  sampleVolumeCurve,
  sanitizeCurveMul,
  DEFAULT_CLASSIC_DYN_CURVE,
};
