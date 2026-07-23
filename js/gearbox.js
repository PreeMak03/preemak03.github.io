/**
 * 5-speed virtual gearbox — per-profile rev character.
 *
 * Each gear is a clean RPM sweep: just after an upshift the revs LAND low
 * (revLo) then climb to the shift point (revHi) at the top of the gear, then
 * drop again on the next upshift. Five close ratios = frequent resets = a
 * "rowing through the gears" feel instead of one droning held note.
 *
 * Speed bands (steady cruise):
 *   G1  0–25 · G2 25–50 · G3 50–70 · G4 70–90 · G5 90+
 *
 * revLo / revHi / pull come from each profile's engine block, so a lazy
 * Stage-3 muscle car sits low and shifts early while a rotary screams.
 */

import { clamp } from './animations.js';

export const GEAR_VMAX = [25, 50, 70, 90, 200];
export const GEAR_COUNT = 5;

const UP_AT = [25, 50, 70, 90, 999];
/** DOWN_AT[i] = drop out of gear i+2 below this speed (G2→G1 @18 … G5→G4 @82) */
const DOWN_AT = [18, 42, 62, 82];

/** Fallback rev character when a profile doesn't specify one. */
const REV_DEFAULT = { lo: 0.18, hi: 0.7, pull: 0.96 };

export function resolveGear(speedKmh, currentGear = 1, accelLoad = 0, decelLoad = 0) {
  let g = clamp(Math.round(currentGear) || 1, 1, GEAR_COUNT);
  const v = Math.max(0, speedKmh);

  // Under load, hold each gear a little longer before upshifting
  const upBias = accelLoad * 8;
  const downBias = decelLoad * 8;

  while (g < GEAR_COUNT && v >= UP_AT[g - 1] + upBias) g += 1;
  while (g > 1 && v < DOWN_AT[g - 2] - downBias) g -= 1;

  // Kickdown: hard throttle drops gear(s) for rev drama, but only where the
  // lower gear still covers this speed (won't instantly upshift back).
  if (accelLoad > 0.5 && g > 1) {
    let drops = accelLoad > 0.85 ? 2 : 1;
    while (drops > 0 && g > 1 && v < UP_AT[g - 2] + upBias - 1.5) {
      g -= 1;
      drops -= 1;
    }
  }

  if (v < 2) g = 1;
  return g;
}

export function gearSpeedSpan(gear) {
  const g = clamp(gear, 1, GEAR_COUNT);
  const floor = g === 1 ? 0 : GEAR_VMAX[g - 2];
  const ceil = GEAR_VMAX[g - 1];
  return { floor, ceil, vmax: ceil };
}

export function gearProgress(speedKmh, gear) {
  const { floor, ceil } = gearSpeedSpan(gear);
  return clamp((speedKmh - floor) / Math.max(1, ceil - floor), 0, 1.15);
}

/**
 * Absolute RPM just after an upshift into `gear` — lands near revLo so there
 * is an audible drop (the whole point of "shifting" vs droning).
 */
export function shiftLandingRpm(gear, idle, redline, revLo = REV_DEFAULT.lo) {
  return idle + (redline - idle) * (revLo + 0.03);
}

/**
 * RPM target inside the current gear.
 * Normal drive sweeps revLo → revHi across the gear; throttle pushes the
 * whole thing up toward `pull` (the redline ceiling for this profile).
 */
export function rpmInGear({
  speedKmh,
  gear,
  idle,
  redline,
  accelLoad = 0,
  decelLoad = 0,
  revLo = REV_DEFAULT.lo,
  revHi = REV_DEFAULT.hi,
  pull = REV_DEFAULT.pull,
}) {
  const pos = gearProgress(speedKmh, gear); // 0 at gear floor → 1 at shift point
  const span = redline - idle;

  // Light-throttle sweep from just-upshifted (revLo) to ready-to-shift (revHi)
  const cruiseN = revLo + pos * (revHi - revLo);
  // Under throttle, climb faster and higher toward the pull ceiling
  const pullN = revLo + Math.pow(pos, 0.82) * (pull - revLo);
  let n = cruiseN + accelLoad * (pullN - cruiseN);

  // Lift-off eases revs (engine-braking feel)
  n -= decelLoad * 0.1;

  // Launch in first gear can dig deeper and rev harder
  if (gear === 1 && accelLoad > 0.3) {
    n = Math.max(n, revLo + accelLoad * (pull - revLo) * (0.35 + pos * 0.5));
  }

  n = clamp(n, revLo * 0.8, 1.02);
  return idle + span * n;
}

/**
 * Tone bias per gear: low gears raw/aggressive, tall gears more mid body.
 */
export function gearToneBias(gear) {
  const g = clamp(gear, 1, GEAR_COUNT);
  const t = (g - 1) / Math.max(1, GEAR_COUNT - 1);
  return {
    aggression: 1.2 - t * 0.25,
    body: 1.0 + t * 0.08,
    high: 0.75 + t * 0.15,
    character: 0.55 + t * 0.55,
    howlStart: 0.38 - t * 0.12,
    shiftDrop: 0.62,
  };
}
