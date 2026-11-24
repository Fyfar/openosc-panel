// Multimeter: config read/write, reading poll loop, history and CSV log.
import { DMM_FUNCS, HOLD_MODES, type DmmFunc } from '../device';
import { sleep } from '../link';
import type { State } from '../store';
import { alive, ctl, download, get, link, now, num, on, remote, set } from './core';

type Dmm = State['dmm'];

const CONF: Record<DmmFunc, string> = {
  VDC: 'CONF:VOLT:DC', VAC: 'CONF:VOLT:AC', MVDC: 'CONF:MVOL:DC', MVAC: 'CONF:MVOL:AC',
  ADC: 'CONF:CURR:DC', AAC: 'CONF:CURR:AC', MADC: 'CONF:MCUR:DC', MAAC: 'CONF:MCUR:AC',
  RES: 'CONF:RES', CONT: 'CONF:CONT', DIOD: 'CONF:DIOD', CAP: 'CONF:CAP', TEMP: 'CONF:TEMP',
};

function dmmDiff(a: Dmm, b: Dmm): string[] {
  const c: string[] = [];
  if (a.func !== b.func) return [CONF[b.func]]; // a function change resets range/hold/rel on the device
  if (a.auto !== b.auto) c.push(`AUTO ${b.auto ? 'ON' : 'OFF'}`);
  if (!b.auto && (a.range !== b.range || a.auto !== b.auto)) c.push(`RANGe ${b.range + 1}`);
  if (a.holdMode !== b.holdMode) c.push(`SYST:DMM:HOLD:MODE ${b.holdMode}`);
  if (a.hold !== b.hold) c.push(`SYST:DMM:HOLD ${b.hold ? 'ON' : 'OFF'}`);
  if (a.rel !== b.rel) c.push(`SYST:DMM:REL ${b.rel ? 'ON' : 'OFF'}`);
  if (a.cj !== b.cj) c.push(`SYST:DMM:TEMP:CJUN ${b.cj ?? 'NONE'}`);
  return c;
}

let discardNext = false;
let lastFunc = '';
const dmmLog: [t: number, func: DmmFunc, v: number][] = [];

export async function flushDmm(a: Dmm, b: Dmm) {
  const c = dmmDiff(a, b);
  if (!c.length) return;
  const conf = c[0].startsWith('CONF');
  if (conf) { discardNext = true; set({ hist: { t: [], v: [] }, reading: null }); }
  await ctl(c, conf ? 12000 : 3000); // CONF waits for the meter chip, up to 8 s
  if (conf) await readDmmCfg(true).catch(() => {}); // the loop's FUNC? poll catches up
}

function funcFromDevice(s: string, ranges: number[]): DmmFunc | null {
  const f = s.replace(/"/g, '').trim().toUpperCase();
  const small = ranges.length > 0 && Math.max(...ranges) < 1; // mV / mA report as VOLT / CURR
  const map: Record<string, DmmFunc> = {
    VOLT: small ? 'MVDC' : 'VDC', 'VOLT AC': small ? 'MVAC' : 'VAC',
    CURR: small ? 'MADC' : 'ADC', 'CURR AC': small ? 'MAAC' : 'AAC',
    RES: 'RES', CONT: 'CONT', DIOD: 'DIOD', CAP: 'CAP', TEMP: 'TEMP',
  };
  return map[f] ?? null;
}

async function readDmmCfg(force = false) {
  const [func, list, auto, hold, rel, hmode] = await link.texts(['FUNC?', 'SYST:DMM:RANG:LIST?', 'AUTO?', 'SYST:DMM:HOLD?', 'SYST:DMM:REL?', 'SYST:DMM:HOLD:MODE?']);
  const ranges = list.split(',').slice(1).map(Number).filter(Number.isFinite);
  const f = funcFromDevice(func, ranges);
  if (func !== lastFunc && lastFunc) set({ hist: { t: [], v: [] }, reading: null });
  lastFunc = func;
  set({ ranges });
  const holdMode = HOLD_MODES.find((h) => hmode.toUpperCase().startsWith(h));
  remote('dmm', { ...(f ? { func: f } : {}), ...(holdMode ? { holdMode } : {}), auto: on(auto), hold: on(hold), rel: on(rel) }, force);
}

type Poll = { lastSeq: number; n: number; winT: number; cfgDue: number };

export async function dmmLoop(id: number) {
  const p: Poll = { lastSeq: NaN, n: 0, winT: now(), cfgDue: 0 };
  while (alive(id)) {
    try {
      await poll(p);
    } catch {
      if (link.closed) break;
      p.cfgDue = 0; // a query timed out (Link has resynced): re-read the config, keep polling
    }
    if (now() - p.winT > 2000) {
      set({ stats: `CDC · ${((p.n * 1000) / (now() - p.winT)).toFixed(1)} readings/s · errors ${get().errors}` });
      p.n = 0; p.winT = now();
    }
    await sleep(100); // DMM queries cost ~0.5 ms; the meter chip gives ~3 readings/s
  }
}

async function poll(p: Poll) {
  if (!p.cfgDue) { await readDmmCfg(true); p.cfgDue = now() + 1500; }
  // SYST:DMM:RES?: func id, value, status, sec value, sec qty, range idx, range mode, HOLD, REL, seq, ts
  const f = (await link.q('SYST:DMM:RES?')).split(',');
  if (f.length >= 10) {
    if (+f[9] !== p.lastSeq) {
      p.lastSeq = +f[9];
      p.n++;
      // The first reading after CONF is a settling placeholder (read 0 in 3 of 3 tests).
      if (discardNext) discardNext = false;
      else pushReading(f);
    }
    // ponytail: range index assumed 1-based like RANGe; verify against the device display.
    remote('dmm', { ...(f[6] !== '-1' ? { auto: f[6] === '1' } : {}), range: Math.max(0, +f[5] - 1), hold: f[7] === '1', rel: f[8] === '1' });
  }
  if (now() > p.cfgDue) {
    p.cfgDue = now() + 1500;
    if ((await link.q('FUNC?')) !== lastFunc) await readDmmCfg(true); // changed on the device keys
  }
}

function pushReading(f: string[]) {
  const v = num(f[1]), status = +f[2], sec = num(f[3]);
  const over = v >= 9e8; // OWON overload sentinel 1E+9
  const blank = status === 14 || !Number.isFinite(v);
  set({ reading: { v: over || blank ? null : v, over, blank, sec: Number.isFinite(sec) && sec !== 0 ? sec : null, seq: +f[9] } });
  if (over || blank) return;
  const t = Date.now() / 1000, h = get().hist;
  set({ hist: { t: [...h.t, t].slice(-20000), v: [...h.v, v].slice(-20000) } });
  if (get().logging) { dmmLog.push([t, get().dmm.func, v]); set({ logged: dmmLog.length }); }
}

export async function resetDmmStats() {
  set({ hist: { t: [], v: [] } });
  await ctl(['SYST:DMM:STAT:RES']);
}

// One row per reading with its own function and unit: a log can span function changes.
export function dmmLogCsv(): string {
  const rows = dmmLog.map(([t, func, v]) => {
    const f = DMM_FUNCS.find((x) => x.id === func)!;
    return `${new Date(t * 1000).toISOString()},${f.label},${v},${f.base}`;
  });
  return `time,function,value,unit\n${rows.join('\n')}\n`;
}

export function exportDmmLog() {
  download(`dmm-${Date.now()}.csv`, new Blob([dmmLogCsv()], { type: 'text/csv' }));
}

export function clearDmmLog() {
  dmmLog.length = 0;
  set({ logged: 0 });
}
