// Offline cache for the app shell, so the dash starts without mobile data.
// Bump VERSION whenever files change so phones pick up the update.
const VERSION = 'emoto-dash-v1';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/dash.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/main.js',
  'js/settings.js',
  'js/store.js',
  'js/protocol/fardriver.js',
  'js/sources/fardriver-ble.js',
  'js/sources/demo.js',
  'js/sources/bms.js',
  'js/ui/dash.js',
  'js/ui/gauge.js',
  'js/ui/panels.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates arrive when online), cache as the offline fallback.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
