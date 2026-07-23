/**
 * 3-speed virtual gearbox — realistic RPM ladders (not copy-paste sweeps)
 *
 * Real car: after upshift RPM drops into a *higher absolute floor* than G1
 * bottom, then climbs a *different* band. Higher gears are more “cruise mid”
 * (911 tunnel growl) and need less redline drama.
 *
 *   G1:  0 – ~45   wide launch band
 *   G2: 45 – ~85   mid pull
 *   G3: 85 – 120+  cruise character
 */

import { clamp } from './animations.js';

export const GEAR_VMAX = [45, 85, 120];
export const GEAR_COUNT = 3;

const UP_AT = [42, 82, 999];
/** DOWN_AT[i] = leave gear i+2 downward below this speed (G2→G1 @32, G3→G2 @70) */
const DOWN_AT = [32, 70];

/**
 * Per-gear RPM band as fraction of (idle→redline).
 * Floor after shift / bottom of band · ceiling under full pull.
 * Intentionally NOT the same span every gear.
 */
export const GEAR_RPM_BAND = {
  // G1: can live from idle-ish to near redline
  1: { cruiseLo: 0.18, cruiseHi: 0.55, pullHi: 0.98, width: 1.0 },
  // G2: lands mid after shift (~45%), pulls to high but not “restart from idle”
  2: { cruiseLo: 0.38, cruiseHi: 0.62, pullHi: 0.9, width: 0.72 },
  // G3: 911-style — strong mid presence, redline only if you ask
  3: { cruiseLo: 0.42, cruiseHi: 0.58, pullHi: 0.82, width: 0.55 },
};

export function resolveGear(speedKmh, currentGear = 1, accelLoad = 0, decelLoad = 0) {
  let g = clamp(Math.round(currentGear) || 1, 1, GEAR_COUNT);
  const v = Math.max(0, speedKmh);

  // Under load, hold gears longer before upshifting (THOR EV behavior)
  const upBias = accelLoad * 8;
  const downBias = decelLoad * 8;

  while (g < GEAR_COUNT && v >= UP_AT[g - 1] + upBias) g += 1;
  while (g > 1 && v < DOWN_AT[g - 2] - downBias) g -= 1;

  // THOR-style kickdown: strong throttle drops gear(s) for rev drama, but
  // only when the lower gear still covers this speed without instantly
  // upshifting back (kept below the lower gear's biased up-threshold).
  if (accelLoad > 0.5 && g > 1) {
    let drops = accelLoad > 0.85 ? 2 : 1;
    while (drops > 0 && g > 1 && v < UP_AT[g - 2] + upBias - 1.5) {
      g -= 1;
      drops -= 1;
    }
  }

  if (v >= 120) g = GEAR_COUNT;
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

function bandFor(gear) {
  return GEAR_RPM_BAND[clamp(gear, 1, GEAR_COUNT)] || GEAR_RPM_BAND[1];
}

/**
 * Absolute RPM just after an upshift into `gear` (where the “note” lands).
 */
export function shiftLandingRpm(gear, idle, redline) {
  const b = bandFor(gear);
  // Land slightly above cruiseLo — real upshift into the meat of the band
  const n = b.cruiseLo + 0.04;
  return idle + (redline - idle) * n;
}

/**
 * RPM target inside current gear — different ladder per gear.
 *
 * G1: big swing (launch drama)
 * G2: mid floor → high (not a clone of G1)
 * G3: mid “character band” — enthusiast tunnel feel without needing redline
 */
export function rpmInGear({
  speedKmh,
  gear,
  idle,
  redline,
  accelLoad = 0,
  decelLoad = 0,
}) {
  const pos = gearProgress(speedKmh, gear);
  const b = bandFor(gear);
  const span = redline - idle;

  // Position inside this gear’s own cruise corridor (not 0.3→0.7 every time)
  const cruiseN = b.cruiseLo + pos * (b.cruiseHi - b.cruiseLo);

  // Full pull ceiling is gear-specific (G3 doesn’t scream to 98% by default)
  const pullN = b.cruiseLo + pos * (b.pullHi - b.cruiseLo) * (0.55 + b.width * 0.45);
  const pullCap = b.pullHi;

  let n = cruiseN + accelLoad * (Math.min(pullN, pullCap) - cruiseN);

  // Mild overrun — not silent, still “on the cam” in higher gears
  n -= decelLoad * (gear === 1 ? 0.22 : 0.12);

  // G1 launch: allow real climb to redline
  if (gear === 1 && accelLoad > 0.3) {
    n = Math.max(n, 0.28 + accelLoad * 0.55 * (0.2 + pos));
  }

  // G3 character: even light cruise sits in the “howl starts” zone
  if (gear === 3) {
    n = Math.max(n, b.cruiseLo * 0.95);
    // Extra pull in G3 adds presence more than pitch panic
    if (accelLoad > 0.15) {
      n += accelLoad * 0.06;
    }
  }

  // Above 120 in top gear — denser cruise, not endless G1-style climb
  if (gear === GEAR_COUNT && speedKmh > 120) {
    const over = clamp((speedKmh - 120) / 80, 0, 1);
    n = Math.max(n, b.cruiseHi * 0.9 + over * 0.12 + accelLoad * 0.15);
  }

  n = clamp(n, gear === 1 ? 0.1 : b.cruiseLo * 0.85, 1.02);
  return idle + span * n;
}

/**
 * Tone bias:
 * - Low gear: raw / aggressive
 * - High gear: more mid “identity” (911 tunnel), less need for redline scream
 */
export function gearToneBias(gear) {
  const g = clamp(gear, 1, GEAR_COUNT);
  const t = (g - 1) / Math.max(1, GEAR_COUNT - 1);
  return {
    aggression: 1.2 - t * 0.25,
    body: 1.0 + t * 0.08, // more body in tall gear = character at cruise
    high: 0.75 + t * 0.15, // less thin scream dependency
    /** Mid “tunnel” presence — peaks in G2–G3 */
    character: 0.55 + t * 0.55,
    /** Where high layer starts opening (lower = earlier howl) */
    howlStart: 0.38 - t * 0.12,
    shiftDrop: 0.62, // unused for landing; kept for compat
  };
}
