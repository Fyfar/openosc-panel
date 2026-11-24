// Oscilloscope: settings read/write, windowed frame fetch, the live loop, run control, CSV.
import { DESKTOP_FW, fwAtLeast, TIMEBASES, VDIV_MV } from '../device';
import type { Frame, Meas } from '../dsp';
import { sleep } from '../link';
import type { State } from '../store';
import { alive, ctl, download, errText, fail, get, link, nearest, now, num, on, remote, set } from './core';

type Scope = State['scope'];
type Status = State['scopeStatus'];

// meas: the device's own readouts per channel (WAV:MEAS?, firmware ≥ 0.21.9), null before that.
export const scopeData = { frames: [] as Frame[], meas: [null, null] as (Meas | null)[], version: 0 };
const LIVE_PTS = 1024; // ~screen width
const FFT_PTS = 2048; // the device's largest FFT; power of two
const MEAS_MS = 300;
// WAV:FRAM? waits for a fresh record and holds the link meanwhile; longer records use the
// per-channel path, whose waits end after 1 s, so a settings change never queues behind a record.
const FRAME_MAX_MS = 1000;
const desktop = () => fwAtLeast(get().idn?.fw, DESKTOP_FW);
const dec = new TextDecoder();
let cfgDue = 0; // reset to 0 to force a settings read on the next loop pass
let paused = 0;

function scopeDiff(a: Scope, b: Scope): string[] {
  const c: string[] = [];
  b.ch.forEach((B, i) => {
    const A = a.ch[i], n = `CHAN${i + 1}`, vd = (B.vdivMv * B.probe) / 1000;
    if (A.on !== B.on) c.push(`${n}:DISP ${B.on ? 'ON' : 'OFF'}`);
    if (A.coup !== B.coup) c.push(`${n}:COUP ${B.coup}`);
    if (A.probe !== B.probe) c.push(`${n}:PROB ${B.probe}`);
    const scal = A.vdivMv !== B.vdivMv || A.probe !== B.probe;
    if (scal) c.push(`${n}:SCAL ${vd}`);
    // ponytail: Rigol sign convention assumed (shown = v + offset); flip here if traces move the wrong way.
    if (scal || A.offsetDiv !== B.offsetDiv) c.push(`${n}:OFFS ${+(B.offsetDiv * vd).toPrecision(4)}`);
  });
  if (a.tb !== b.tb) c.push(`TIM:SCAL ${TIMEBASES[b.tb]}`);
  if (a.hoff !== b.hoff) c.push(`TIM:OFFS ${+b.hoff.toPrecision(4)}`);
  const t = a.trig, u = b.trig;
  if (t.src !== u.src) c.push(`TRIG:EDGE:SOUR CHAN${u.src}`);
  if (t.slope !== u.slope) c.push(`TRIG:EDGE:SLOP ${u.slope}`);
  if (t.level !== u.level) c.push(`TRIG:EDGE:LEV ${+u.level.toPrecision(4)}`);
  if (t.nrej !== u.nrej) c.push(`TRIG:EDGE:NREJ ${u.nrej ? 'ON' : 'OFF'}`);
  if (t.pos !== u.pos) c.push(`TRIG:POS ${u.pos}`);
  if (a.sweep !== b.sweep && b.sweep !== 'SING') c.push(`TRIG:SWE ${b.sweep}`);
  if (a.mdepth !== b.mdepth) c.push(`ACQ:MDEP ${b.mdepth}`);
  if (a.roll !== b.roll) c.push(`ACQ:ROLL ${b.roll ? 'ON' : 'OFF'}`);
  if (a.interleave !== b.interleave) c.push(`ACQ:INT ${b.interleave}`);
  return c;
}

export async function flushScope(a: Scope, b: Scope) {
  const c = scopeDiff(a, b);
  if (c.length) { await ctl(c); cfgDue = 0; }
}

