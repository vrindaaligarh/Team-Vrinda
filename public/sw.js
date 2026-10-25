// Keeps the app opening while the server restarts for an update (Render shows a 502 page for 1-2 minutes).
const CACHE = 'bill-tracker-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.add('/'))); });
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return r; }
    return r.status >= 500 ? caches.match('/').then((m) => m || r) : r;
  }).catch(() => caches.match('/')));
});
