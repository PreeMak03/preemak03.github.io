/**
 * Tesla Active Sound � offline cache
 * Precache the app shell; stale-while-revalidate on every GET so the app
 * opens instantly in the car even on dead LTE, while still picking up
 * deployed updates in the background.
 */

// Bump when ship assets change so cars drop stale offline shells
const CACHE = 'tas-v92';

const ASSETS = [
  './',
  './index.html',
  './404.html',
  './favicon.svg',
  './css/main.css',
  './css/animations.css',
  './js/app.js',
  './js/ui.js',
  './js/audio-engine.js',
  './js/dynamic-volume.js',
  './js/classic-profile.js',
  './js/gearbox.js',
  './js/profiles.js',
  './js/animations.js',
  './js/vehicle-physics.js',
  './js/geolocation.js',
  './js/sample-pack.js',
  './js/onboarding.js',
  './js/vessel-audio.js',
  './js/vessel-rigs.js',
  './js/turbine-audio.js',
  './js/turbine-rigs.js',
  './assets/turbine/jet.turbine.json',
  './js/dev-perf.js',
  './js/dev-trace.js',
  './js/manual-shift.js',
  './js/dev-profile.js',
  './js/crank-audio.js',
  './js/crank-rigs.js',
  './js/launch-rev.js',
  './js/vessel-runtime.worklet.js',
  './js/engine-waveguide.worklet.js',
  './assets/vessel/camaro.rig.json',
  './assets/vessel/rotary.rig.json',
  './assets/vessel/american.rig.json',
  './assets/vessel/gentle.rig.json',
  './assets/vessel/live-set.json',
  './assets/crank/jz.crank.json',
  './assets/crank/civic.crank.json',
  './assets/classic/registry.json',
  // vessel/command-room/* is Lab-only — never precache
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first (with a short timeout) for our OWN files, so a fresh deploy shows
// up immediately when online � falling back to cache on dead/slow LTE so the app
// still opens instantly offline. Cross-origin (fonts) stays cache-first.
const NET_TIMEOUT = 2500;

function putCache(req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    const clone = res.clone();
    caches.open(CACHE).then((c) => c.put(req, clone));
  }
}
function offlineFallback(req) {
  return caches.match(req).then((c) => c || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;

  if (sameOrigin) {
    // network-first with timeout ? cache fallback
    e.respondWith(
      new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          caches.match(req).then((c) => { if (c && !settled) { settled = true; resolve(c); } });
        }, NET_TIMEOUT);
        fetch(req)
          .then((res) => { if (settled) { putCache(req, res); return; } settled = true; clearTimeout(timer); putCache(req, res); resolve(res); })
          .catch(() => { if (settled) return; settled = true; clearTimeout(timer); offlineFallback(req).then((c) => resolve(c || Response.error())); });
      })
    );
    return;
  }

  // cross-origin (fonts, etc.): cache-first, revalidate in background
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => { putCache(req, res); return res; }).catch(() => cached);
      return cached || network;
    })
  );
});