const SCOPE_Q = {
  tb: 'TIM:SCAL?', hoff: 'TIM:OFFS?', stat: 'TRIG:STAT?', swe: 'TRIG:SWE?', src: 'TRIG:EDGE:SOUR?', slope: 'TRIG:EDGE:SLOP?',
  lev: 'TRIG:EDGE:LEV?', nrej: 'TRIG:EDGE:NREJ?', pos: 'TRIG:POS?', srate: 'ACQ:SRAT?', mdep: 'ACQ:MDEP?', roll: 'ACQ:ROLL?',
  int: 'ACQ:INT?', ist: 'ACQ:INT:STAT?', prog: 'ACQ:PROG?', fc1: 'CHAN1:FCNT?', fc2: 'CHAN2:FCNT?', qual: 'MEAS:FCNT:QUAL?',
  d1: 'CHAN1:DISP?', c1: 'CHAN1:COUP?', p1: 'CHAN1:PROB?', s1: 'CHAN1:SCAL?', o1: 'CHAN1:OFFS?',
  d2: 'CHAN2:DISP?', c2: 'CHAN2:COUP?', p2: 'CHAN2:PROB?', s2: 'CHAN2:SCAL?', o2: 'CHAN2:OFFS?',
};

// ACQ:INT? answers 1, 0 or AUTO. The wiki says AUTO is ZT706S-only; the firmware offers it on both
// boards (backend.cpp interleave(), since ≤ 0.21.4; a ZT703S on 0.21.9 answers AUTO).
const interleaveOf = (r: string) => (r.toUpperCase() === 'AUTO' ? 'AUTO' : on(r) ? 'ON' : 'OFF');

// ACQ:INT:STAT? = "<active>,<blocker bits>".
function interleaveState(r: string): Status['interleave'] {
  const [active, blockers] = r.split(',').map(Number);
  return Number.isFinite(active) ? { active: active === 1, blockers: blockers || 0 } : null;
}

// ACQ:PROG? = "<active>,<sequence>,<words>,<status>"; active while a slow (gated) or Roll record
// fills. The sequence moves with each new record (Roll: one endless record), so `since` = when this
// record started, in host time. A record takes longer than its length (1 s/div: ~22 s, measured 0.21.9).
function captureOf(r: string, prev: Status['capture']): Status['capture'] {
  const [a, seq] = r.split(',').map(Number), active = a === 1;
  return { active, seq, since: active && prev.active && seq === prev.seq ? prev.since : now() };
}

const sweepOf = (r: string): Scope['sweep'] => (r.startsWith('SING') ? 'SING' : r.startsWith('NORM') ? 'NORM' : 'AUTO');

// ~1 ms per query inside the held-frame window, ~24 ms outside it.
async function readScope(force = false) {
  const keys = Object.keys(SCOPE_Q) as (keyof typeof SCOPE_Q)[];
  // *CLS: the counter queues -230 when there's no signal; don't let the queue fill.
  const vals = await link.texts([...Object.values(SCOPE_Q), '*CLS']);
  const r = Object.fromEntries(keys.map((k, i) => [k, vals[i]])) as Record<keyof typeof SCOPE_Q, string>;
  const cur = get().scope;
  const ch = (i: 0 | 1) => {
    const n = i + 1, probe = num(r[`p${n}` as 'p1']), vd = num(r[`s${n}` as 's1']), offs = num(r[`o${n}` as 'o1']);
    const c = cur.ch[i];
    return {
      on: on(r[`d${n}` as 'd1']),
      coup: r[`c${n}` as 'c1'] === 'AC' ? 'AC' as const : 'DC' as const,
      probe: Number.isFinite(probe) ? probe : c.probe,
      vdivMv: Number.isFinite(vd) && Number.isFinite(probe) ? nearest(VDIV_MV, (vd / probe) * 1000) : c.vdivMv,
      offsetDiv: Number.isFinite(offs) && vd > 0 ? +(offs / vd).toFixed(2) : c.offsetDiv,
    };
  };
  const tb = num(r.tb), swe = r.swe.toUpperCase();
  remote('scope', {
    ch: [ch(0), ch(1)],
    ...(Number.isFinite(tb) ? { tb: TIMEBASES.indexOf(nearest(TIMEBASES, tb)) } : {}),
    ...(Number.isFinite(num(r.hoff)) ? { hoff: num(r.hoff) } : {}),
    sweep: sweepOf(swe),
    trig: {
      src: r.src.endsWith('2') ? 2 : 1,
      slope: r.slope.startsWith('NEG') ? 'NEG' : 'POS',
      level: Number.isFinite(num(r.lev)) ? num(r.lev) : cur.trig.level,
      nrej: r.nrej === 'NAN' ? cur.trig.nrej : on(r.nrej),
      pos: Number.isFinite(num(r.pos)) ? num(r.pos) : cur.trig.pos,
    },
    ...(Number.isFinite(num(r.mdep)) ? { mdepth: num(r.mdep) } : {}),
    roll: on(r.roll),
    interleave: interleaveOf(r.int),
  }, force);
  const st = get().scopeStatus;
  set({
    scopeStatus: {
      stat: r.stat, srate: num(r.srate),
      lastSweep: swe.startsWith('NORM') ? 'NORM' : swe.startsWith('AUTO') ? 'AUTO' : st.lastSweep,
      fcnt: [num(r.fc1), num(r.fc2)], qual: r.qual.split(',')[0],
      interleave: interleaveState(r.ist), capture: captureOf(r.prog, st.capture),
    },
  });
}

