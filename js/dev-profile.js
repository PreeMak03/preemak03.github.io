/**
 * Per-module main-thread profiler. Dev only, off unless asked for.
 *
 * WHY
 *   The car is sometimes smooth and sometimes not, with no pattern that looks
 *   like a steady overload. That shape — intermittent, load-dependent — is what
 *   a main thread occasionally missing its deadline looks like, and until now
 *   there was no way to say WHICH work was doing it. dev-perf reports fps and
 *   stalls; this says who spent the time.
 *
 * HOW
 *   Everything periodic in this app arrives through requestAnimationFrame or
 *   setInterval, so those two are wrapped for the duration of a run rather than
 *   every module being edited to time itself. The scheduler is asked WHO
 *   registered each callback — one stack capture at registration — and the time
 *   its callback spends is billed there.
 *
 *   That is worth knowing about: a stack capture is not free, so this is not
 *   something to leave running. Start it, drive, read it, stop it.
 *
 * READING IT
 *   msPerSec is time on the main thread per second of wall clock, so it IS the
 *   percentage of one core. Anything approaching 100 has no room left, and on a
 *   car's MCU the audio thread is competing with all of it.
 *
 *   TAS.profile.start();  ... drive ...  TAS.profile.report();  TAS.profile.stop();
 *   TAS.profile.run(10)   // start, wait ten seconds, report, stop
 */

const NAMES = [
  [/crank-audio/, 'crank-audio (engine tick)'],
  [/audio-engine/, 'audio-engine (classic tick)'],
  [/vessel-audio/, 'vessel-audio'],
  [/turbine-audio/, 'turbine-audio'],
  [/dev-trace/, 'dev-trace (recorder)'],
  [/dev-perf/, 'dev-perf (readout)'],
  [/dev-profile/, 'dev-profile (this)'],
  [/manual-shift/, 'manual-shift (pedal)'],
  [/\bui\.js/, 'ui.js'],
  [/app\.js/, 'app.js (frame loop)'],
  [/geolocation/, 'geolocation'],
  [/vehicle-physics/, 'vehicle-physics'],
];

/** First stack frame that is not this file — whoever asked for the callback. */
function siteOf(stack) {
  if (!stack) return 'unknown';
  const lines = String(stack).split('\n').slice(1);
  for (const ln of lines) {
    if (ln.includes('dev-profile.js')) continue;
    for (const [re, name] of NAMES) if (re.test(ln)) return name;
    const m = ln.match(/\/([\w.-]+\.js):(\d+)/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return 'unknown';
}

let live = null;

function bill(stats, site, ms) {
  let s = stats.get(site);
  if (!s) { s = { calls: 0, ms: 0, worst: 0 }; stats.set(site, s); }
  s.calls += 1;
  s.ms += ms;
  if (ms > s.worst) s.worst = ms;
}

export function start() {
  if (live) return 'already running';
  const stats = new Map();
  const startedAt = performance.now();
  const rafOrig = window.requestAnimationFrame.bind(window);
  const intOrig = window.setInterval.bind(window);
  const toOrig = window.setTimeout.bind(window);

  window.requestAnimationFrame = (cb) => {
    const site = siteOf(new Error().stack);
    return rafOrig((t) => {
      const t0 = performance.now();
      try { cb(t); } finally { bill(stats, site, performance.now() - t0); }
    });
  };
  window.setInterval = (cb, ms, ...rest) => {
    const site = siteOf(new Error().stack);
    return intOrig((...args) => {
      const t0 = performance.now();
      try { cb(...args); } finally { bill(stats, site, performance.now() - t0); }
    }, ms, ...rest);
  };
  window.setTimeout = (cb, ms, ...rest) => {
    if (typeof cb !== 'function') return toOrig(cb, ms, ...rest);
    const site = siteOf(new Error().stack);
    return toOrig((...args) => {
      const t0 = performance.now();
      try { cb(...args); } finally { bill(stats, site, performance.now() - t0); }
    }, ms, ...rest);
  };

  // The engine's tick is the one thing that MUST be measured and the one thing
  // wrapping the schedulers cannot catch: its setInterval was registered when
  // the engine started, long before this ran, so it never re-registers and
  // never gets wrapped. The first run of this reported four modules and none
  // of them was the engine. Wrap the method itself.
  const eng = window.TAS && window.TAS.audio;
  let engRestore = null;
  if (eng && typeof eng._tick === 'function') {
    const orig = eng._tick;
    const label = eng.constructor && eng.constructor.name === 'CrankAudio'
      ? 'crank-audio (engine tick)' : 'engine tick';
    eng._tick = function wrapped(...args) {
      const t0 = performance.now();
      try { return orig.apply(this, args); }
      finally { bill(stats, label, performance.now() - t0); }
    };
    engRestore = () => { eng._tick = orig; };
  }

  live = { stats, startedAt, rafOrig, intOrig, toOrig, engRestore };
  return 'profiling — note that anything already scheduled is not counted until it reschedules';
}

export function stop() {
  if (!live) return 'not running';
  window.requestAnimationFrame = live.rafOrig;
  window.setInterval = live.intOrig;
  window.setTimeout = live.toOrig;
  if (live.engRestore) { try { live.engRestore(); } catch (_) { /* engine swapped */ } }
  live = null;
  return 'stopped';
}

export function report() {
  if (!live) return 'not running — call TAS.profile.start() first';
  const secs = (performance.now() - live.startedAt) / 1000;
  const rows = [...live.stats.entries()]
    .map(([site, s]) => ({
      module: site,
      pctOfCore: +(s.ms / secs / 10).toFixed(1),   // ms per 1000 ms
      msPerSec: +(s.ms / secs).toFixed(2),
      callsPerSec: +(s.calls / secs).toFixed(1),
      worstCallMs: +s.worst.toFixed(2),
    }))
    .sort((a, b) => b.msPerSec - a.msPerSec);
  const total = rows.reduce((n, r) => n + r.msPerSec, 0);

  // Same trap the bench has: a page that is not rendering throttles
  // requestAnimationFrame to a crawl, and every rAF module then looks free
  // when it is not. Say so rather than hand over numbers that flatter.
  const rafRows = rows.filter((r) => /frame loop|pedal|readout|ui.js/.test(r.module));
  const rafRate = rafRows.length ? Math.max(...rafRows.map((r) => r.callsPerSec)) : 0;
  const throttled = rafRate > 0 && rafRate < 20;
  return {
    seconds: +secs.toFixed(1),
    warning: throttled
      ? `animation frames ran at ${rafRate}/s — this page was not rendering, so every`
        + ' frame-driven row here is understated. Run it with the app visible.'
      : null,
    totalPctOfCore: +(total / 10).toFixed(1),
    rows,
  };
}

/** Start, wait, report, stop — one call for someone who is about to drive. */
export async function run(seconds = 10) {
  start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const out = report();
  stop();
  return out;
}

export default { start, stop, report, run };
