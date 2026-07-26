/**
 * Classic profile contract — single source of truth helpers.
 *
 * Architecture:
 *   assets/classic/{id}.classic.json  = SoT (tune finishes here)
 *   validateClassicProfile()          = gate on Save / Deploy authoring
 *   resolveClassicProfile()           = fill *missing* defaults once at load
 *   AudioEngine                       = pure player (reads resolved profile only)
 *
 * App system (NOT in profile): Master slider, GPS smoothing, UI.
 * Never "fix" intentional profile values at runtime — reject at save instead.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Absolute ranges — used only by validate (and resolve for missing keys). */
export const CLASSIC_LIMITS = {
  engine: {
    // 0 cylinders / 0 idle allowed for pure-EV cards
    cylinders: [0, 16],
    idleRpm: [0, 2500],
    redlineRpm: [1000, 20000],
    rpmCurve: [0.5, 1.5],
    revLo: [0.05, 0.5],
    revHi: [0.2, 1.0],
    revPull: [0.5, 1.1],
  },
  tone: {
    // body/volume floors stop silent/clipping cards — still authorable range
    body: [0.2, 1.5],
    mid: [0, 1.5],
    high: [0, 1.5],
    sub: [0, 1.5],
    noise: [0, 1],
    metallic: [0, 1],
    scream: [0, 1.2],
    turbo: [0, 1],
    turboLag: [0, 1],
    crackle: [0, 1],
    lope: [0, 1.2],
    boxer: [0, 1],
    rotary: [0, 1],
    electric: [0, 1],
    exhaustPulse: [0, 1.2],
    drive: [0, 1],
    filterIdle: [80, 4000],
    filterRedline: [400, 14000],
    resonance: [0, 1],
    volume: [0.4, 1.3],
    idlePresence: [0, 1.2],
    characterMid: [0, 1.2],
    waveguide: [0, 1],
    whoosh: [0, 1.2],
    whine: [0, 1.2],
  },
  mix: {
    master: [0, 100],
    bass: [0, 100],
    edge: [0, 100],
  },
  dynamics: {
    dynDb: [8, 22],
    dynCeiling: [0.5, 1.0],
    loadBoost: [0, 0.6],
    shiftDuck: [0.7, 1.0],
    overrunDuck: [0.7, 1.0],
    floorBias: [0.8, 1.3],
    curveVol: [0.35, 1.25],
    curveRpm: [200, 14000],
  },
};

/** Defaults applied only when a key is missing (not when intentionally set). */
export const CLASSIC_DEFAULTS = {
  engine: {
    type: 'ice',
    cylinders: 8,
    idleRpm: 700,
    redlineRpm: 6500,
    gears: [3.2, 2.0, 1.4, 1.05, 0.85],
    rpmCurve: 0.9,
    revLo: 0.14,
    revHi: 0.45,
    revPull: 0.9,
  },
  tone: {
    harmonics: [0, 1, 0.7, 0.45, 0.35, 0.25, 0.2, 0.15],
    body: 0.85,
    mid: 0.5,
    high: 0.4,
    sub: 0.6,
    noise: 0.12,
    metallic: 0.2,
    scream: 0.3,
    turbo: 0,
    turboLag: 0.4,
    crackle: 0.1,
    lope: 0.2,
    boxer: 0,
    rotary: 0,
    electric: 0,
    exhaustPulse: 0.5,
    drive: 0.4,
    filterIdle: 500,
    filterRedline: 3200,
    resonance: 0.5,
    volume: 1.0,
    idlePresence: 0.75,
    characterMid: 0.5,
    waveguide: 0,
  },
  mix: { master: 72, bass: 55, edge: 30 },
  dynamics: {
    // curve filled relative to idle/redline in resolve if missing
    dynDb: 14,
    dynCeiling: 0.88,
    loadBoost: 0.22,
    shiftDuck: 0.9,
    overrunDuck: 0.9,
    floorBias: 1.0,
    /** Optional per-gear loudness; null → use gearScaleDefault */
    gearScale: null,
  },
};

