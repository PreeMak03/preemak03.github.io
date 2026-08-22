/**
 * 5-speed virtual gearbox — per-profile rev character.
 *
 * Each gear is a clean RPM sweep: just after an upshift the revs LAND low
 * (revLo) then climb to the shift point (revHi) at the top of the gear, then
 * drop again on the next upshift. Five close ratios = frequent resets = a
 * "rowing through the gears" feel instead of one droning held note.
 *
 * Speed bands (steady cruise), after the Ioniq 5 N:
 *   G1  1–40 · G2 41–70 · G3 71–90 · G4 91–110 · G5 111+
 *
 * revLo / revHi / pull come from each profile's engine block, so a lazy
 * Stage-3 muscle car sits low and shifts early while a rotary screams.
 */

import { clamp } from './animations.js';

/**
 * Speed bands: the Hyundai Ioniq 5 N's simulated gearbox, which is the closest
 * production reference to what this app is doing.
 *
 *   G1 1–40 · G2 41–70 · G3 71–90 · G4 91–110 · G5 111+
 *
 * Shared by every engine — classic, VESSEL and CRANK. Replaces the earlier
 * 26/51/71/91 set (kept below as LEGACY_BANDS for reference and rollback).
 */
export const GEAR_VMAX = [40, 70, 90, 110, 240];
export const GEAR_COUNT = 5;

// Wide hysteresis (~17 km/h gap) so Tesla GPS ±2–4 km/h never thrash gears.
// Thrashing gear = RPM jumps = the main "กระตุก" left after dyn soft-fix.
// UP_AT[g-1] = leave gear g upward at this speed.
const UP_AT = [41, 71, 91, 111, 999];
/** DOWN_AT[i] = leave gear i+2 below this speed */
const DOWN_AT = [24, 54, 74, 94];

/**
 * @typedef {{vmax:number[], up:number[], down:number[]}} GearBands
 *
 * Bands are threaded through as an optional argument so a profile can differ
 * without touching anyone else. Everything currently takes the default.
 */
export const DEFAULT_BANDS = { vmax: GEAR_VMAX, up: UP_AT, down: DOWN_AT };

/** The set used up to 2026-08-20, if the Ioniq spacing ever needs backing out. */
export const LEGACY_BANDS = {
  vmax: [26, 51, 71, 91, 200], up: [26, 51, 71, 91, 999], down: [12, 34, 54, 74],
};

/** Fallback rev character when a profile doesn't specify one. */
const REV_DEFAULT = { lo: 0.18, hi: 0.7, pull: 0.96 };

/* ------------------------------------------------------------- manual -- */
/**
 * MANUAL GEARBOX.
 *
 * resolveGear() is a STRATEGY for choosing a gear, not the gearbox itself, so
 * a manual mode does not modify it — it replaces the choice ahead of it and
 * leaves the automatic path byte-for-byte alone. Everything downstream (tone
 * bias, shift landing, dynamic volume per gear) already takes a gear number
 * and does not care who picked it.
 */
let _manualGear = null;          // null = automatic
let _manualEvent = null;         // 'up' | 'down' | null, consumed by the engine

export function isManual() { return _manualGear != null; }
export function manualGear() { return _manualGear; }

/** Engage manual, starting from whatever gear the automatic was in. */
export function engageManual(fromGear = 1) {
  _manualGear = clamp(Math.round(fromGear) || 1, 1, GEAR_COUNT);
  return _manualGear;
}

export function releaseManual() { _manualGear = null; _manualEvent = null; }

/** One gear up or down. Returns the new gear, or null when not engaged. */
export function shiftManual(dir) {
  if (_manualGear == null) return null;
  const next = clamp(_manualGear + (dir > 0 ? 1 : -1), 1, GEAR_COUNT);
  if (next !== _manualGear) _manualEvent = dir > 0 ? 'up' : 'down';
  _manualGear = next;
  return _manualGear;
}

/** Read and clear the pending shift, so the engine fires its sound once. */
export function takeManualEvent() {
  const e = _manualEvent; _manualEvent = null; return e;
}

/**
 * RPM from SPEED and the chosen gear — the real relationship.
 *
 * The automatic model deliberately ties revs to ACCELERATION, which is right
 * when the box picks its own gear: at a steady speed a real automatic has
 * already shifted up and settled. The moment a human holds a gear that stops
 * being true. Holding second at 90 has to scream, and fifth at 20 has to lug,
 * or choosing a gear means nothing.
 *
 * So progress through the gear's speed band is NOT clamped here the way
 * gearProgress() clamps it — running past the top of the band is the point.
 */
/** Road speed by which the clutch is fully home. Pulling away is a walking-pace
 *  event, so this is absolute and deliberately not a share of the gear. */
const SLIP_KMH = 12;

