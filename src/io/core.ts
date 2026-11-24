// Shared I/O plumbing: the one Link, command batches with error check, device → store
// without echo, and loop control. Instrument modules build on this; index.ts wires them up.
import { Link } from '../link';
import { useDev, type State } from '../store';

export const link = new Link();
export const get = useDev.getState;
export const set = (p: Partial<State>) => useDev.setState(p);
export const now = () => performance.now();
export const num = (s: string) => parseFloat(s);
export const on = (s: string) => s === '1' || s.toUpperCase() === 'ON';
export const finite = (x: string, fallback: number) => (Number.isFinite(num(x)) ? num(x) : fallback);
export const nearest = (list: number[], v: number) => list.reduce((b, x) => (Math.abs(Math.log(x / v)) < Math.abs(Math.log(b / v)) ? x : b), list[0]);
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let errTimer: ReturnType<typeof setTimeout> | undefined;
export function fail(msg: string) {
  console.warn('[openosc]', msg);
  set({ error: msg, errors: get().errors + 1 });
  clearTimeout(errTimer);
  errTimer = setTimeout(() => set({ error: null }), 8000);
}

// Command batch wrapped in *CLS … SYST:ERR? so failures surface. Returns false on error.
// Generator commands are each followed by *OPC?: on the ZT706S every one waits ~0.6 s for the
// module's acknowledge (up to 6 s), and the firmware queues only 4 parsed commands.
const isGen = (c: string) => /^(SOUR|OUTP)/i.test(c) && !c.includes('?');
export async function ctl(cmds: string[], timeout = 3000): Promise<boolean> {
  if (link.closed) return false;
  if (cmds.some(isGen)) timeout = Math.max(timeout, 8000);
  try {
    const out = await link.texts(['*CLS', ...cmds.flatMap((c) => (isGen(c) ? [c, '*OPC?'] : [c])), 'SYST:ERR?'], timeout);
    const err = out.at(-1)!;
    if (!err.startsWith('0,')) { fail(`${cmds.join('; ')} → ${err}`); return false; }
    return true;
  } catch (e) {
    if (!link.closed) fail(`${cmds.join('; ')} failed: ${errText(e)}`);
    return false;
  }
}

// ---- sync bookkeeping (the store subscription that sends edits lives in index.ts)
export type Key = 'scope' | 'dmm' | 'gen';
export const lastSent: Partial<Pick<State, Key>> = {};
export const localAt: Record<Key, number> = { scope: 0, dmm: 0, gen: 0 };
export let applying = false;

// Device → store without echoing back as commands. Skipped right after a local edit so a
// slow readback doesn't yank a slider the user is still dragging (unless forced).
export function remote<K extends Key>(k: K, p: Partial<State[K]>, force = false) {
  if (!force && now() - localAt[k] < 1200) return;
  applying = true;
  get().patch(k, p);
  lastSent[k] = get()[k] as never;
  applying = false;
}

// ---- loops: one at a time; a loop body runs while alive(id)
let loopId = 0;
let loopP: Promise<void> = Promise.resolve();
export const alive = (id: number) => id === loopId && !link.closed;
export const current = (id: number) => id === loopId;

export function runLoop(name: string, body: (id: number) => Promise<void>) {
  const id = ++loopId;
  loopP = body(id).catch((e) => { if (!link.closed) fail(`${name} loop stopped: ${errText(e)}`); });
}

// Ends the running loop and waits for its `finally` (the scope releases its held frame).
// Returns a token: current(token) stays true until something else stops or starts a loop.
export async function stopLoop(): Promise<number> {
  const id = ++loopId;
  await loopP;
  return id;
}

export function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
