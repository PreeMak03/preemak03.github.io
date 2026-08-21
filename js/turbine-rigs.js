/**
 * TURBINE profile id map only — safe to import from app.js without loading the
 * TurbineAudio engine (same trick as vessel-rigs.js / crank-rigs.js).
 */
export const TURBINE_RIGS = {
  'turbine-jet': 'assets/turbine/jet.turbine.json',
  'turbine-ufo': 'assets/turbine/ufo.turbine.json',
  'turbine-supersonic': 'assets/turbine/supersonic.turbine.json',
};

export function hasTurbine(id) {
  return !!TURBINE_RIGS[id];
}

export function listTurbineRigs() {
  return { ...TURBINE_RIGS };
}
