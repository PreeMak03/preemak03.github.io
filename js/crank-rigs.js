/**
 * CRANK profile id map only — safe to import from app.js without loading the
 * CrankAudio engine (same trick as vessel-rigs.js).
 * Keep in sync with vessel/tools/build-crank.mjs output and assets/crank/*.
 */
export const CRANK_RIGS = {
  'jz-crank': 'assets/crank/jz.crank.json',
  'civic-crank': 'assets/crank/civic.crank.json',
};

export function hasCrank(id) {
  return !!CRANK_RIGS[id];
}

export function listCrankRigs() {
  return { ...CRANK_RIGS };
}
