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

export const GEAR_VMAX = [26, 52, 73, 94, 200];
export const GEAR_COUNT = 5;

// Wide hysteresis (~10–14 km/h gap) so Tesla GPS ±2–4 km/h never thrash gears.
// Thrashing gear = RPM jumps = the main "กระตุก" left after dyn soft-fix.
const UP_AT = [26, 52, 73, 94, 999];
/** DOWN_AT[i] = leave gear i+2 below this speed */
const DOWN_AT = [12, 34, 54, 74];

/** Fallback rev character when a profile doesn't specify one. */
const REV_DEFAULT = { lo: 0.18, hi: 0.7, pull: 0.96 };

export function resolveGear(speedKmh, currentGear = 1, accelLoad = 0, decelLoad = 0) {
  let g = clamp(Math.round(currentGear) || 1, 1, GEAR_COUNT);
  const v = Math.max(0, speedKmh);

  // Slight bias under load — still keep large gap between up/down thresholds
  const upBias = accelLoad * 5;
  const downBias = decelLoad * 5;

  // One step at a time (caller also clamps) — only cross clear thresholds
  if (g < GEAR_COUNT && v >= UP_AT[g - 1] + upBias) g += 1;
  else if (g > 1 && v < DOWN_AT[g - 2] - downBias) g -= 1;

  // Kickdown: rare, single step only — GPS noise must never multi-drop
  if (accelLoad > 0.88 && g > 1 && v < UP_AT[g - 2] + upBias - 4) {
    g -= 1;
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
  revCruise,
}) {
  const pos = gearProgress(speedKmh, gear); // 0 at gear floor → 1 at shift point
  const span = redline - idle;

  // OFF-throttle the engine coasts LOW (quiet cruise) — not up at the shift
  // point. This is why a real car goes near-silent holding speed after a pull.
  const cruiseTop = revCruise != null ? revCruise : revLo + (revHi - revLo) * 0.38;
  const cruiseN = revLo + pos * (cruiseTop - revLo);
  // Under throttle, climb faster and higher toward the pull ceiling
  const pullN = revLo + Math.pow(pos, 0.82) * (pull - revLo);
  let n = cruiseN + accelLoad * (pullN - cruiseN);

  // Lift-off eases revs (engine-braking feel)
  n -= decelLoad * 0.08;

  // Anti-stuck: under throttle the engine must ALWAYS rev — even caught low in a
  // tall gear (pos≈0), where the pull term above vanishes (pos^0.82→0). Without this
  // floor, flooring it near a gear's floor (e.g. 15 km/h in G2 after a downshift)
  // pins revs low until speed climbs into the band → "เหยียบแล้วรอบไม่ขึ้น".
  if (accelLoad > 0.2) {
    const gearEase = gear === 1 ? 1 : 0.72; // tall gears a touch calmer, still alive
    n = Math.max(n, revLo + accelLoad * (pull - revLo) * (0.34 + pos * 0.5) * gearEase);
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
    /** Loudness scale for Dynamic Volume (G1 headroom … G3 open … G5 ease) */
    dynVol: [0.86, 0.91, 1.0, 0.97, 0.93][g - 1] ?? 1,
  };
}