/** Default gear loudness when profile omits dynamics.gearScale */
export const DEFAULT_GEAR_SCALE = [0.94, 0.97, 1.0, 0.98, 0.96];

export function defaultDynCurve(idle = 700, redline = 6500) {
  const a = Math.max(400, +idle || 700);
  const b = Math.max(a + 500, +redline || 6500);
  const span = b - a;
  return [
    [a, 0.62],
    [a + span * 0.12, 0.74],
    [a + span * 0.35, 0.9],
    [a + span * 0.6, 1.0],
    [a + span * 0.85, 0.94],
    [b, 0.88],
  ];
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkRange(errors, path, v, [lo, hi], required = false) {
  if (v == null || v === '') {
    if (required) errors.push(`${path}: required`);
    return;
  }
  const n = +v;
  if (!Number.isFinite(n)) {
    errors.push(`${path}: not a number (${v})`);
    return;
  }
  if (n < lo || n > hi) {
    errors.push(`${path}: ${n} out of range [${lo}…${hi}]`);
  }
}

/**
 * Validate a Classic profile document for Save.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateClassicProfile(doc) {
  const errors = [];
  const warnings = [];

  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: ['profile: missing'], warnings };
  }
  if (!doc.id || typeof doc.id !== 'string' || /[^\w.-]/.test(doc.id)) {
    errors.push('id: required (alphanumeric, ., -, _)');
  }
  if (!doc.name || String(doc.name).trim() === '') {
    errors.push('name: required');
  }

  const eng = doc.engine;
  if (!eng || typeof eng !== 'object') {
    errors.push('engine: required object');
  } else {
    const L = CLASSIC_LIMITS.engine;
    checkRange(errors, 'engine.cylinders', eng.cylinders, L.cylinders, true);
    checkRange(errors, 'engine.idleRpm', eng.idleRpm, L.idleRpm, true);
    checkRange(errors, 'engine.redlineRpm', eng.redlineRpm, L.redlineRpm, true);
    checkRange(errors, 'engine.rpmCurve', eng.rpmCurve, L.rpmCurve);
    checkRange(errors, 'engine.revLo', eng.revLo, L.revLo);
    checkRange(errors, 'engine.revHi', eng.revHi, L.revHi);
    checkRange(errors, 'engine.revPull', eng.revPull, L.revPull);
    if (isNum(eng.idleRpm) && isNum(eng.redlineRpm) && eng.redlineRpm <= eng.idleRpm + 200) {
      errors.push('engine.redlineRpm: must be > idleRpm + 200');
    }
    if (eng.gears != null && !Array.isArray(eng.gears)) {
      errors.push('engine.gears: must be number[]');
    }
    if (Array.isArray(eng.gears) && eng.gears.length < 1) {
      errors.push('engine.gears: need ≥1 ratio');
    }
  }

  const tone = doc.tone;
  if (!tone || typeof tone !== 'object') {
    errors.push('tone: required object');
  } else {
    const L = CLASSIC_LIMITS.tone;
    for (const key of Object.keys(L)) {
      if (tone[key] == null) continue;
      checkRange(errors, `tone.${key}`, tone[key], L[key]);
    }
    if (tone.harmonics != null && !Array.isArray(tone.harmonics)) {
      errors.push('tone.harmonics: must be number[]');
    }
    if (Array.isArray(tone.harmonics) && tone.harmonics.length < 2) {
      errors.push('tone.harmonics: need ≥2 entries');
    }
    if (tone.volume != null && +tone.volume > 1.25) {
      warnings.push('tone.volume > 1.25: very hot — may clip on car DSP');
    }
    if (
      eng?.type !== 'electric' &&
      tone.idlePresence != null &&
      +tone.idlePresence < 0.2
    ) {
      warnings.push('tone.idlePresence < 0.2: thin idle on ICE — intentional?');
    }
    if (tone.body != null && +tone.body < 0.35) {
      warnings.push('tone.body < 0.35: very thin body layer');
    }
  }

  if (doc.mix && typeof doc.mix === 'object') {
    const L = CLASSIC_LIMITS.mix;
    for (const key of Object.keys(L)) {
      if (doc.mix[key] == null) continue;
      checkRange(errors, `mix.${key}`, doc.mix[key], L[key]);
    }
  }

  // Dynamics — optional object but if present must be valid
  const dyn = doc.dynamics;
  if (dyn != null) {
    if (typeof dyn !== 'object') {
      errors.push('dynamics: must be object');
    } else {
      const L = CLASSIC_LIMITS.dynamics;
      checkRange(errors, 'dynamics.dynDb', dyn.dynDb, L.dynDb);
      checkRange(errors, 'dynamics.dynCeiling', dyn.dynCeiling, L.dynCeiling);
      checkRange(errors, 'dynamics.loadBoost', dyn.loadBoost, L.loadBoost);
      checkRange(errors, 'dynamics.shiftDuck', dyn.shiftDuck, L.shiftDuck);
      checkRange(errors, 'dynamics.overrunDuck', dyn.overrunDuck, L.overrunDuck);
      checkRange(errors, 'dynamics.floorBias', dyn.floorBias, L.floorBias);

      if (dyn.curve != null) {
        if (!Array.isArray(dyn.curve) || dyn.curve.length < 2) {
          errors.push('dynamics.curve: need ≥2 points [[rpm,vol],…]');
        } else {
          let prevRpm = -Infinity;
          dyn.curve.forEach((pt, i) => {
            const rpm = Array.isArray(pt) ? +pt[0] : +pt?.rpm;
            const vol = Array.isArray(pt) ? +pt[1] : +pt?.vol;
            if (!Number.isFinite(rpm) || !Number.isFinite(vol)) {
              errors.push(`dynamics.curve[${i}]: invalid [rpm,vol]`);
              return;
            }
            checkRange(errors, `dynamics.curve[${i}].rpm`, rpm, L.curveRpm);
            checkRange(errors, `dynamics.curve[${i}].vol`, vol, L.curveVol);
            if (rpm < prevRpm) {
              errors.push(`dynamics.curve[${i}]: rpm must be sorted ascending`);
            }
            prevRpm = rpm;
          });
        }
      }
      if (dyn.gearScale != null) {
        if (!Array.isArray(dyn.gearScale) || dyn.gearScale.length < 1) {
          errors.push('dynamics.gearScale: number[] or omit');
        } else {
          dyn.gearScale.forEach((g, i) => {
            checkRange(errors, `dynamics.gearScale[${i}]`, g, [0.7, 1.15]);
          });
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Deep-clone + fill missing keys from CLASSIC_DEFAULTS.
 * Does NOT rewrite values that are already present (even if extreme —
 * those must fail validateClassicProfile at save time).
 *
 * @param {object} raw
 * @returns {object} resolved profile ready for AudioEngine
 */
export function resolveClassicProfile(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('resolveClassicProfile: invalid profile');
  }
  const doc = JSON.parse(JSON.stringify(raw));

  doc.schema = doc.schema || 'tas-classic/1';
  doc.standard = doc.standard || 'classic-audioengine/1';
  doc.id = doc.id || 'unknown';
  doc.name = doc.name || doc.id;
  doc.tag = doc.tag ?? '';
  doc.car = doc.car ?? '';
  doc.accent = doc.accent || 'rgba(148,163,184,0.55)';
  if (doc.samplePack === undefined) doc.samplePack = '';

  doc.engine = { ...CLASSIC_DEFAULTS.engine, ...(doc.engine || {}) };
  if (!Array.isArray(doc.engine.gears) || !doc.engine.gears.length) {
    doc.engine.gears = CLASSIC_DEFAULTS.engine.gears.slice();
  }

  doc.tone = { ...CLASSIC_DEFAULTS.tone, ...(doc.tone || {}) };
  if (!Array.isArray(doc.tone.harmonics) || doc.tone.harmonics.length < 2) {
    doc.tone.harmonics = CLASSIC_DEFAULTS.tone.harmonics.slice();
  }
  // Strip null legacy dyn keys on tone (live under dynamics)
  for (const k of ['dynDb', 'dynCeiling', 'loadBoost', 'dynCurve']) {
    if (doc.tone[k] == null) delete doc.tone[k];
  }

  doc.mix = { ...CLASSIC_DEFAULTS.mix, ...(doc.mix || {}) };

  const idle = doc.engine.idleRpm;
  const red = doc.engine.redlineRpm;
  const dynIn = doc.dynamics && typeof doc.dynamics === 'object' ? doc.dynamics : {};
  doc.dynamics = {
    ...CLASSIC_DEFAULTS.dynamics,
    ...dynIn,
  };
  if (!Array.isArray(doc.dynamics.curve) || doc.dynamics.curve.length < 2) {
    doc.dynamics.curve = defaultDynCurve(idle, red);
  } else {
    doc.dynamics.curve = doc.dynamics.curve.map((p) =>
      Array.isArray(p) ? [+p[0], +p[1]] : [+p.rpm, +p.vol]
    );
    doc.dynamics.curve.sort((a, b) => a[0] - b[0]);
  }
  if (!Array.isArray(doc.dynamics.gearScale) || !doc.dynamics.gearScale.length) {
    doc.dynamics.gearScale = DEFAULT_GEAR_SCALE.slice();
  }

  return doc;
}

