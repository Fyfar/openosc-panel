// Bode: host-side sweep. Generator sine → DUT; CH1 = DUT input, CH2 = DUT output.
import { bodeMaxHz, bodePlan, bodeTimebase, fwHas, genMaxHz, MEM_DEPTHS, TRIG_TYPES, VDIV_MV, type Model } from '../device';
import { bodeTone, extent, type Frame } from '../dsp';
import { sleep } from '../link';
import type { State } from '../store';
import { ctl, errText, fail, get, link, nearest, num, on } from './core';
import { readGen, SHAPE_CMD } from './gen';
import { fetchChannel, forgetWav, wavRun } from './scope';

// The sweep's scope setup, whatever the scope was left at, and what each point sends. Everything these
// touch (plus the CHANn:SCAL re-ranging) must be put back by scopeRestore: scripts/check-logic.mts checks it.
// TRIG:MODE EDGE goes first (qual: FW.qualTrig): in Runt or Rise/fall a V/div or offset change moves the
// band's other level to the nearest code on the screen (firmware applyFollowing), so ranging would wreck
// the user's band; in Edge it is left alone. AC: the ZT703S sine sits on ~1.3 V DC, which would waste half
// the ADC codes. An edge at 0 V, rising, no noise reject: the AC-coupled CH1 sine crosses it every period,
// so Auto never waits out its budget. ACQ:MDEP is points per enabled channel (the firmware picks the
// smallest memory budget covering it), so it is set after both channels are on: half the smallest budget
// per channel keeps a record about the 10 divisions.
export const sweepScope = (qual: boolean) => [
  ...(qual ? ['TRIG:MODE EDGE'] : []),
  'CHAN1:DISP ON', 'CHAN2:DISP ON', 'CHAN1:COUP AC', 'CHAN2:COUP AC', 'CHAN1:OFFS 0', 'CHAN2:OFFS 0',
  'ACQ:ROLL OFF', `ACQ:MDEP ${MEM_DEPTHS[0] / 2}`, 'TIM:OFFS 0',
  'TRIG:EDGE:SOUR CHAN1', 'TRIG:EDGE:SLOP POS', 'TRIG:EDGE:NREJ OFF', 'TRIG:EDGE:LEV 0', 'TRIG:SWE AUTO', 'RUN',
];
// The timebase only when it moves (1-2-5 steps: every few points). Each command is a device pass, ~24 ms
// outside the held-frame window; a fresh record is waited for anyway (freshPair).
export const pointCmds = (f: number, tb: number, lastTb?: number) => [`SOUR:FREQ ${+f.toPrecision(6)}`, ...(tb === lastTb ? [] : [`TIM:SCAL ${tb}`])];

const SAVE_Q = {
  tb: 'TIM:SCAL?', hoff: 'TIM:OFFS?', swe: 'TRIG:SWE?', stat: 'TRIG:STAT?', src: 'TRIG:EDGE:SOUR?',
  slope: 'TRIG:EDGE:SLOP?', nrej: 'TRIG:EDGE:NREJ?', lev: 'TRIG:EDGE:LEV?',
  d1: 'CHAN1:DISP?', d2: 'CHAN2:DISP?', s1: 'CHAN1:SCAL?', s2: 'CHAN2:SCAL?', o1: 'CHAN1:OFFS?', o2: 'CHAN2:OFFS?',
  p1: 'CHAN1:PROB?', p2: 'CHAN2:PROB?', c1: 'CHAN1:COUP?', c2: 'CHAN2:COUP?', roll: 'ACQ:ROLL?', mdep: 'ACQ:MDEP?',
};
// mode: TRIG:MODE?, read on FW.qualTrig only ('' before).
type Saved = Record<keyof typeof SAVE_Q, string> & { mode: string };
const TRIG_TYPE_IDS: string[] = TRIG_TYPES.map((t) => t.id);