// While a record is still filling, frame reads fail and readScope (which runs inside the
// held-frame window) doesn't run: keep the run state and capture progress current with two queries.
// The sweep too: after SING the device stays in Single, and Run must know it (scopeRun).
async function readWaiting() {
  const [stat, swe, prog] = await link.texts(['TRIG:STAT?', 'TRIG:SWE?', 'ACQ:PROG?', '*CLS']);
  const st = get().scopeStatus, sweep = sweepOf(swe.toUpperCase());
  if (swe !== 'NAN') remote('scope', { sweep });
  set({ scopeStatus: { ...st, stat, lastSweep: sweep === 'SING' ? st.lastSweep : sweep, capture: captureOf(prog, st.capture) } });
}

// Preamble: format,type,points,count,xinc,xorigin,xref,yinc,zero code,128. Type 1 = PEAK
// (min,max byte pairs, points = buckets). For the whole record (WAV:POIN 0) points = samples,
// xinc = sample interval and xorigin = −interval·triggerIndex when triggered, else 0 (waveform.cpp).
type Pre = { type: number; points: number; xinc: number; xorig: number; yinc: number; zero: number; yref: number };
function parsePre(text: string): Pre {
  const [, type, points, , xinc, xorig, , yinc, zero, yref] = text.split(',').map(Number);
  if (!(points > 0 && xinc > 0)) throw new Error(`preamble "${text}"`);
  return { type, points, xinc, xorig, yinc, zero, yref };
}

function toFrame(ch: 0 | 1, seq: number, p: Pre, b: Uint8Array): Frame {
  const volt = (x: number) => (x - p.yref - p.zero) * p.yinc;
  if (p.type !== 1) return { ch, seq, xinc: p.xinc, xorig: p.xorig, volts: Float32Array.from(b, volt) };
  const n = b.length >> 1, lo = new Float32Array(n), hi = new Float32Array(n), volts = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lo[i] = volt(b[2 * i]);
    hi[i] = volt(b[2 * i + 1]);
    volts[i] = (lo[i] + hi[i]) / 2;
  }
  return { ch, seq, xinc: p.xinc, xorig: p.xorig, volts, lo, hi };
}

// WAV:FRAM? payload: "seq,count\n", one "CHANn,<preamble of the points sent>\n" per channel, then
// each channel's points in that order (SCPI_DESKTOP.md).
export function parseFrame(bin: Uint8Array): Frame[] {
  let at = 0;
  const line = () => {
    const i = bin.indexOf(0x0a, at);
    if (i < 0) throw new Error('WAV:FRAM? header cut short');
    const text = dec.decode(bin.subarray(at, i));
    at = i + 1;
    return text;
  };
  const [seq, count] = line().split(',').map(Number);
  const heads: { ch: 0 | 1; pre: Pre }[] = [];
  for (let k = 0; k < count; k++) {
    const text = line(), comma = text.indexOf(',');
    heads.push({ ch: text.startsWith('CHAN2') ? 1 : 0, pre: parsePre(text.slice(comma + 1)) });
  }
  return heads.map(({ ch, pre }) => {
    const n = pre.points * (pre.type === 1 ? 2 : 1), bytes = bin.subarray(at, at + n);
    if (bytes.length < n) throw new Error('WAV:FRAM? data cut short');
    at += n;
    return toFrame(ch, seq, pre, bytes);
  });
}

