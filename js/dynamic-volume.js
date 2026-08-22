/**
 * Dynamic Volume math — pure functions.
 *
 * BINDING (docs/CLASSIC-CONTRACT.md · AGENTS.md):
 * All behaviour parameters come from the *resolved* profile (dynamics + tone).
 * This module does NOT rewrite profile intent / sanitize author curves.
 * Missing values must be filled by resolveClassicProfile() before play.
 * Do not re-introduce clamp-over-author here to "fix the car".
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Sample piecewise-linear volume curve: [[rpm, mul], ...]
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

/** Fallback curve if resolve somehow omitted dynamics.curve */
export const DEFAULT_CLASSIC_DYN_CURVE = [
  [600, 0.62],
  [1200, 0.74],
  [2500, 0.9],
  [4000, 1.0],
  [5800, 0.9],
];

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
 * Per-gear scale from profile.dynamics.gearScale (or default five-speed).
 */
export function gearDynVolume(gear, gearCount = 5, gearScale) {
  const n = Math.max(1, gearCount | 0);
  const g = clamp(Math.round(gear) || 1, 1, n);
  const scales =
    Array.isArray(gearScale) && gearScale.length
      ? gearScale
      : [0.94, 0.97, 1.0, 0.98, 0.96];
  if (scales.length === n) {
    return { volScale: +scales[g - 1] || 1, gear: g };
  }
  const t = (g - 1) / Math.max(1, n - 1);
  const i = t * (scales.length - 1);
  const i0 = Math.floor(i);
  const i1 = Math.min(scales.length - 1, i0 + 1);
  const u = i - i0;
  const volScale = (+scales[i0] || 1) * (1 - u) + (+scales[i1] || 1) * u;
  return { volScale, gear: g };
}

/**
 * Core dynamic volume — pure. Callers pass resolved profile fields.
 *
 * @param {object} p
 * @param {number} p.effort
 * @param {number} p.rpmNorm
 * @param {number} [p.accelLoad]
 * @param {number} [p.decelLoad]
 * @param {number} [p.speed]
 * @param {number} p.idlePresence   from tone (resolved)
 * @param {number} [p.gear]
 * @param {number} [p.gearCount]
 * @param {number[]} [p.gearScale]  from dynamics
 * @param {boolean} [p.shifting]
 * @param {boolean} [p.overrun]
 * @param {number} p.dynDb
 * @param {number} p.curveMul       already sampled from dynamics.curve
 * @param {number} [p.loadBoost]
 * @param {number} [p.load]
 * @param {number} p.softCeiling    dynamics.dynCeiling
 * @param {number} [p.floorBias]
 * @param {number} [p.shiftDuck]    dynamics.shiftDuck
 * @param {number} [p.overrunDuck]  dynamics.overrunDuck
 */
export function computeDynamicVolume(p) {
  const effort = clamp(p.effort ?? 0, 0, 1);
  const rpmNorm = clamp(p.rpmNorm ?? 0, 0, 1.15);
  const accelLoad = clamp(p.accelLoad ?? 0, 0, 1);
  const decelLoad = clamp(p.decelLoad ?? 0, 0, 1);
  const speed = Math.max(0, p.speed ?? 0);
  const idlePresence = clamp(p.idlePresence ?? 0.75, 0, 1.2);
  const dynDb = p.dynDb != null ? +p.dynDb : 14;
  const softCeiling = p.softCeiling != null ? +p.softCeiling : 0.88;
  const floorBias = p.floorBias != null ? +p.floorBias : 1;
  const shiftDuck = p.shiftDuck != null ? +p.shiftDuck : 0.9;
  const overrunDuck = p.overrunDuck != null ? +p.overrunDuck : 0.9;
  const curveMul = p.curveMul != null ? +p.curveMul : 1;
  const load = p.load != null ? +p.load : 0.3;
  const loadBoost = p.loadBoost != null ? +p.loadBoost : 0;

  const rpmTerm = Math.pow(Math.min(1, rpmNorm), 0.85) * 0.28;
  const driveEnergy = clamp(
    0.22 + effort * 0.42 + rpmTerm + accelLoad * 0.08 - decelLoad * 0.1,
    0,
    1
  );

  let dynVol = Math.pow(10, (-dynDb * (1 - driveEnergy)) / 20);
  const loadTerm = 1 + loadBoost * (load - 0.3);
  dynVol *= curveMul * loadTerm;

  dynVol = softCeilGain(dynVol, softCeiling, 0.22);

  // Presence floors from profile idlePresence / floorBias (not secret clamps)
  const idleFloor = (0.12 + idlePresence * 0.12) * floorBias;
  const cruiseFloor =
    (0.1 + (1 - effort) * 0.05 + (1 - Math.min(1, rpmNorm)) * 0.03) * floorBias;
  dynVol = Math.max(dynVol, Math.min(cruiseFloor, softCeiling * 0.55));

  if (speed < 5) {
    const stopPresence =
      (1 - speed / 5) * (0.14 + idlePresence * 0.12) + idleFloor * 0.6;
    dynVol = Math.max(dynVol, stopPresence);
  }

  const gDyn = gearDynVolume(p.gear ?? 1, p.gearCount ?? 5, p.gearScale);
  dynVol *= gDyn.volScale;

  if (p.shifting) dynVol *= shiftDuck;
  if (p.overrun) dynVol *= overrunDuck;

  const lo = 0.05 * floorBias;
  const hi = Math.max(lo, softCeiling);
  return {
    dynVol: clamp(dynVol, lo, hi),
    driveEnergy,
    gearScale: gDyn.volScale,
    softCeiling: hi,
    curveMul,
  };
}

