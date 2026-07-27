/**
 * VESSEL rig id map only — safe to import from app.js without loading VesselAudio.
 * Keep in sync with vessel/tools/build-all.mjs manifest / assets/vessel/*.rig.json
 */
export const VESSEL_RIGS = {
  'camaro-vessel': 'assets/vessel/camaro.rig.json',
  'rotary-vessel': 'assets/vessel/rotary.rig.json',
  'american-vessel': 'assets/vessel/american.rig.json',
  'gentle-vessel': 'assets/vessel/gentle.rig.json',
};

export function hasRig(id) {
  return !!VESSEL_RIGS[id];
}

export function listVesselRigs() {
  return { ...VESSEL_RIGS };
}

export function isVesselProfileId(id) {
  return hasRig(id);
}