export function rpmInGearManual({
  gear, speedKmh, idle, redline,
  accelLoad = 0, decelLoad = 0,
  bands = DEFAULT_BANDS,
}) {
  const g = clamp(Math.round(gear) || 1, 1, GEAR_COUNT);
  // A gear is a RATIO, so rpm is proportional to speed: at the top of the
  // gear the engine is at the redline, and everything else follows a straight
  // line from there.
  //
  // The first version used the automatic's SHIFT BANDS as if they were ratios
  // and that is not the same thing at all — third does not begin until 71 km/h
  // on the automatic's schedule, so holding third at 60 came out at 700 rpm,
  // lugging, when a real manual sits at mid revs there. Measured before the
  // fix: 2nd at 90 hit the limiter correctly and 5th at 20 lugged correctly,
  // but 3rd at 60 read 10% of redline. Two right answers hid a broken model.
  // BLIP. Standing still, the ratio says idle no matter how hard you press —
  // correct for a car in gear, and wrong for the thing every enthusiast does
  // first, which is rev it on the spot. That happens with the clutch OUT, so
  // the ratio is not in the loop at all: the engine is just spinning its own
  // flywheel against the throttle.
  //
  // Below walking pace the throttle owns the revs directly. Above it the gear
  // does, because then the clutch really is in and speed really does dictate
  // rpm.
  const vmax = Math.max(1, bands.vmax[g - 1]);
  const rolling = Math.max(0, speedKmh);

  // THE CLUTCH SLIPS, it does not switch.
  //
  // This used to hand over at a hard 3 km/h: below it the throttle owned the
  // revs, above it the ratio did, and nothing joined the two. On the 1JZ in
  // first that is a target of 6336 rpm at 2.9 km/h and 927 at 3.0 — a factor of
  // 6.8, or 33 semitones, across one reading. The rate limiter then spent about
  // a second and a half dragging the revs back down while the car crawled away,
  // which is the free revving left in a standing start: the engine screaming
  // and then sagging, attached to nothing the car was doing.
  //
  // A real clutch is out at rest and progressively locks as the car gains
  // speed, so blend instead: all throttle at a standstill, all ratio by
  // SLIP_KMH, and the engine falls into step with the road on the way through.
  const blipTop = idle + (redline * 0.88 - idle) * clamp(accelLoad, 0, 1);
  let rpm = redline * (rolling / vmax);
  rpm += (redline - idle) * (accelLoad * 0.06 - decelLoad * 0.05);

  // Absolute speed, NOT a share of the gear. Pulling away happens at walking
  // pace whatever gear is selected, and scaling this by vmax would leave fifth
  // at 20 km/h half-slipped and revving instead of lugging — and lugging in a
  // tall gear is the whole point of being allowed to hold one.
  const slip = clamp((SLIP_KMH - rolling) / SLIP_KMH, 0, 1);
  if (slip > 0) rpm = rpm * (1 - slip) + blipTop * slip;
  // Below idle the clutch is slipping or the driver is about to stall it;
  // above the redline the limiter has it. Both ends are the point of manual.
  return clamp(rpm, idle * 0.92, redline * 1.04);
}

export function resolveGear(speedKmh, currentGear = 1, accelLoad = 0, decelLoad = 0, bands = DEFAULT_BANDS) {
  if (_manualGear != null) return _manualGear;
  const UP = bands.up, DOWN = bands.down;
  let g = clamp(Math.round(currentGear) || 1, 1, GEAR_COUNT);
  const v = Math.max(0, speedKmh);

  // Slight bias under load — still keep large gap between up/down thresholds
  const upBias = accelLoad * 5;
  const downBias = decelLoad * 5;

  // One step at a time (caller also clamps) — only cross clear thresholds
  if (g < GEAR_COUNT && v >= UP[g - 1] + upBias) g += 1;
  else if (g > 1 && v < DOWN[g - 2] - downBias) g -= 1;

  // Kickdown: rare, single step only — GPS noise must never multi-drop
  if (accelLoad > 0.88 && g > 1 && v < UP[g - 2] + upBias - 4) {
    g -= 1;
  }

  if (v < 2) g = 1;
  return g;
}

export function gearSpeedSpan(gear, bands = DEFAULT_BANDS) {
  const g = clamp(gear, 1, GEAR_COUNT);
  const floor = g === 1 ? 0 : bands.vmax[g - 2];
  const ceil = bands.vmax[g - 1];
  return { floor, ceil, vmax: ceil };
}

export function gearProgress(speedKmh, gear, bands = DEFAULT_BANDS) {
  const { floor, ceil } = gearSpeedSpan(gear, bands);
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
  gear,
  gearCount = GEAR_COUNT,
  idle,
  redline,
  accelLoad = 0,
  decelLoad = 0,
  revLo = REV_DEFAULT.lo,
  pull = REV_DEFAULT.pull,
  floorLo = 1300, // per-gear standing rpm: G1 base
  floorHi = 1800, // per-gear standing rpm: top gear base
}) {
  const span = redline - idle;
  // Each gear STANDS at a low base rpm that steps up with the gear (floorLo … floorHi,
  // e.g. G1 1300 → G5 1800). At steady speed / low load revs settle to that base;
  // ACCELERATION lifts them from there toward the pull ceiling, and after an upshift
  // revs land back near the (higher-gear) base — the "coming down" between gears.
  const g = clamp(gear, 1, gearCount);
  const gt = (g - 1) / Math.max(1, gearCount - 1);
  const floorRpm = floorLo + gt * (floorHi - floorLo);      // 1300 … 1800
  const floorN = clamp((floorRpm - idle) / span, revLo * 0.4, 1);
  let n = floorN + accelLoad * (pull - floorN);             // throttle climbs to pull
  n -= decelLoad * 0.12;                                     // engine-braking dip
  return idle + span * clamp(n, revLo * 0.4, 1.02);
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