/**
 * DYNAMIC VOLUME FOR A HELD GEAR — a separate model on purpose.
 *
 * The automatic's model leans on rpm, and for the automatic that is sound: revs
 * only get high there BECAUSE the driver asked for something, so high revs and
 * hard work are the same fact. Manual breaks that link. rpm follows road speed
 * through the ratio, so first gear cruising at 24 km/h sits at 4320 rpm with the
 * throttle shut — a state the automatic cannot produce at all, and one the old
 * model reads as "working hard" and holds at full voice. Deafening, and wrong.
 *
 * FIRST PRINCIPLE, and it is the whole design: this app receives ONE thing —
 * speed over time. Everything else is derived from it. There is no throttle
 * sensor; `throttle` is literally clamp(rate / maxDelta, 0.15, 1) in
 * vehicle-physics.js, which is acceleration wearing another name. So a model
 * here may only ever key on ACCELERATION, whatever the variable is called.
 *
 * Which turns out to make the problem simple rather than hard. At 24 km/h there
 * are exactly two states a car can be in, and acceleration alone separates
 * them: it climbed here (accelerating, so loud) or it settled here (not
 * accelerating, so quiet). Nothing else can produce 24 km/h. There is no third
 * case to handle and no hidden state to infer.
 *
 * That is also what the engine does, which is why keying on it is not a
 * compromise: pulling means combustion and combustion is what you hear, while
 * holding a speed means barely any of it however fast the crank is turning.
 * Same revs, different sound.
 *
 * Merged into computeDynamicVolume this would have meant a branch inside every
 * term, and the automatic's numbers are ones the owner tuned on a road. Left
 * alone is safer than shared.
 */
export function computeManualVolume(p) {
  const effort = clamp(p.effort ?? 0, 0, 1);
  const rpmNorm = clamp(p.rpmNorm ?? 0, 0, 1.15);
  const decelLoad = clamp(p.decelLoad ?? 0, 0, 1);
  const speed = Math.max(0, p.speed ?? 0);
  const idlePresence = clamp(p.idlePresence ?? 0.75, 0, 1.2);
  const dynDb = p.dynDb != null ? +p.dynDb : 14;
  const softCeiling = p.softCeiling != null ? +p.softCeiling : 0.88;
  const floorBias = p.floorBias != null ? +p.floorBias : 1;
  const shiftDuck = p.shiftDuck != null ? +p.shiftDuck : 0.9;
  const overrunDuck = p.overrunDuck != null ? +p.overrunDuck : 0.9;

  // Acceleration decides. `effort` is the smoothed accel signal — not a pedal,
  // there is no pedal — so ceasing to accelerate drops the voice however fast
  // the engine happens to be turning. That is the entire point of this function.
  const loadEnergy = clamp(0.16 + effort * 0.72 - decelLoad * 0.14, 0, 1);
  // Revs colour it: at the same acceleration, turning faster is somewhat
  // louder. Colour only — never the lead, or first gear at a steady 24 km/h
  // reads as effort again and we are back where we started.
  const revColour = 0.85 + Math.min(1, rpmNorm) * 0.28;
  const driveEnergy = clamp(loadEnergy * revColour, 0, 1);

  let dynVol = Math.pow(10, (-dynDb * (1 - driveEnergy)) / 20);
  dynVol = softCeilGain(dynVol, softCeiling, 0.22);

  // A held gear still has to be audible off the throttle — engine braking is a
  // sound, not silence — so the floor rises a little with the revs.
  const cruiseFloor = (0.09 + Math.min(1, rpmNorm) * 0.05) * floorBias;
  dynVol = Math.max(dynVol, Math.min(cruiseFloor, softCeiling * 0.55));

  if (speed < 5) {
    const idleFloor = (0.12 + idlePresence * 0.12) * floorBias;
    dynVol = Math.max(dynVol, (1 - speed / 5) * (0.14 + idlePresence * 0.12) + idleFloor * 0.6);
  }

  const gDyn = gearDynVolume(p.gear ?? 1, p.gearCount ?? 5, p.gearScale);
  dynVol *= gDyn.volScale;
  if (p.shifting) dynVol *= shiftDuck;
  if (p.overrun) dynVol *= overrunDuck;

  const lo = 0.05 * floorBias;
  const hi = Math.max(lo, softCeiling);
  return { dynVol: clamp(dynVol, lo, hi), driveEnergy, gearScale: gDyn.volScale, softCeiling: hi, curveMul: 1 };
}

export default {
  computeDynamicVolume,
  computeManualVolume,
  softCeilGain,
  gearDynVolume,
  sampleVolumeCurve,
  DEFAULT_CLASSIC_DYN_CURVE,
};