// The record is longer than the screen at fast timebases (the sample rate tops out, e.g. 128K
// points at 100 MSa/s = 1.3 ms vs 10 µs on screen at 1 µs/div): the 10-div window [first, end)
// around the trigger. Untriggered: assume the trigger at TRIG:POS of the record.
export function screenWindow(samples: number, interval: number, origin0: number, s: Pick<Scope, 'tb' | 'trig'>) {
  const pos = s.trig.pos / 100, S = Math.round((10 * TIMEBASES[s.tb]) / interval);
  if (S >= samples) return { first: 0, end: samples };
  const idx = Math.round(-origin0 / interval), trig = idx > 0 ? idx : pos * samples;
  const first = Math.round(Math.min(samples - S, Math.max(0, trig - pos * S)));
  return { first, end: first + S };
}

const strideOf = (n: number, pts: number) => (pts && n > pts ? Math.ceil(n / pts) : 1); // the firmware's rounding

// The points mode is a session setting: always state it (Bode and CSV need samples, not pairs).
const modeCmd = (peak: boolean) => (desktop() ? [`WAV:POIN:MODE ${peak ? 'PEAK' : 'STR'}`] : []);

// Reads the whole-record preamble (WAV:POIN 0), cuts the screen window with WAV:STAR/STOP and fetches
// at most `pts` points of it; `full` fetches the whole record (CSV). `peak` asks for min/max pairs
// when the window is decimated (firmware ≥ 0.21.9), so narrow pulses survive.
// One transaction: a command slipped in between (WAV:SOUR, CHAN:SCAL) would mislabel the frame.
export function fetchChannel(i: 0 | 1, pts: number, timeout: number, full = false, peak = false): Promise<Frame> {
  return link.tx(async (run) => {
    const [pre] = await run([`WAV:SOUR CHAN${i + 1}`, 'WAV:POIN 0', 'WAV:PRE?'], timeout);
    const rec = parsePre(pre.text ?? '');
    lastRecord = { samples: rec.points, interval: rec.xinc, origin0: rec.xorig };
    const w = full ? { first: 0, end: rec.points } : screenWindow(rec.points, rec.xinc, rec.xorig, get().scope);
    const n = full ? 0 : pts, stride = strideOf(w.end - w.first, n), pk = peak && desktop() && stride > 1;
    const [data, seq] = await run([`WAV:STAR ${w.first + 1}`, `WAV:STOP ${w.end}`, `WAV:POIN ${n}`, ...modeCmd(pk), 'WAV:DATA?', 'WAV:SEQ?'], timeout);
    if (!data.bin) throw new Error(`WAV:DATA? gave "${data.text}"`);
    const p = { ...rec, type: pk ? 1 : 0, xinc: rec.xinc * stride, xorig: rec.xorig + rec.xinc * w.first };
    return toFrame(i, +(seq.text ?? 0), p, data.bin);
  });
}

// Record geometry for WAV:FRAM?, which describes only the points it sends. Taken from the whole-record
// preamble fetchChannel reads anyway, never from an extra WAV:PRE?: a second PRE? on a channel releases
// its record and waits only 1 s for a newer one, so slow records would never be shown (waveform.cpp).
// Then the trigger index follows each frame.
type Geo = { samples: number; interval: number; origin0: number; key: string };
let lastRecord: Omit<Geo, 'key'> | null = null;
function geoKey() {
  const { scope: s, scopeStatus: t } = get();
  return JSON.stringify([s.tb, s.mdepth, s.ch[0].on, s.ch[1].on, s.roll, s.interleave, s.trig.pos, t.srate]);
}

// How long a fresh record can take: its own duration, or the screen at the timebase now set (a
// change not yet applied leaves the old record's geometry, e.g. 10 ms/div → 1 s/div).
const recordMs = (geo: Geo) => 1000 * Math.max(geo.samples * geo.interval, 10 * TIMEBASES[get().scope.tb]);