// Puts the scope back as it was before the sweep. Values the device didn't report are skipped.
export function scopeRestore(s: Saved): string[] {
  const n = (x: string) => (Number.isFinite(num(x)) ? +num(x).toPrecision(6) : null);
  const val = (head: string, x: string) => (n(x) === null ? [] : [`${head} ${n(x)}`]);
  const swe = s.swe.toUpperCase();
  const coup = (head: string, x: string) => { const m = x.trim().toUpperCase().match(/^(AC|DC|GND)/); return m ? [`${head} ${m[1]}`] : []; };
  // ACQ:MDEP? is the samples per enabled channel (258 048 of a 256K budget on one, 126 976 on two): back
  // to the budget, then per channel again for the channels the restore turns on.
  const chans = Math.max(1, +on(s.d1) + +on(s.d2));
  const depth = n(s.mdep) === null ? [] : [`ACQ:MDEP ${nearest(MEM_DEPTHS, num(s.mdep) * chans) / chans}`];
  return [
    `CHAN1:DISP ${on(s.d1) ? 'ON' : 'OFF'}`, `CHAN2:DISP ${on(s.d2) ? 'ON' : 'OFF'}`, ...coup('CHAN1:COUP', s.c1), ...coup('CHAN2:COUP', s.c2),
    ...(n(s.roll) === null ? [] : [`ACQ:ROLL ${on(s.roll) ? 'ON' : 'OFF'}`]), ...depth,
    ...val('CHAN1:SCAL', s.s1), ...val('CHAN2:SCAL', s.s2), ...val('CHAN1:OFFS', s.o1), ...val('CHAN2:OFFS', s.o2),
    ...val('TIM:SCAL', s.tb), ...val('TIM:OFFS', s.hoff),
    `TRIG:EDGE:SOUR CHAN${s.src.endsWith('2') ? 2 : 1}`,
    `TRIG:EDGE:SLOP ${s.slope.toUpperCase().startsWith('NEG') ? 'NEG' : 'POS'}`, `TRIG:EDGE:NREJ ${on(s.nrej) ? 'ON' : 'OFF'}`,
    // The raw level after the channels are back (it is in ADC codes), still in Edge; the type last, so the
    // band's other level, untouched in Edge, keeps its codes and so its voltage.
    ...val('TRIG:EDGE:LEV', s.lev), ...(TRIG_TYPE_IDS.includes(s.mode.toUpperCase()) ? [`TRIG:MODE ${s.mode.toUpperCase()}`] : []),
    // Single is the SING command, never TRIG:SWE SING (see scopeRun).
    ...(swe.startsWith('SING') ? ['SING'] : [`TRIG:SWE ${swe.startsWith('NORM') ? 'NORM' : 'AUTO'}`]),
    ...(s.stat.toUpperCase().startsWith('STOP') ? ['STOP'] : []),
  ];
}

const genRestore = (g: State['gen'], model: Model) => [
  // SOUR:FUNC is refused above the shape's limit, so bring the frequency under it first.
  `OUTP ${g.out ? 'ON' : 'OFF'}`, `SOUR:FREQ ${Math.min(g.freq, genMaxHz(model, get().idn?.fw)[g.shape])}`, `SOUR:FUNC ${SHAPE_CMD[g.shape]}`, `SOUR:FREQ ${g.freq}`,
];

// Next V/div per channel: a step up when it clips (its real size is unknown), when tiny straight
// down to the first range showing it larger, else unchanged. The jump counts a reading as at least one
// ADC code (a smaller signal reads flat) and never goes where the peak would clip: a tiny signal on an
// offset would step down and up for ever.
const CLIP_DIV = 3.8, TINY_DIV = 1.5; // peak from 0 V, and peak to peak
export function rerange(frames: Frame[], vdiv: number[], probe: number[]): number[] {
  return frames.map((fr, i) => {
    const { mn, mx } = extent(fr.volts);
    const peak = Math.max(Math.abs(mn), Math.abs(mx)), pp = mx - mn;
    const steps = VDIV_MV.map((m) => (m * probe[i]) / 1000);
    const idx = steps.indexOf(nearest(steps, vdiv[i]));
    const seen = Math.max(pp, fr.scale?.yinc ?? 0);
    const lowest = () => steps.findIndex((s) => peak / s <= CLIP_DIV);
    const down = () => Math.max(0, lowest(), steps.findLastIndex((s, j) => j < idx && seen / s >= TINY_DIV));
    const want = peak / vdiv[i] > CLIP_DIV ? Math.min(steps.length - 1, idx + 1) : pp / vdiv[i] < TINY_DIV ? down() : idx;
    return want === idx ? vdiv[i] : steps[want];
  });
}

