// Offline cache for the app shell, so the dash starts without mobile data.
// Bump VERSION whenever files change so phones pick up the update.
const VERSION = 'emoto-dash-v0.6.1';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/dash.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/main.js',
  'js/link-log.js',
  'js/version.js',
  'js/settings.js',
  'js/store.js',
  'js/protocol/fardriver.js',
  'js/sources/fardriver-ble.js',
  'js/sources/fardriver-native.js',
  'js/sources/demo.js',
  'js/sources/bms.js',
  'js/ui/dash.js',
  'js/ui/gauge.js',
  'js/ui/panels.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the browser's HTTP cache, so a new version never stores old files.
  const requests = FILES.map((f) => new Request(f, { cache: 'reload' }));
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates arrive when online), cache as the offline fallback.
// GitHub Pages lets browsers reuse files for 10 minutes; 'no-cache' makes every request check
// with the server, otherwise a fresh index.html could load alongside stale scripts.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req.url, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.url, { ignoreSearch: true })),
  );
});
