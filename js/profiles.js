/**
 * 15 real-engine sound profiles
 * Tuned for combustion character: V12, turbo I6, VTEC, boxer, rotary, EV, muscle…
 */

/**
 * @typedef {Object} SoundProfile
 * @property {string} id
 * @property {string} name
 * @property {string} tag
 * @property {string} car
 * @property {string} accent
 * @property {Object} engine
 * @property {Object} tone
 * @property {string} [samplePack] optional folder under assets/samples/
 */

/**
 * Helper: relative harmonic strengths for periodic-wave body
 * Index 1 = fundamental
 */

/** @type {SoundProfile[]} */
export const SOUND_PROFILES = [
  {
    id: 'na-v12',
    name: 'NA V12',
    tag: 'Scream',
    car: 'Ferrari 812 · Lambo',
    accent: 'rgba(239, 68, 68, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 12,
      idleRpm: 880,
      redlineRpm: 8900,
      gears: [3.8, 2.5, 1.8, 1.35, 1.05, 0.88],
      rpmCurve: 0.92,
    },
    tone: {
      // Smooth high-order harmonics — sweet opera scream
      harmonics: [0, 1, 0.72, 0.55, 0.42, 0.38, 0.32, 0.28, 0.24, 0.2, 0.16, 0.14, 0.12],
      body: 0.72,
      mid: 0.55,
      high: 0.95,
      sub: 0.35,
      noise: 0.1,
      metallic: 0.45,
      scream: 1.0,
      turbo: 0,
      turboLag: 0,
      crackle: 0.05,
      lope: 0.05,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.25,
      drive: 0.35,
      filterIdle: 900,
      filterRedline: 7800,
      resonance: 0.55,
      volume: 1.0,
      /* Refined 12-cyl idle — calm bed, character lives up top */
      idlePresence: 0.62,
      characterMid: 0.6,
    },
  },
  {
    id: 'rb26',
    name: 'RB26',
    tag: 'Turbo',
    car: 'Skyline R34 GT-R',
    accent: 'rgba(148, 163, 184, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 6,
      idleRpm: 900,
      redlineRpm: 8000,
      gears: [3.6, 2.3, 1.6, 1.2, 0.95, 0.78],
      rpmCurve: 0.95,
    },
    tone: {
      harmonics: [0, 1, 0.55, 0.7, 0.35, 0.48, 0.22, 0.3, 0.18, 0.2],
      body: 0.7,
      mid: 0.65,
      high: 0.55,
      sub: 0.5,
      noise: 0.22,
      metallic: 0.35,
      scream: 0.55,
      turbo: 0.95,
      turboLag: 0.55,
      turboTone: 0.75,
      crackle: 0.55,
      lope: 0.08,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.4,
      drive: 0.55,
      filterIdle: 550,
      filterRedline: 5200,
      resonance: 0.75,
      volume: 1.05,
      idlePresence: 0.68,
      characterMid: 0.55,
    },
  },
  {
    id: '2jz',
    name: '2JZ',
    tag: 'Deep Scream',
    car: 'Supra MK4',
    accent: 'rgba(251, 146, 60, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 6,
      idleRpm: 800,
      redlineRpm: 7200,
      gears: [3.5, 2.2, 1.55, 1.15, 0.9, 0.75],
      rpmCurve: 0.9,
    },
    tone: {
      // Deep body + climbing high scream
      harmonics: [0, 1, 0.85, 0.5, 0.55, 0.3, 0.4, 0.2, 0.28, 0.15, 0.2],
      body: 0.85,
      mid: 0.6,
      high: 0.75,
      sub: 0.75,
      noise: 0.2,
      metallic: 0.3,
      scream: 0.85,
      turbo: 0.85,
      turboLag: 0.65,
      turboTone: 0.6,
      crackle: 0.45,
      lope: 0.1,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.45,
      drive: 0.6,
      filterIdle: 420,
      filterRedline: 5600,
      resonance: 0.7,
      volume: 1.06,
      idlePresence: 0.68,
      characterMid: 0.5,
    },
  },
  {
    id: 'f20c',
    name: 'F20C',
    tag: 'Metallic',
    car: 'Honda S2000',
    accent: 'rgba(248, 250, 252, 0.5)',
    engine: {
      type: 'ice',
      cylinders: 4,
      idleRpm: 870,
      redlineRpm: 9000,
      gears: [3.9, 2.6, 1.85, 1.4, 1.1, 0.9],
      rpmCurve: 1.05,
    },
    tone: {
      // Sharp, metallic high-rev F20 scream
      harmonics: [0, 1, 0.4, 0.75, 0.25, 0.55, 0.2, 0.45, 0.18, 0.35, 0.15, 0.28],
      body: 0.55,
      mid: 0.7,
      high: 1.0,
      sub: 0.25,
      noise: 0.12,
      metallic: 0.95,
      scream: 1.0,
      turbo: 0,
      turboLag: 0,
      crackle: 0.08,
      lope: 0.05,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.35,
      drive: 0.4,
      filterIdle: 1100,
      filterRedline: 9000,
      resonance: 0.85,
      volume: 0.98,
      /* Small NA 4-cyl — quiet civilized idle, explodes past VTEC */
      idlePresence: 0.55,
      characterMid: 0.35,
    },
  },
  {
    id: 'flat6-911',
    name: 'Flat-6',
    tag: 'Boxer',
    car: 'Porsche 911 GT3',
    accent: 'rgba(250, 204, 21, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 6,
      idleRpm: 900,
      redlineRpm: 9000,
      gears: [3.7, 2.45, 1.75, 1.3, 1.05, 0.88],
      rpmCurve: 1.0,
    },
    tone: {
      // 911 enthusiast: mid-band howl / tunnel presence, not only redline scream
      harmonics: [0, 1, 0.35, 0.85, 0.3, 0.55, 0.38, 0.45, 0.25, 0.35],
      body: 0.72,
      mid: 0.9,
      high: 0.78,
      sub: 0.42,
      noise: 0.12,
      metallic: 0.5,
      scream: 0.72,
      turbo: 0,
      turboLag: 0,
      crackle: 0.1,
      lope: 0.12,
      boxer: 1.0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.75,
      drive: 0.4,
      filterIdle: 700,
      filterRedline: 7800,
      resonance: 0.85,
      volume: 1.05,
      idlePresence: 0.75,
      /** Mid-rev identity without full throttle (tunnel / cruise howl) */
      characterMid: 1.0,
    },
  },
  {
    id: 's58-s55',
    name: 'S58 / S55',
    tag: 'Aggressive',
    car: 'BMW M3 / M4',
    accent: 'rgba(59, 130, 246, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 6,
      idleRpm: 800,
      redlineRpm: 7200,
      gears: [3.55, 2.25, 1.6, 1.2, 0.95, 0.8],
      rpmCurve: 0.95,
    },
    tone: {
      harmonics: [0, 1, 0.65, 0.55, 0.48, 0.4, 0.32, 0.28, 0.22],
      body: 0.75,
      mid: 0.7,
      high: 0.65,
      sub: 0.55,
      noise: 0.18,
      metallic: 0.4,
      scream: 0.7,
      turbo: 0.7,
      turboLag: 0.35,
      turboTone: 0.55,
      crackle: 0.4,
      lope: 0.08,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.42,
      drive: 0.58,
      filterIdle: 500,
      filterRedline: 5800,
      resonance: 0.72,
      volume: 1.05,
      idlePresence: 0.66,
      characterMid: 0.5,
    },
  },
  {
    id: 'coyote-v8',
    name: 'Coyote V8',
    tag: 'American',
    car: 'Ford Mustang',
    accent: 'rgba(239, 68, 68, 0.5)',
    engine: {
      type: 'ice',
      cylinders: 8,
      idleRpm: 700,
      redlineRpm: 7500,
      gears: [3.4, 2.15, 1.5, 1.15, 0.9, 0.72],
      rpmCurve: 0.88,
    },
    tone: {
      // Cross-plane V8 growl — strong even/odd mix
      harmonics: [0, 1, 0.9, 0.45, 0.7, 0.35, 0.55, 0.25, 0.4, 0.2],
      body: 0.9,
      mid: 0.55,
      high: 0.4,
      sub: 0.85,
      noise: 0.16,
      metallic: 0.2,
      scream: 0.35,
      turbo: 0,
      turboLag: 0,
      crackle: 0.15,
      lope: 0.35,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.7,
      drive: 0.55,
      filterIdle: 350,
      filterRedline: 3800,
      resonance: 0.6,
      volume: 1.08,
      /* Cross-plane V8 — idle rumble is half the point */
      idlePresence: 0.8,
      characterMid: 0.6,
    },
  },
  {
    id: 'k20c',
    name: 'K20C',
    tag: 'VTEC',
    car: 'Civic Type R FK8',
    accent: 'rgba(220, 38, 38, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 4,
      idleRpm: 780,
      redlineRpm: 7000,
      gears: [3.8, 2.5, 1.75, 1.3, 1.05, 0.88],
      rpmCurve: 1.0,
      // VTEC-ish cam switch region
      camSwitchNorm: 0.55,
    },
    tone: {
      harmonics: [0, 1, 0.45, 0.7, 0.3, 0.5, 0.25, 0.4, 0.2, 0.32],
      body: 0.6,
      mid: 0.75,
      high: 0.95,
      sub: 0.3,
      noise: 0.15,
      metallic: 0.7,
      scream: 0.95,
      turbo: 0.55,
      turboLag: 0.28,
      turboTone: 0.5,
      crackle: 0.35,
      lope: 0.06,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.38,
      drive: 0.48,
      filterIdle: 700,
      filterRedline: 7200,
      resonance: 0.9,
      volume: 1.0,
      idlePresence: 0.55,
      characterMid: 0.4,
      // Boost high harmonics after cam switch
      vtecBoost: 1.0,
    },
  },
  {
    id: 'vr6',
    name: 'VR6',
    tag: 'Unique I6',
    car: 'VW Golf R32',
    accent: 'rgba(34, 197, 94, 0.5)',
    engine: {
      type: 'ice',
      cylinders: 6,
      idleRpm: 800,
      redlineRpm: 6800,
      gears: [3.5, 2.2, 1.55, 1.15, 0.9, 0.75],
      rpmCurve: 0.9,
    },
    tone: {
      // Narrow-angle VR growl — warm midrange growl
      harmonics: [0, 1, 0.75, 0.6, 0.55, 0.45, 0.38, 0.3, 0.25],
      body: 0.8,
      mid: 0.85,
      high: 0.45,
      sub: 0.55,
      noise: 0.12,
      metallic: 0.25,
      scream: 0.4,
      turbo: 0,
      turboLag: 0,
      crackle: 0.1,
      lope: 0.12,
      boxer: 0.2,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.5,
      drive: 0.45,
      filterIdle: 480,
      filterRedline: 4200,
      resonance: 0.65,
      volume: 1.0,
      idlePresence: 0.72,
      /* THE VR6 signature is its warm midrange warble — max tunnel presence */
      characterMid: 0.85,
    },
  },
  {
    id: '4g63',
    name: '4G63',
    tag: 'Spool+Crackle',
    car: 'Lancer Evo',
    accent: 'rgba(239, 68, 68, 0.45)',
    engine: {
      type: 'ice',
      cylinders: 4,
      idleRpm: 900,
      redlineRpm: 7500,
      gears: [3.7, 2.4, 1.7, 1.25, 1.0, 0.82],
      rpmCurve: 0.98,
    },
    tone: {
      harmonics: [0, 1, 0.5, 0.65, 0.35, 0.45, 0.28, 0.35, 0.2],
      body: 0.65,
      mid: 0.7,
      high: 0.6,
      sub: 0.45,
      noise: 0.28,
      metallic: 0.4,
      scream: 0.55,
      turbo: 1.0,
      turboLag: 0.7,
      turboTone: 0.85,
      crackle: 0.95,
      lope: 0.1,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.48,
      drive: 0.65,
      filterIdle: 500,
      filterRedline: 5500,
      resonance: 0.8,
      volume: 1.05,
      idlePresence: 0.64,
    },
  },
  {
    id: 'ls-v8',
    name: 'LS V8',
    tag: 'Deep V8',
    car: 'Chevrolet Corvette',
    accent: 'rgba(234, 179, 8, 0.5)',
    engine: {
      type: 'ice',
      cylinders: 8,
      idleRpm: 620,
      redlineRpm: 6600,
      gears: [3.3, 2.1, 1.45, 1.1, 0.88, 0.7],
      rpmCurve: 0.85,
    },
    tone: {
      harmonics: [0, 1, 0.95, 0.4, 0.75, 0.3, 0.55, 0.22, 0.4],
      body: 0.95,
      mid: 0.5,
      high: 0.3,
      sub: 0.95,
      noise: 0.14,
      metallic: 0.15,
      scream: 0.25,
      turbo: 0,
      turboLag: 0,
      crackle: 0.12,
      lope: 0.45,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.8,
      drive: 0.58,
      filterIdle: 280,
      filterRedline: 3200,
      resonance: 0.55,
      volume: 1.12,
      /* Big lazy V8 — idle burble front and center */
      idlePresence: 0.85,
      characterMid: 0.6,
    },
  },
  {
    id: 'camaro-restomod',
    name: 'Camaro Restomod',
    tag: 'LS7 Resto',
    car: 'Chevy Camaro · LS7',
    accent: 'rgba(234, 88, 12, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 8,
      idleRpm: 780,
      redlineRpm: 6500,
      gears: [3.3, 2.1, 1.45, 1.1, 0.88],
      rpmCurve: 0.82,
      // Torquey LS7 restomod: lazy cruise, pulls with authority (not a screamer)
      revLo: 0.15,
      revHi: 0.5,
      revPull: 0.9,
    },
    tone: {
      // Low harmonic richness, high body, no metallic scream (spec harmonic bank)
      harmonics: [0, 1, 0.82, 0.55, 0.48, 0.32, 0.28, 0.24, 0.18, 0.14, 0.11, 0.09, 0.08],
      body: 0.98,
      mid: 0.5,
      high: 0.22,
      sub: 0.92,
      noise: 0.16,
      metallic: 0.08,
      scream: 0.1,
      turbo: 0,
      turboLag: 0,
      crackle: 0.12,
      // very-high pulse separation at idle/low-rpm (LS7 Alpha reference)
      lope: 0.68,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.95,
      drive: 0.48,
      filterIdle: 260,
      // brightness may rise slightly with rpm but body stays dominant — no Ferrari transition
      filterRedline: 3100,
      resonance: 0.52,
      volume: 1.12,
      // Lopey factory-performance idle up front — the growl/roar identity
      idlePresence: 0.88,
      characterMid: 0.75,
    },
    mix: { master: 74, bass: 92, edge: 8 },
  },
  {
    // Same LS7 restomod, but sound is generated by the VESSEL synthesis runtime
    // (js/vessel-audio.js). app.js routes this id to VesselAudio; the tone{} below
    // is only a graceful fallback if the VESSEL runtime fails to load.
    id: 'camaro-vessel',
    name: 'Camaro · VESSEL',
    tag: 'LS7 · synthesis',
    car: 'Chevy Camaro · LS7 (new engine)',
    accent: 'rgba(57, 208, 216, 0.55)',
    /** VESSEL: sound identity lives in rig, not tone{} (tone kept as classic fallback only). */
    vessel: true,
    engine: {
      type: 'ice',
      cylinders: 8,
      idleRpm: 780,
      redlineRpm: 6500,
      gears: [3.3, 2.1, 1.45, 1.1, 0.88],
      rpmCurve: 0.82,
      revLo: 0.15,
      revHi: 0.5,
      revPull: 0.9,
    },
    tone: {
      harmonics: [0, 1, 0.82, 0.55, 0.48, 0.32, 0.28, 0.24, 0.18, 0.14, 0.11, 0.09, 0.08],
      body: 0.98, mid: 0.5, high: 0.22, sub: 0.92, noise: 0.16, metallic: 0.08, scream: 0.1,
      turbo: 0, turboLag: 0, crackle: 0.12, lope: 0.68, boxer: 0, rotary: 0, electric: 0,
      exhaustPulse: 0.95, drive: 0.48, filterIdle: 260, filterRedline: 3100, resonance: 0.52,
      volume: 1.12, idlePresence: 0.88, characterMid: 0.75,
    },
    // Sound Profile defaults (Bass/Edge). Master is App System starting level only.
    mix: { master: 70, bass: 88, edge: 10 },
  },
  {
    id: 'rotary-vessel',
    name: 'Rotary · VESSEL',
    tag: '13B · synthesis',
    car: 'Mazda 13B twin-rotor',
    accent: 'rgba(248, 113, 113, 0.55)',
    vessel: true,
    engine: {
      type: 'ice',
      cylinders: 2,
      idleRpm: 900,
      redlineRpm: 8500,
      gears: [3.5, 2.2, 1.55, 1.15, 0.92],
      rpmCurve: 0.95,
      revLo: 0.18,
      revHi: 0.55,
      revPull: 0.95,
    },
    tone: {
      // fallback only if VesselAudio fails
      harmonics: [0, 1, 0.5, 0.7, 0.4, 0.55, 0.35, 0.45],
      body: 0.55, mid: 0.75, high: 0.95, sub: 0.35, noise: 0.22, metallic: 0.55, scream: 0.7,
      turbo: 0, turboLag: 0, crackle: 0.35, lope: 0.15, boxer: 0, rotary: 1, electric: 0,
      exhaustPulse: 0.7, drive: 0.4, filterIdle: 500, filterRedline: 7200, resonance: 0.55,
      volume: 1.0, idlePresence: 0.7, characterMid: 0.7,
    },
    mix: { master: 68, bass: 55, edge: 35 },
  },
  {
    id: 'american-vessel',
    name: 'American · VESSEL',
    tag: 'Big V8 · synthesis',
    car: 'American big-inch muscle',
    accent: 'rgba(251, 191, 36, 0.55)',
    vessel: true,
    engine: {
      type: 'ice',
      cylinders: 8,
      idleRpm: 650,
      redlineRpm: 5600,
      gears: [3.2, 2.0, 1.4, 1.05, 0.85],
      rpmCurve: 0.78,
      revLo: 0.12,
      revHi: 0.42,
      revPull: 0.88,
    },
    tone: {
      harmonics: [0, 1, 0.9, 0.5, 0.55, 0.3, 0.28, 0.2],
      body: 1.0, mid: 0.45, high: 0.18, sub: 0.98, noise: 0.14, metallic: 0.06, scream: 0.08,
      turbo: 0, turboLag: 0, crackle: 0.1, lope: 0.85, boxer: 0, rotary: 0, electric: 0,
      exhaustPulse: 1.0, drive: 0.45, filterIdle: 200, filterRedline: 2800, resonance: 0.55,
      volume: 1.15, idlePresence: 0.95, characterMid: 0.5,
    },
    mix: { master: 72, bass: 98, edge: 6 },
  },
  {
    id: 'gentle-vessel',
    name: 'Gentle · VESSEL',
    tag: 'Pure Resonance',
    car: 'Old school American · zero-noise V8',
    accent: 'rgba(217, 119, 6, 0.55)',
    vessel: true,
    engine: {
      type: 'ice',
      cylinders: 8,
      idleRpm: 600,
      redlineRpm: 5800,
      gears: [3.2, 2.0, 1.4, 1.05, 0.85],
      rpmCurve: 0.8,
      revLo: 0.1,
      revHi: 0.37,
      revPull: 0.88,
    },
    tone: {
      // fallback if Vessel fails — mirror classic-muscle tone
      harmonics: [0, 1, 1.0, 0.35, 0.8, 0.25, 0.55, 0.18, 0.4, 0.12],
      body: 1.0, mid: 0.4, high: 0.2, sub: 1.0, noise: 0.18, metallic: 0.1, scream: 0.15,
      turbo: 0, turboLag: 0, crackle: 0.2, lope: 1.0, boxer: 0, rotary: 0, electric: 0,
      exhaustPulse: 1.0, drive: 0.42, filterIdle: 220, filterRedline: 2600, resonance: 0.5,
      volume: 1.15, idlePresence: 0.95, characterMid: 0.55,
    },
    mix: { master: 70, bass: 92, edge: 5 },
  },
  {
    id: 'b58',
    name: 'B58',
    tag: 'Modern Turbo',
    car: 'Supra A90',
    accent: 'rgba(56, 189, 248, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 6,
      idleRpm: 750,
      redlineRpm: 7000,
      gears: [3.45, 2.2, 1.55, 1.15, 0.92, 0.76],
      rpmCurve: 0.92,
    },
    tone: {
      // Clean modern turbo I6 — refined but angry
      harmonics: [0, 1, 0.7, 0.55, 0.45, 0.38, 0.3, 0.25, 0.2],
      body: 0.72,
      mid: 0.68,
      high: 0.55,
      sub: 0.5,
      noise: 0.16,
      metallic: 0.35,
      scream: 0.55,
      turbo: 0.75,
      turboLag: 0.3,
      turboTone: 0.55,
      crackle: 0.3,
      lope: 0.06,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.38,
      drive: 0.5,
      filterIdle: 520,
      filterRedline: 5400,
      resonance: 0.68,
      volume: 1.0,
      idlePresence: 0.62,
      characterMid: 0.5,
    },
  },
  {
    id: 'rotary-rx7',
    name: 'Rotary',
    tag: 'Wail',
    car: 'Mazda RX-7 FD',
    accent: 'rgba(251, 113, 133, 0.55)',
    engine: {
      type: 'rotary',
      cylinders: 2, // twin-rotor feel
      idleRpm: 820,
      redlineRpm: 8500,
      gears: [3.6, 2.35, 1.65, 1.25, 1.0, 0.82],
      rpmCurve: 1.08,
      // Rotary screamer: revs high, brap all the way to redline
      revLo: 0.24,
      revHi: 0.8,
      revPull: 1.0,
    },
    tone: {
      // High, buzzy rotary wail — strong high harmonics
      harmonics: [0, 1, 0.3, 0.85, 0.25, 0.7, 0.2, 0.55, 0.18, 0.45, 0.15, 0.35],
      body: 0.5,
      mid: 0.8,
      high: 1.0,
      sub: 0.2,
      noise: 0.3,
      metallic: 0.72,
      scream: 1.0,
      turbo: 0.8,
      turboLag: 0.45,
      turboTone: 0.7,
      crackle: 0.35,
      lope: 0.08,
      boxer: 0,
      rotary: 1.0,
      electric: 0,
      exhaustPulse: 0.3,
      drive: 0.45,
      filterIdle: 1000,
      filterRedline: 9500,
      resonance: 1.0,
      volume: 1.0,
      /* Rotary idles with a buzzy "pant", then the brap wail takes over up top */
      idlePresence: 0.64,
      characterMid: 0.4,
    },
  },
  {
    id: 'electric-hyper',
    name: 'Electric Hyper',
    tag: 'Futuristic',
    car: 'Rimac · Battista',
    accent: 'rgba(167, 139, 250, 0.55)',
    engine: {
      type: 'electric',
      cylinders: 0,
      idleRpm: 0,
      redlineRpm: 18000,
      gears: [1],
      rpmCurve: 1.15,
    },
    tone: {
      harmonics: [0, 1, 0.2, 0.15, 0.1, 0.08],
      body: 0.25,
      mid: 0.4,
      high: 0.9,
      sub: 0.15,
      noise: 0.35,
      metallic: 0.2,
      scream: 0.7,
      turbo: 0,
      turboLag: 0,
      crackle: 0,
      lope: 0,
      boxer: 0,
      rotary: 0,
      electric: 1.0,
      exhaustPulse: 0,
      drive: 0.15,
      filterIdle: 1200,
      filterRedline: 12000,
      resonance: 0.4,
      volume: 0.95,
      idlePresence: 0.12,
      whoosh: 0.9,
      whine: 1.0,
    },
  },
  {
    id: 'classic-muscle',
    name: 'Classic Muscle',
    tag: 'Lopey V8',
    car: 'Old school American',
    accent: 'rgba(180, 83, 9, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 8,
      idleRpm: 600,
      redlineRpm: 5800,
      gears: [3.2, 2.0, 1.4, 1.05, 0.85],
      rpmCurve: 0.8,
      // Stage-3 lazy muscle: cruise ~1100 rpm, shift ~2500, digs to ~4600 flat-out
      revLo: 0.1,
      revHi: 0.37,
      revPull: 0.88,
    },
    tone: {
      // Cammed lopey idle + lazy thunder
      harmonics: [0, 1, 1.0, 0.35, 0.8, 0.25, 0.55, 0.18, 0.4, 0.12],
      body: 1.0,
      mid: 0.4,
      high: 0.2,
      sub: 1.0,
      noise: 0.18,
      metallic: 0.1,
      scream: 0.15,
      turbo: 0,
      turboLag: 0,
      crackle: 0.2,
      lope: 1.0,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 1.0,
      drive: 0.42,
      filterIdle: 220,
      filterRedline: 2600,
      resonance: 0.5,
      volume: 1.15,
      idlePresence: 0.95,
      characterMid: 0.55,
    },
    /** Per-profile default slider positions (0–100) */
    mix: { master: 70, bass: 90, edge: 5 },
  },
  {
    id: 's85-v10',
    name: 'S85 V10',
    tag: 'Sweet V10',
    car: 'BMW M5 E60',
    accent: 'rgba(37, 99, 235, 0.55)',
    engine: {
      type: 'ice',
      cylinders: 10,
      idleRpm: 700,
      redlineRpm: 8250,
      gears: [3.7, 2.4, 1.75, 1.35, 1.05, 0.85],
      rpmCurve: 1.0,
      // Analyzed from a real S85 bank: clean harmonics, revs high & screams
      revLo: 0.14,
      revHi: 0.5,
      revPull: 0.96,
    },
    tone: {
      // Smooth, musical V10 — clean stacked harmonics that brighten with revs
      harmonics: [0, 1, 0.7, 0.52, 0.42, 0.36, 0.3, 0.26, 0.22, 0.18, 0.15, 0.12],
      body: 0.6,
      mid: 0.62,
      high: 0.92,
      sub: 0.34,
      noise: 0.08,
      metallic: 0.4,
      scream: 0.95,
      turbo: 0,
      turboLag: 0,
      crackle: 0.08,
      lope: 0.06,
      boxer: 0,
      rotary: 0,
      electric: 0,
      exhaustPulse: 0.35,
      drive: 0.34,
      filterIdle: 620,
      filterRedline: 7600,
      resonance: 0.6,
      volume: 1.02,
      idlePresence: 0.58,
      characterMid: 0.62,
    },
  },
];