// A repeated WAV:PRE? on a channel waits 1 s for a newer record, then answers NAN (-230): with
// records of a second or more that only means "not yet".
const notYet = (e: unknown) => /preamble "NAN/.test(errText(e));

// False once Stop was clicked: the sweep winds down while `bode.running` stays true.
const sweeping = () => !get().bode.stopping;

// Retries `read` while the device has no newer record yet; null once `until` (ms) has passed or the
// user stopped the sweep (a 1 Hz point can otherwise wait minutes).
async function untilRecord<T>(until: number, read: (timeout: number) => Promise<T>): Promise<T | null> {
  while (performance.now() < until && sweeping()) {
    try {
      return await read(Math.max(1500, until - performance.now()));
    } catch (e) {
      if (!notYet(e)) throw e;
      await link.run(['*CLS']);
    }
  }
  return null;
}

// Sequence of the newest complete record, without reading its data (PRE? leases it, SEQ? names it).
async function latestSeq(timeout: number) {
  const [pre, seq] = await wavRun(['WAV:SOUR CHAN1', 'WAV:POIN 0', 'WAV:PRE?', 'WAV:SEQ?'], timeout);
  if (!Number.isFinite(num(seq.text ?? ''))) throw new Error(`preamble "${pre.text}"`);
  return num(seq.text ?? '');
}

// CH1's newest record once its sequence is at least `min`; null at the deadline or on stop.
async function seqAtLeast(until: number, min: number) {
  for (;;) {
    const s = await untilRecord(until, latestSeq);
    if (s === null || s >= min) return s;
  }
}

// A CH1/CH2 pair of whole records, both channels of one acquisition, from a record that started
// after now: s0 + 1 can still hold the previous setting (1 of 10 on the bench), s0 + 2 can't. Each CH1
// PRE? after the first waits for the next record, so s0 + 1 is passed without reading its data.
async function freshPair(recordMs: number) {
  const until = performance.now() + 2000 + 3 * recordMs;
  const s0 = await seqAtLeast(until, 0);
  if (s0 === null || (await seqAtLeast(until, s0 + 1)) === null) return null;
  let a: Frame | null = null;
  while (!a || a.seq < s0 + 2) {
    a = await untilRecord(until, (t) => fetchChannel(0, 0, t, true));
    if (!a) return null;
  }
  const c = await fetchChannel(1, 0, Math.max(1500, until - performance.now()), true);
  return a.seq === c.seq ? [a, c] : null;
}

// One point. A channel that clips or is tiny is re-ranged and the point retried, up to a walk of the
// whole list (clipping goes up one step at a time). Null when no clean pair came, or it never settled.
async function measurePoint(f: number, tb: number, vdiv: number[], probe: number[]) {
  for (let attempt = 0; attempt < VDIV_MV.length; attempt++) {
    // 32 768 per channel: a record lasts 10 × the timebase and arrives every ≤ 2 of that (ZT703S, 0.21.14).
    const pair = await freshPair(20_000 * tb);
    if (!pair) return null;
    const next = rerange(pair, vdiv, probe);
    const fix = next.flatMap((v, i) => (v !== vdiv[i] ? [`CHAN${i + 1}:SCAL ${v}`] : []));
    if (!fix.length) return bodeTone(pair[0], pair[1], f);
    if (!(await ctl(fix))) return null;
    next.forEach((v, i) => (vdiv[i] = v));
  }
  return null;
}

