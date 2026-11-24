// Installable + offline. sw.js only reads the cache; this keeps it equal to what the page just loaded,
// so superseded hashed assets are dropped on the next online visit.
import { unsavedData, useDev } from './store';

const CACHE = 'openosc-panel';

async function syncOfflineCache() {
  await navigator.serviceWorker.register('./sw.js');
  await document.fonts.ready;
  const urls = new Set([
    new URL('./', location.href).href,
    ...performance.getEntriesByType('resource').map((r) => r.name).filter((u) => u.startsWith(location.origin)),
  ]);
  const cache = await caches.open(CACHE);
  await cache.addAll([...urls]);
  for (const req of await cache.keys()) if (!urls.has(req.url)) await cache.delete(req);
}

// Every build has a new hashed entry script, so a different one in the live index.html = new deploy.
const entryOf = (doc: Document, base: string) => {
  const src = doc.querySelector('script[type="module"][src]')?.getAttribute('src');
  return src ? new URL(src, base).href : null;
};
let offered = entryOf(document, location.href); // "Later" = don't ask again for this build

async function checkForUpdate() {
  const res = await fetch('./', { cache: 'no-store' });
  if (!res.ok) return;
  const latest = entryOf(new DOMParser().parseFromString(await res.text(), 'text/html'), res.url);
  if (latest && latest !== offered) {
    offered = latest;
    useDev.getState().set({ update: true });
  }
}

// Dev server stays uncached and never offers updates; offline/failed checks keep the current copy.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => void syncOfflineCache().catch(() => {}));
  const check = () => void checkForUpdate().catch(() => {});
  setInterval(check, 30 * 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
}

// Updates only land on the next load, so the way to lose a log is a reload or close: ask first.
addEventListener('beforeunload', (e) => {
  if (unsavedData(useDev.getState())) e.preventDefault();
});