export function getProfileById(id) {
  return SOUND_PROFILES.find((p) => p.id === id) || getVisibleProfiles()[0] || SOUND_PROFILES[0];
}

/**
 * Fallback if assets/vessel/live-set.json is missing / invalid.
 * Production Online set is owned by live-set.json (written by CommandRoom Apply).
 */
export const SHIP_ACTIVE_IDS = [
  'camaro-restomod',
  'camaro-vessel',
  'gentle-vessel',
  'rotary-vessel',
  'american-vessel',
  'classic-muscle',
  'rotary-rx7',
  's85-v10',
];

const LIVE_SET_URL = 'assets/vessel/live-set.json';
const CLASSIC_REGISTRY_URL = 'assets/classic/registry.json';

/** @type {string[]|null} */
let _liveOverride = null;
/** @type {object|null} last loaded live-set meta (status, message, lastPush…) */
let _liveSetMeta = null;
/** @type {boolean} classic JSON standards merged this session */
let _classicLoaded = false;

export function setLiveProfileIds(ids) {
  if (!ids || !ids.length) {
    _liveOverride = null;
    return;
  }
  _liveOverride = ids.slice();
}

export function getLiveProfileIds() {
  return (_liveOverride && _liveOverride.length ? _liveOverride : SHIP_ACTIVE_IDS).slice();
}