// Throws (ending the sweep) when the device refuses the point or the generator stopped by itself:
// the firmware halts the output on a DAC underrun (-240) and the pin then carries something else.
async function sweepPoint(f: number, vdiv: number[], probe: number[], prevF?: number) {
  const tb = bodeTimebase(f);
  if (!(await ctl(pointCmds(f, tb, prevF && bodeTimebase(prevF))))) throw new Error(get().error ?? 'the device refused the point');
  await sleep(Math.max(80, 5000 / f)); // settle: ≥ 5 periods
  const p = await measurePoint(f, tb, vdiv, probe);
  // ponytail: from the firmware source (output.cpp halt() clears what OUTP? reports); no underrun was seen
  // on 0.21.14 to confirm it on hardware.
  const [out] = await link.texts(['OUTP?']);
  if (!on(out)) throw new Error('the generator output turned off (DAC underrun?)');
  return p;
}

// What the sweep changes, read before it starts; the trigger type only where the firmware has it.
async function readSaved(qual: boolean): Promise<Saved> {
  const keys = Object.keys(SAVE_Q) as (keyof typeof SAVE_Q)[];
  const vals = await link.texts([...Object.values(SAVE_Q), ...(qual ? ['TRIG:MODE?'] : [])]);
  return { ...Object.fromEntries(keys.map((k, i) => [k, vals[i]])), mode: qual ? vals[keys.length] : '' } as Saved;
}

export async function bodeSweep() {
  if (get().profile !== 'DS1052') return fail('Bode needs the scope profile.');
  const { model, gen: g0, bode: b } = get();
  const freqs = bodePlan(b.start, Math.min(b.stop, bodeMaxHz(model, g0.amp, get().idn?.fw)), b.ppd);
  get().patch('bode', { running: true, progress: 0, at: null, points: [] });
  let restore: string[] = [];
  let skipped = 0;
  try {
    const qual = fwHas(get().idn?.fw, 'qualTrig');
    const saved = await readSaved(qual);
    restore = scopeRestore(saved);
    // Both channels start at 1 V/div (× probe), not where the scope was left: on the same signal they then
    // range alike (different ranges disagree by up to 0.5 dB on a ZT703S), and from there a small signal
    // jumps straight to its range while a clipping one climbs a step per record.
    const probe = [num(saved.p1) || 1, num(saved.p2) || 1];
    const vdiv = probe.map((p) => nearest(VDIV_MV.map((m) => (m * p) / 1000), p));
    forgetWav();
    await link.run(['WAV:MODE RAW', 'WAV:FORM BYTE']);
    if (!(await ctl([`SOUR:FREQ ${freqs[0]}`, 'SOUR:FUNC SINusoid', 'OUTP ON', ...sweepScope(qual), `CHAN1:SCAL ${vdiv[0]}`, `CHAN2:SCAL ${vdiv[1]}`]))) return;
    for (let k = 0; k < freqs.length && sweeping(); k++) {
      get().patch('bode', { at: freqs[k] });
      const p = await sweepPoint(freqs[k], vdiv, probe, freqs[k - 1]);
      if (p) get().patch('bode', { points: [...get().bode.points, p] });
      else if (sweeping()) skipped++;
      get().patch('bode', { progress: (k + 1) / freqs.length });
    }
  } catch (e) {
    if (!link.closed) fail(`Bode sweep stopped: ${errText(e)}`);
  } finally {
    get().patch('bode', { at: null });
    await link.run(['WAV:SNAP']).catch(() => {});
    await ctl([...genRestore(g0, model), ...restore]);
    await readGen(true);
    get().patch('bode', { running: false, stopping: false });
  }
  if (skipped) fail(`Bode: ${skipped} point(s) skipped: no clean CH1/CH2 frame pair, or the range never settled.`);
}

// Only asks: `running` keeps the Bode panel and the mode tabs locked until the device is restored.
export const bodeStop = () => get().patch('bode', { stopping: true });
