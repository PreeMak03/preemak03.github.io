/**
 * Tesla Active Sound — offline cache
 * Precache the app shell; stale-while-revalidate on every GET so the app
 * opens instantly in the car even on dead LTE, while still picking up
 * deployed updates in the background.
 */

const CACHE = 'tas-v8';

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
  './js/gearbox.js',
  './js/profiles.js',
  './js/animations.js',
  './js/vehicle-physics.js',
  './js/geolocation.js',
  './js/sample-pack.js',
  './js/onboarding.js',
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

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          // Cache same-origin OK responses and opaque cross-origin (fonts)
          if (res && (res.ok || res.type === 'opaque')) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() =>
          // Offline: any navigation (incl. /tas or wrong-case paths) → the app
          cached || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined)
        );
      return cached || network;
    })
  );
});
