// The DMM recording's copy in IndexedDB: the only module that touches it. Storage mirrors `dmmRec`
// (an empty recording clears it), so no other code calls in here except Restore and Discard. One tab
// owns it (Web Lock); a failure only changes `saveState`, the recording in memory never depends on it.
import type { DmmStats } from '../dsp';
import { flushPlan, type SavedChunk } from '../recording';
import type { State } from '../store';
import { errText, fail, get, set } from './core';
import { dmmRec } from './dmm';

const DB = 'openosc-panel', SCHEMA = 1, FLUSH_MS = 5000, LOCK = 'openosc-panel:dmm-recording';
type Meta = { schema: number; recorded: NonNullable<State['recorded']>; dstats: DmmStats; length: number; valid: number; last: number };

let db: IDBDatabase | null = null;
let mark = { gen: dmmRec.gen, length: 0 }; // what storage holds; length 0 = nothing
let writing = false;
let releaseLock: (() => void) | null = null;
let timer = 0;

const off = (why: 'unavailable' | 'full' | 'other-tab' | 'failed') => set({ saveState: { kind: 'off', why } });
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
});

function openDb() {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('chunks'); r.result.createObjectStore('meta'); };
  return request(r);
}

// Held for the page's lifetime; false when another tab has it.
function holdLock(): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      return lock ? new Promise<void>((r) => { releaseLock = r; }) : undefined;
    }).catch(reject);
  });
}

// One transaction from one moment: the chunk slices and the statistics are read before any await.
function flush() {
  if (!db || writing || get().savedOffer) return;
  const plan = flushPlan(mark, dmmRec);
  if (!plan) return;
  const tx = db.transaction(['chunks', 'meta'], 'readwrite');
  const chunks = tx.objectStore('chunks'), meta = tx.objectStore('meta');
  if (plan.clear) { chunks.clear(); meta.clear(); }
  if (plan.from !== null) {
    for (let k = plan.from; k < dmmRec.chunkCount; k++) chunks.put(dmmRec.chunk(k), k);
    const { recorded, dstats } = get();
    // `recorded` is set by every recorded value, and a plan with chunks has some.
    meta.put({ schema: SCHEMA, recorded: recorded!, dstats, length: dmmRec.length, valid: dmmRec.valid, last: dmmRec.t(dmmRec.length - 1) } satisfies Meta, 'rec');
  }
  const next = { gen: dmmRec.gen, length: plan.from === null ? 0 : dmmRec.length };
  writing = true;
  done(tx).then(
    () => { mark = next; set({ saveState: plan.from === null ? { kind: 'idle' } : { kind: 'saved', at: Date.now() } }); },
    (e: unknown) => off(e instanceof DOMException && e.name === 'QuotaExceededError' ? 'full' : 'failed'), // retried next tick
  ).finally(() => { writing = false; });
}

const onHide = () => { if (document.visibilityState === 'hidden') flush(); };

async function start() {
  if (typeof indexedDB === 'undefined') return off('unavailable');
  if (!(await holdLock())) return off('other-tab');
  try {
    db = await openDb();
    const m = await request<Meta | undefined>(db.transaction('meta').objectStore('meta').get('rec'));
    mark = { gen: dmmRec.gen, length: m?.length ?? 0 };
    if (m && m.valid > 0) set({ savedOffer: { func: m.recorded.func, fahrenheit: m.recorded.fahrenheit, valid: m.valid, last: m.last, known: m.schema === SCHEMA } });
  } catch {
    db = null;
    return off('unavailable');
  }
  timer = window.setInterval(flush, FLUSH_MS);
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onHide);
}

export async function restoreSaved() {
  if (!db || !get().savedOffer?.known) return;
  try {
    const tx = db.transaction(['chunks', 'meta']);
    const [m, chunks] = await Promise.all([
      request<Meta | undefined>(tx.objectStore('meta').get('rec')),
      request<SavedChunk[]>(tx.objectStore('chunks').getAll()), // key order = chunk order
    ]);
    if (!m || chunks.reduce((n, c) => n + c.t.length, 0) !== m.length) return fail('The saved recording is incomplete and cannot be restored. Discard it to start a new one.');
    dmmRec.load(chunks);
    mark = { gen: dmmRec.gen, length: dmmRec.length };
    // A crashed page never stopped logging: without this break a resume would draw across the crash.
    dmmRec.gap(dmmRec.t(dmmRec.length - 1));
    set({ recorded: m.recorded, dstats: m.dstats, logged: dmmRec.valid, recRev: get().recRev + 1, logging: false, savedOffer: null });
  } catch (e) {
    fail(`Restore failed: ${errText(e)}`);
  }
}

export async function discardSaved() {
  if (!db) return;
  try {
    const tx = db.transaction(['chunks', 'meta'], 'readwrite');
    tx.objectStore('chunks').clear();
    tx.objectStore('meta').clear();
    await done(tx);
    mark = { gen: dmmRec.gen, length: 0 };
    set({ savedOffer: null });
  } catch (e) {
    fail(`Discard failed: ${errText(e)}`);
  }
}

void start();

// Vite hot reload runs this module again: the old copy must let go of the lock, or the page would
// report itself as another tab.
import.meta.hot?.dispose(() => {
  clearInterval(timer);
  removeEventListener('pagehide', flush);
  document.removeEventListener('visibilitychange', onHide);
  db?.close();
  releaseLock?.();
});
