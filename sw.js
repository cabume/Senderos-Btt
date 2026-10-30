// Senderos BTT: guarda la app para que abra sin cobertura. Mapas y senderos van aparte, en IndexedDB.
const CACHE = 'senderos-v8';
const FILES = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-180.png', 'lib/leaflet.js', 'lib/leaflet.css'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // mapas, senderos y rutas: directo
  const key = req.mode === 'navigate' ? 'index.html' : req;
  // Primero la red (así llegan las mejoras); sin cobertura, lo guardado
  e.respondWith(fetch(req).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  }).catch(() => caches.match(key, { ignoreSearch: true })));
});