/**
 * Merge classic JSON doc onto a base SOUND_PROFILES entry (or empty).
 * JSON wins for every provided group — no silent keep of stale tone keys
 * when the file replaces the group? We still shallow-merge tone so partial
 * files work; full authoring should write complete groups.
 */
export function mergeClassicDoc(base, doc) {
  if (!doc?.id) return base;
  const out = base ? { ...base } : { id: doc.id };
  out.id = doc.id;
  if (doc.name != null) out.name = doc.name;
  if (doc.tag != null) out.tag = doc.tag;
  if (doc.car != null) out.car = doc.car;
  if (doc.accent != null) out.accent = doc.accent;
  if (doc.samplePack != null) out.samplePack = doc.samplePack;
  if (doc.engine && typeof doc.engine === 'object') {
    out.engine = { ...(out.engine || {}), ...doc.engine };
    if (Array.isArray(doc.engine.gears)) out.engine.gears = doc.engine.gears.slice();
  }
  if (doc.tone && typeof doc.tone === 'object') {
    out.tone = { ...(out.tone || {}), ...doc.tone };
    if (Array.isArray(doc.tone.harmonics)) out.tone.harmonics = doc.tone.harmonics.slice();
  }
  if (doc.mix && typeof doc.mix === 'object') {
    out.mix = { ...(out.mix || {}), ...doc.mix };
  }
  if (doc.dynamics && typeof doc.dynamics === 'object') {
    out.dynamics = { ...(out.dynamics || {}), ...doc.dynamics };
    if (Array.isArray(doc.dynamics.curve)) {
      out.dynamics.curve = doc.dynamics.curve.map((p) =>
        Array.isArray(p) ? [+p[0], +p[1]] : [+p.rpm, +p.vol]
      );
    }
    if (Array.isArray(doc.dynamics.gearScale)) {
      out.dynamics.gearScale = doc.dynamics.gearScale.slice();
    }
  }
  out.vessel = false;
  return resolveClassicProfile(out);
}

export default {
  CLASSIC_LIMITS,
  CLASSIC_DEFAULTS,
  DEFAULT_GEAR_SCALE,
  defaultDynCurve,
  validateClassicProfile,
  resolveClassicProfile,
  mergeClassicDoc,
};