// Both channels of one acquisition in one block (firmware ≥ 0.21.9).
async function fetchFrame(geo: Geo, pts: number, peak: boolean): Promise<Frame[]> {
  const w = screenWindow(geo.samples, geo.interval, geo.origin0, get().scope);
  const stride = strideOf(w.end - w.first, pts), pk = peak && stride > 1;
  const timeout = 1500 + recordMs(geo); // a fresh record: the firmware waits 1 s + its duration
  const [r] = await link.run([`WAV:STAR ${w.first + 1}`, `WAV:STOP ${w.end}`, `WAV:POIN ${pts}`, ...modeCmd(pk), 'WAV:FRAM?'], timeout);
  if (!r.bin) throw new Error(`WAV:FRAM? gave "${r.text}"`);
  const frames = parseFrame(r.bin);
  if (frames.length) geo.origin0 = frames[0].xorig - geo.interval * w.first; // exact preamble: origin0 + interval·first
  return frames;
}

// WAV:MEAS? fields (SCPI_DESKTOP.md): freq, Vpp, RMS, period, mean, min, max, AC RMS, duty, rising
// edges, reserved, counter, amplitude, top, bottom, clipped 0|1, frequency source. NAN = unknown.
export function parseMeas(text: string): Meas | null {
  const f = text.split(',');
  if (f.length < 17) return null;
  const n = f.map(num);
  return {
    freq: n[0], vpp: n[1], rms: n[2], period: n[3], mean: n[4], min: n[5], max: n[6], acRms: n[7], duty: n[8],
    edges: n[9], amp: n[12], top: n[13], base: n[14], rise: NaN, clipped: f[15] === '1', src: f[16].trim(),
  };
}

// The device's screen readouts over the window just fetched (WAV:STAR/STOP still set, the frame
// still leased), so the numbers match the device's own footer.
async function measureLive(chans: (0 | 1)[]) {
  const replies = await link.texts(chans.flatMap((i) => [`WAV:SOUR CHAN${i + 1}`, 'WAV:MEAS? SCR']), 3000);
  const meas: (Meas | null)[] = [null, null];
  chans.forEach((i, k) => (meas[i] = parseMeas(replies[k])));
  scopeData.meas = meas;
}

type Live = {
  ready: boolean; lastSeq: number; seen: number; missed: number; winN: number; winT: number;
  geo: Geo | null; measDue: number; how: string;
};

export async function scopeLoop(id: number) {
  scopeData.frames = []; // don't show a previous session's trace as live
  scopeData.meas = [null, null];
  scopeData.version++;
  const st: Live = { ready: false, lastSeq: NaN, seen: 0, missed: 0, winN: 0, winT: now(), geo: null, measDue: 0, how: '' };
  try {
    while (alive(id)) {
      if (paused) { await sleep(50); continue; }
      try {
        await livePass(st);
      } catch {
        if (link.closed) break;
        st.geo = null;
        cfgDue = 0;
        await readWaiting().catch(() => {});
        await sleep(50); // Single/Normal waiting for a trigger, a slow record, channel just toggled: try again
      }
      if (now() - st.winT > 1000) {
        const pct = st.seen ? Math.round((100 * st.seen) / (st.seen + st.missed)) : 100;
        set({ stats: `CDC · ${((st.winN * 1000) / (now() - st.winT)).toFixed(1)} fps · ${pct}% frames seen · ${st.how} · errors ${get().errors}` });
        st.winN = 0; st.winT = now();
      }
    }
  } finally {
    // Release the held frame, or the device's capture stays paused (and its AUTO key is refused).
    if (!link.closed) await link.run(['WAV:SNAP']).catch(() => {});
  }
}

async function livePass(st: Live) {
  if (!st.ready) {
    await link.run(['WAV:MODE RAW', 'WAV:FORM BYTE']);
    await readScope(true);
    st.ready = true;
    cfgDue = now() + 500;
  }
  const s = get().scope;
  const chans = ([0, 1] as const).filter((i) => s.ch[i].on);
  const got = chans.length && !paused ? await fetchLive(st, chans) : [];
  // Still inside the held-frame window: device measurements and settings reads are cheap here.
  if (got.length && desktop() && now() > st.measDue) { await measureLive(chans); st.measDue = now() + MEAS_MS; }
  if (now() > cfgDue) { await readScope(); cfgDue = now() + 500; }
  if (got.length && got.length === chans.length) publish(got, st);
  if (!chans.length) await sleep(300);
  if (get().scopeStatus.stat === 'STOP') await sleep(250); // nothing new is coming
}

