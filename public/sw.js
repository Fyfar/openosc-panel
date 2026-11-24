// Network first, cache as offline fallback. The page (src/pwa.ts) fills the cache.
// No skipWaiting/clients.claim and never a reload from here: an open window keeps the version it
// loaded (and its unsaved DMM log / Bode result) until the user reloads or closes it.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).catch(async () =>
      (await caches.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' && (await caches.match(new URL('./', location.href)))) ||
      Response.error(),
    ),
  );
});
