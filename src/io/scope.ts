// Oscilloscope: settings read/write, windowed frame fetch, the live loop, run control, CSV.
import { TIMEBASES, VDIV_MV } from '../device';
import type { Frame } from '../dsp';
import { sleep } from '../link';
import type { State } from '../store';
import { alive, ctl, download, errText, fail, get, link, nearest, now, num, on, remote, set } from './core';

type Scope = State['scope'];

export const scopeData = { frames: [] as Frame[], version: 0 };
const LIVE_PTS = 1024; // power of two for the FFT; ~screen width
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
  int: 'ACQ:INT?', fc: 'MEAS:FCNT?', qual: 'MEAS:FCNT:QUAL?',
  d1: 'CHAN1:DISP?', c1: 'CHAN1:COUP?', p1: 'CHAN1:PROB?', s1: 'CHAN1:SCAL?', o1: 'CHAN1:OFFS?',
  d2: 'CHAN2:DISP?', c2: 'CHAN2:COUP?', p2: 'CHAN2:PROB?', s2: 'CHAN2:SCAL?', o2: 'CHAN2:OFFS?',
};

// ACQ:INT? answers 1, 0 or AUTO (AUTO: ZT706S only).
const interleaveOf = (r: string) => (r.toUpperCase() === 'AUTO' ? 'AUTO' : on(r) ? 'ON' : 'OFF');

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
    sweep: swe.startsWith('SING') ? 'SING' : swe.startsWith('NORM') ? 'NORM' : 'AUTO',
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
      stat: r.stat, srate: num(r.srate), fcnt: r.src.endsWith('2') ? [NaN, num(r.fc)] : [num(r.fc), NaN], qual: r.qual.split(',')[0],
      lastSweep: swe.startsWith('NORM') ? 'NORM' : swe.startsWith('AUTO') ? 'AUTO' : st.lastSweep,
    },
  });
}

// The record is longer than the screen at fast timebases (the sample rate tops out, e.g. 128K
// points at 100 MSa/s = 1.3 ms vs 10 µs on screen at 1 µs/div). So: read the whole-record
// preamble (WAV:POIN 0), cut out the 10-div window around the trigger with WAV:STAR/STOP,
// and fetch at most `pts` points of it. `full` fetches the whole record instead (CSV).
// Preamble: format,type,points,count,xinc,xorigin,xref,yinc,zero code,128. xorigin is
// −interval·triggerIndex for a triggered frame and 0 otherwise (firmware waveform.cpp).
// One transaction: a command slipped in between (WAV:SOUR, CHAN:SCAL) would mislabel the frame.
export function fetchChannel(i: 0 | 1, pts: number, timeout: number, full = false): Promise<Frame> {
  return link.tx(async (run) => {
    const [pre] = await run([`WAV:SOUR CHAN${i + 1}`, 'WAV:POIN 0', 'WAV:PRE?'], timeout);
    const [, , samples, , interval, origin0, , yinc, zero, yref] = (pre.text ?? '').split(',').map(Number);
    if (!(samples > 0 && interval > 0)) throw new Error(`WAV:PRE? gave "${pre.text}"`);
    let first = 0, end = samples;
    if (!full) {
      const { scope } = get();
      const pos = scope.trig.pos / 100, S = Math.round((10 * TIMEBASES[scope.tb]) / interval);
      if (S < samples) {
        const trig = origin0 < 0 ? -origin0 / interval : pos * samples; // untriggered: assume TRIG:POS of the record
        first = Math.round(Math.min(samples - S, Math.max(0, trig - pos * S)));
        end = first + S;
      }
    }
    const stride = !full && end - first > pts ? Math.ceil((end - first) / pts) : 1; // same rounding as the firmware
    const [data, seq] = await run([`WAV:STAR ${first + 1}`, `WAV:STOP ${end}`, `WAV:POIN ${full ? 0 : pts}`, 'WAV:DATA?', 'WAV:SEQ?'], timeout);
    if (!data.bin) throw new Error(`WAV:DATA? gave "${data.text}"`);
    return {
      ch: i, seq: +(seq.text ?? 0), xinc: interval * stride, xorig: origin0 + interval * first,
      volts: Float32Array.from(data.bin, (b) => (b - yref - zero) * yinc),
    };
  });
}

type Live = { ready: boolean; lastSeq: number; seen: number; missed: number; winN: number; winT: number };

export async function scopeLoop(id: number) {
  scopeData.frames = []; // don't show a previous session's trace as live
  scopeData.version++;
  const st: Live = { ready: false, lastSeq: NaN, seen: 0, missed: 0, winN: 0, winT: now() };
  try {
    while (alive(id)) {
      if (paused) { await sleep(50); continue; }
      try {
        await livePass(st);
      } catch {
        if (link.closed) break;
        cfgDue = 0;
        await sleep(50); // Single/Normal waiting for a trigger, channel just toggled: try again
      }
      if (now() - st.winT > 1000) {
        const pct = st.seen ? Math.round((100 * st.seen) / (st.seen + st.missed)) : 100;
        set({ stats: `CDC · ${((st.winN * 1000) / (now() - st.winT)).toFixed(1)} fps · ${pct}% frames seen · ${LIVE_PTS} pts/ch · errors ${get().errors}` });
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
  const got: Frame[] = [];
  for (const i of chans) {
    if (paused) break;
    got.push(await fetchChannel(i, LIVE_PTS, 1500));
  }
  // Still inside the held-frame window: settings reads are ~1 ms each here.
  if (now() > cfgDue) { await readScope(); cfgDue = now() + 500; }
  if (got.length && got.length === chans.length) publish(got, st);
  if (!chans.length) await sleep(300);
  if (get().scopeStatus.stat === 'STOP') await sleep(250); // nothing new is coming
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
  // SING makes Single the sweep mode itself; RUN alone would just re-arm another single.
  await ctl(scope.sweep === 'SING' ? [`TRIG:SWE ${scopeStatus.lastSweep}`, 'RUN'] : ['RUN']);
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