// FFT needs evenly spaced samples (and up to 2048 of them); otherwise PEAK keeps glitches visible.
async function fetchLive(st: Live, chans: (0 | 1)[]): Promise<Frame[]> {
  const fft = get().fft, pts = fft ? FFT_PTS : LIVE_PTS, peak = !fft;
  // A record short of the configured depth isn't this plan's geometry: Roll right after a change grows
  // from ~800 samples (measured 0.21.9), or it is a capture from before the change.
  const g = st.geo, key = geoKey(); // the settings this pass reads under, before any edit lands mid-pass
  if (desktop() && g && g.key === key && g.samples === get().scope.mdepth && recordMs(g) <= FRAME_MAX_MS) {
    st.how = `FRAM ${pts} ${peak ? 'peak' : 'pts'}/ch`;
    return fetchFrame(g, pts, peak);
  }
  st.how = `${pts} ${peak && desktop() ? 'peak' : 'pts'}/ch`;
  const got: Frame[] = [];
  for (const i of chans) {
    if (paused) break;
    got.push(await fetchChannel(i, pts, 1500, false, peak));
  }
  st.geo = desktop() && lastRecord ? { ...lastRecord, key } : null;
  return got;
}

function publish(got: Frame[], st: Live) {
  scopeData.frames = got;
  scopeData.version++;
  const seq = got[0].seq;
  if (seq !== st.lastSeq) {
    if (Number.isFinite(st.lastSeq) && seq > st.lastSeq) st.missed += seq - st.lastSeq - 1;
    st.seen++;
  }
  st.lastSeq = seq;
  st.winN++;
}

// Suspends live frame reads (the loop keeps running) for work that must not race them.
async function withReadsPaused<T>(fn: () => Promise<T>): Promise<T> {
  paused++;
  try {
    return await fn();
  } finally {
    paused--;
    cfgDue = 0;
  }
}

export async function scopeRun() {
  const { scope, scopeStatus } = get();
  // SING makes Single the sweep mode itself; RUN alone would just re-arm another single. State the
  // sweep every time: right after Single the store may not know yet (no frames while waiting).
  await ctl([`TRIG:SWE ${scope.sweep === 'SING' ? scopeStatus.lastSweep : scope.sweep}`, 'RUN']);
  cfgDue = 0;
}
export const scopeStop = async () => { await ctl(['STOP']); cfgDue = 0; };
export const scopeSingle = async () => { await ctl(['SING']); cfgDue = 0; };
export const scopeForce = async () => { await ctl(['TFORce']); cfgDue = 0; };

// Auto Setup fails ("cannot apply acquisition") if frames are read meanwhile, and *OPC?
// reports success either way, so pause reads and compare settings ourselves.
export function scopeAuto(): Promise<string> {
  return withReadsPaused(async () => {
    const key = () => { const s = get().scope; return JSON.stringify([s.tb, s.ch[0].vdivMv, s.ch[1].vdivMv, s.trig.level]); };
    const before = key();
    const ok = await ctl(['AUToscale', '*OPC?'], 60000);
    await readScope(true).catch(() => {});
    if (!ok) return 'Auto setup failed';
    return key() === before ? 'Auto found no new settings — check the device screen' : 'Auto setup applied';
  });
}

export function exportScopeCsv() {
  return withReadsPaused(async () => {
    try {
      const s = get().scope;
      const got: Frame[] = [];
      for (const i of [0, 1] as const) if (s.ch[i].on) got.push(await fetchChannel(i, 0, 30000, true));
      if (!got.length) return;
      if (got.length > 1 && got[0].seq !== got[1].seq) fail('CSV: channels came from different frames');
      const n = Math.min(...got.map((f) => f.volts.length)), f0 = got[0];
      const head = ['time_s', ...got.map((f) => `CH${f.ch + 1}_V`)].join(',');
      const lines = new Array<string>(n);
      for (let i = 0; i < n; i++) lines[i] = [(f0.xorig + i * f0.xinc).toExponential(6), ...got.map((f) => f.volts[i].toPrecision(5))].join(',');
      download(`scope-${Date.now()}.csv`, new Blob([`${head}\n${lines.join('\n')}\n`], { type: 'text/csv' }));
    } catch (e) {
      fail(`CSV export failed: ${errText(e)}`);
    }
  });
}
