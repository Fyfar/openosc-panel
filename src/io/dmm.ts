// Multimeter: config read/write, reading poll loop, history and CSV log.
import { DMM_FUNCS, dmmBase, dmmScale, HOLD_MODES, type DmmFunc } from '../device';
import { addStat, emptyStats } from '../dsp';
import { sleep } from '../link';
import { Recording, REC_MAX } from '../recording';
import type { State } from '../store';
import { alive, ctl, download, get, link, now, num, on, remote, set } from './core';

type Dmm = State['dmm'];

const CONF: Record<DmmFunc, string> = {
  VDC: 'CONF:VOLT:DC', VAC: 'CONF:VOLT:AC', MVDC: 'CONF:MVOL:DC', MVAC: 'CONF:MVOL:AC',
  ADC: 'CONF:CURR:DC', AAC: 'CONF:CURR:AC', MADC: 'CONF:MCUR:DC', MAAC: 'CONF:MCUR:AC',
  RES: 'CONF:RES', CONT: 'CONF:CONT', DIOD: 'CONF:DIOD', CAP: 'CONF:CAP', TEMP: 'CONF:TEMP',
};

export function dmmDiff(a: Dmm, b: Dmm): string[] {
  const c: string[] = [];
  if (a.func !== b.func) return [CONF[b.func]]; // a function change resets range/hold/rel on the device
  if (a.auto !== b.auto) c.push(`AUTO ${b.auto ? 'ON' : 'OFF'}`);
  if (!b.auto && (a.range !== b.range || a.auto !== b.auto)) c.push(`RANGe ${b.range + 1}`);
  if (a.holdMode !== b.holdMode) c.push(`SYST:DMM:HOLD:MODE ${b.holdMode}`);
  if (a.hold !== b.hold) c.push(`SYST:DMM:HOLD ${b.hold ? 'ON' : 'OFF'}`);
  if (a.rel !== b.rel) c.push(`SYST:DMM:REL ${b.rel ? 'ON' : 'OFF'}`);
  // A value selects the Manual junction. Never NONE: that leaves Type K for DC mV, and the MCU
  // junction has no SCPI (meter menu only), so `null` just means "not set from here".
  if (b.cj !== null && a.cj !== b.cj) c.push(`SYST:DMM:TEMP:CJUN ${b.cj}`);
  return c;
}

// dmm::Function, field 0 of SYST:DMM:RES?, in the firmware's order. 13 (Unknown) is none of these.
const BY_ID: DmmFunc[] = ['VDC', 'VAC', 'RES', 'CONT', 'DIOD', 'CAP', 'ADC', 'AAC', 'MVDC', 'MVAC', 'MADC', 'MAAC', 'TEMP'];

let discardNext = false;
let lastFunc = '';
// Outlives the loop: a view change restarts it, and the reading it finds must not be recorded again.
let lastSeq = NaN;
// The recording: chart, statistics and CSV all read it. The store only sees `recRev` move.
export const dmmRec = new Recording();
const UNIT_Q = 'SYST:DMM:TEMP:UNIT?';

export async function flushDmm(a: Dmm, b: Dmm) {
  const c = dmmDiff(a, b);
  if (!c.length) return;
  const conf = c[0].startsWith('CONF');
  const ok = await ctl(c, conf ? 12000 : 3000); // CONF waits for the meter chip, up to 8 s
  if (!conf) return;
  // Only an accepted CONF changes the function: a refused one leaves the old readings valid. Set after
  // the reply, so a RES? already in flight can't consume discardNext (Link answers batches in order).
  if (ok) { discardNext = true; clearReading(); }
  // Type K is refused (-221) while no cold junction is configured (DataAccess::selectDmmFunction). With a
  // manual junction stored, -221 means something else (busy).
  set({ junctionNeeded: b.func === 'TEMP' && !ok && b.cj === null });
  await readDmmCfg(true).catch(() => {}); // the loop's FUNC? poll catches up
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
  // FUNC2 FREQ: SYST:DMM:RES? reports the secondary (AC Hz) only after it; the flag is off at boot.
  // *CLS: CJUN? queues -230 when no junction is stored; don't leave it for the console to report.
  const [func, list, auto, hold, rel, hmode, cjun, unit] = await link.texts(['FUNC2 FREQ', 'FUNC?', 'SYST:DMM:RANG:LIST?', 'AUTO?', 'SYST:DMM:HOLD?', 'SYST:DMM:REL?', 'SYST:DMM:HOLD:MODE?', 'SYST:DMM:TEMP:CJUN?', UNIT_Q, '*CLS']);
  const ranges = list.split(',').slice(1).map(Number).filter(Number.isFinite);
  const f = funcFromDevice(func, ranges);
  const fahrenheit = unit === 'F';
  if ((func !== lastFunc && lastFunc) || (f === 'TEMP' && fahrenheit !== get().fahrenheit)) clearReading();
  lastFunc = func;
  set({ ranges, fahrenheit });
  const holdMode = HOLD_MODES.find((h) => hmode.toUpperCase().startsWith(h));
  const cj = num(cjun); // the stored manual junction; NAN (-230) when none is set
  remote('dmm', { ...(f ? { func: f } : {}), ...(holdMode ? { holdMode } : {}), auto: on(auto), hold: on(hold), rel: on(rel), cj: Number.isFinite(cj) ? cj : null }, force);
}

type Poll = { func?: string; n: number; winT: number; cfgDue: number };