export function getLiveSetMeta() {
  return _liveSetMeta;
}

/**
 * Load Online carousel set for EVERY host (GitHub Pages + localhost).
 * Source of truth: assets/vessel/live-set.json (CommandRoom Apply Online / Deploy).
 * @returns {Promise<boolean>}
 */
export async function loadLiveSet() {
  try {
    const res = await fetch(LIVE_SET_URL, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    if (!Array.isArray(data.live) || !data.live.length) return false;
    // keep only ids that exist in this build
    const known = new Set(SOUND_PROFILES.map((p) => p.id));
    const live = data.live.filter((id) => known.has(id));
    if (!live.length) return false;
    _liveOverride = live;
    _liveSetMeta = data;
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge Classic standard JSON (assets/classic/*.classic.json) into SOUND_PROFILES.
 * Vessel profiles (vessel:true) are never overwritten — they stay sealed/rig-based.
 * Embedded profiles.js remains fallback if fetch fails.
 * @returns {Promise<number>} number of profiles merged
 */
export async function loadClassicStandards() {
  if (_classicLoaded) return 0;
  try {
    const regRes = await fetch(CLASSIC_REGISTRY_URL, { cache: 'no-store' });
    if (!regRes.ok) return 0;
    const reg = await regRes.json();
    const list = Array.isArray(reg.profiles) ? reg.profiles : [];
    let n = 0;
    await Promise.all(
      list.map(async (entry) => {
        const id = entry?.id;
        if (!id) return;
        const base = SOUND_PROFILES.find((p) => p.id === id);
        if (!base || base.vessel) return;
        const url = entry.file || `assets/classic/${id}.classic.json`;
        try {
          const r = await fetch(url, { cache: 'no-store' });
          if (!r.ok) return;
          const doc = await r.json();
          if (doc.name != null) base.name = doc.name;
          if (doc.tag != null) base.tag = doc.tag;
          if (doc.car != null) base.car = doc.car;
          if (doc.accent != null) base.accent = doc.accent;
          if (doc.samplePack != null) base.samplePack = doc.samplePack;
          if (doc.engine && typeof doc.engine === 'object') {
            base.engine = { ...base.engine, ...doc.engine };
          }
          if (doc.tone && typeof doc.tone === 'object') {
            base.tone = { ...base.tone, ...doc.tone };
            if (Array.isArray(doc.tone.harmonics)) {
              base.tone.harmonics = doc.tone.harmonics.slice();
            }
          }
          if (doc.mix && typeof doc.mix === 'object') {
            base.mix = { ...(base.mix || {}), ...doc.mix };
          }
          n += 1;
        } catch (_) {}
      })
    );
    _classicLoaded = true;
    return n;
  } catch {
    return 0;
  }
}

/** Force re-fetch classic JSON on next loadClassicStandards (e.g. after CommandRoom save). */
export function invalidateClassicStandards() {
  _classicLoaded = false;
}

/** Profiles shown in the carousel. */
export function getVisibleProfiles() {
  const order = getLiveProfileIds();
  const set = new Set(order);
  const list = SOUND_PROFILES.filter((p) => set.has(p.id));
  list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return list.length ? list : SOUND_PROFILES.filter((p) => SHIP_ACTIVE_IDS.includes(p.id));
}

export function getAllProfiles() {
  return SOUND_PROFILES.slice();
}