export async function dmmLoop(id: number) {
  const p: Poll = { n: 0, winT: now(), cfgDue: 0 };
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
    if (+f[9] !== lastSeq) await take(p, f);
    // Range index is 1-based, 0 = unknown (scpi/meter.cpp): keep the last known one then.
    remote('dmm', { ...(f[6] !== '-1' ? { auto: f[6] === '1' } : {}), ...(+f[5] > 0 ? { range: +f[5] - 1 } : {}), hold: f[7] === '1', rel: f[8] === '1' });
  }
  if (now() > p.cfgDue) {
    p.cfgDue = now() + 1500;
    await readDeviceSide();
  }
}

// A reading not seen before.
async function take(p: Poll, f: string[]) {
  lastSeq = +f[9];
  p.n++;
  // FUNC? says VOLT for V and mV alike (CURR for A and mA): the reading's id shows a change on the
  // meter's keys. Read the new ranges before the reading is used.
  if (p.func !== undefined && p.func !== f[0]) await readDmmCfg(true);
  p.func = f[0];
  // The first reading after CONF is a settling placeholder (read 0 in 3 of 3 tests).
  if (discardNext) discardNext = false;
  else pushReading(f);
}

// What the device can change by itself: the function on its keys, the temperature unit in its menu,
// Remote ending (MENU hold) or starting from its menu.
async function readDeviceSide() {
  const temp = get().dmm.func === 'TEMP';
  const [func, rem, unit] = await link.texts(['FUNC?', 'SYST:REM?', ...(temp ? [UNIT_Q] : [])]);
  if (rem !== 'NAN' && on(rem) !== get().remote) set({ remote: on(rem) });
  if (func !== lastFunc || (temp && (unit === 'F') !== get().fahrenheit)) await readDmmCfg(true);
}

// One SYST:DMM:RES? reply in the shown unit.
function readingOf(f: string[], fahrenheit: boolean): NonNullable<State['reading']> {
  const raw = num(f[1]), status = +f[2], sec = num(f[3]);
  // Overload is NAN with status 6; 1E+9 is the sentinel of MEAS?.
  const over = status === 6 || raw >= 9e8;
  const blank = !over && (status === 14 || !Number.isFinite(raw));
  // Temperature (function 12) is always °C here, the meter converts only its screen. Under REL it is
  // a difference: no +32.
  const shown = fahrenheit && f[0] === '12' ? raw * 1.8 + (f[8] === '1' ? 0 : 32) : raw;
  return { v: over || blank ? null : shown, over, blank, sec: Number.isFinite(sec) && sec !== 0 ? sec : null, seq: +f[9] };
}

function pushReading(f: string[]) {
  const reading = readingOf(f, get().fahrenheit);
  set({ reading });
  const func = BY_ID[+f[0]];
  if (func && get().logging) record(func, reading.v, +f[5]);
}

// Whether a reading of this function and temperature unit belongs with the recorded data.
export const logMatches = (r: State['recorded'], func: DmmFunc, fahrenheit: boolean) =>
  !r || (r.func === func && (func !== 'TEMP' || r.fahrenheit === fahrenheit));

// A recording holds one function and unit: a reading of any other ends it. `v` null = OL or blank.
function record(func: DmmFunc, v: number | null, range: number) {
  const { recorded, fahrenheit, ranges, dmm, recRev, dstats } = get();
  if (!logMatches(recorded, func, fahrenheit)) return stopDmmLog();
  // This reading's own range (the store's is from the previous poll): one stale coarse LSD would
  // coarsen the histogram for the whole recording.
  const rangeMax = ranges[range > 0 ? range - 1 : dmm.range];
  if (v === null) {
    set({ recorded: recorded ?? { func, fahrenheit, rangeMax } });
    return breakLine();
  }
  dmmRec.push(Date.now() / 1000, v);
  set({
    recorded: { func, fahrenheit, rangeMax },
    recRev: recRev + 1,
    dstats: addStat(dstats, v, dmmScale(func, rangeMax).lsd),
    logged: dmmRec.valid,
  });
  if (dmmRec.valid >= REC_MAX) stopDmmLog();
}

// One gap per run of OL, blank or paused (the chart draws the held step to it).
function breakLine() {
  if (dmmRec.gap(Date.now() / 1000)) set({ recRev: get().recRev + 1 });
}

function clearReading() {
  set({ reading: null, junctionNeeded: false });
}

export const atLimit = (s: State) => s.logged >= REC_MAX;

let persistAsked = false;

// Refused at the limit, and while a saved recording is offered: a new one would overwrite it.
export function startDmmLog() {
  if (atLimit(get()) || get().savedOffer) return;
  // Asked on a click: Firefox shows a prompt for it. A refusal changes nothing else.
  if (!persistAsked) { persistAsked = true; navigator.storage?.persist?.().catch(() => {}); }
  set({ logging: true, ...(get().logged ? {} : { recorded: null }) });
}

export function stopDmmLog() {
  if (!get().logging) return;
  breakLine();
  set({ logging: false });
}

export async function clearDmmData() {
  dmmRec.clear();
  set({ logged: 0, recorded: null, recRev: get().recRev + 1, dstats: emptyStats() });
  await ctl(['SYST:DMM:STAT:RES']);
}

// A recording holds one function and unit (`record`), so every row carries the same two.
export function dmmCsvParts(): string[] {
  const r = get().recorded;
  if (!r) return dmmRec.csvParts('', '');
  return dmmRec.csvParts(DMM_FUNCS.find((x) => x.id === r.func)!.label, dmmBase(r.func, r.fahrenheit));
}

export function exportDmmLog() {
  download(`dmm-${Date.now()}.csv`, new Blob(dmmCsvParts(), { type: 'text/csv' }));
}
