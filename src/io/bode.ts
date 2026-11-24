// Bode: host-side sweep. Generator sine → DUT; CH1 = DUT input, CH2 = DUT output.
import { bodeMaxHz, bodePlan, MODELS, TIMEBASES, VDIV_MV, type Model } from '../device';
import { extent, gainPhase, type Frame } from '../dsp';
import { sleep } from '../link';
import type { State } from '../store';
import { ctl, errText, fail, get, link, nearest, num, on } from './core';
import { readGen, SHAPE_CMD } from './gen';
import { fetchChannel } from './scope';

// The sweep's scope setup, and what each point sends. Everything these touch (plus the
// CHANn:SCAL re-ranging) must be put back by scopeRestore: scripts/check-logic.mts checks it.
export const SWEEP_SCOPE = ['CHAN1:DISP ON', 'CHAN2:DISP ON', 'CHAN1:OFFS 0', 'CHAN2:OFFS 0', 'TRIG:EDGE:SOUR CHAN1', 'TRIG:SWE AUTO', 'RUN'];
export const pointCmds = (f: number, tb: number) => [`SOUR:FREQ ${+f.toPrecision(6)}`, `TIM:SCAL ${tb}`, 'TIM:OFFS 0'];

const SAVE_Q = {
  tb: 'TIM:SCAL?', hoff: 'TIM:OFFS?', swe: 'TRIG:SWE?', stat: 'TRIG:STAT?', src: 'TRIG:EDGE:SOUR?',
  d1: 'CHAN1:DISP?', d2: 'CHAN2:DISP?', s1: 'CHAN1:SCAL?', s2: 'CHAN2:SCAL?', o1: 'CHAN1:OFFS?', o2: 'CHAN2:OFFS?',
  p1: 'CHAN1:PROB?', p2: 'CHAN2:PROB?',
};
type Saved = Record<keyof typeof SAVE_Q, string>;

// Puts the scope back as it was before the sweep. Values the device didn't report are skipped.
export function scopeRestore(s: Saved): string[] {
  const n = (x: string) => (Number.isFinite(num(x)) ? +num(x).toPrecision(6) : null);
  const val = (head: string, x: string) => (n(x) === null ? [] : [`${head} ${n(x)}`]);
  const swe = s.swe.toUpperCase();
  return [
    `CHAN1:DISP ${on(s.d1) ? 'ON' : 'OFF'}`, `CHAN2:DISP ${on(s.d2) ? 'ON' : 'OFF'}`,
    ...val('CHAN1:SCAL', s.s1), ...val('CHAN2:SCAL', s.s2), ...val('CHAN1:OFFS', s.o1), ...val('CHAN2:OFFS', s.o2),
    ...val('TIM:SCAL', s.tb), ...val('TIM:OFFS', s.hoff),
    `TRIG:EDGE:SOUR CHAN${s.src.endsWith('2') ? 2 : 1}`,
    // Single is the SING command, never TRIG:SWE SING (see scopeRun).
    ...(swe.startsWith('SING') ? ['SING'] : [`TRIG:SWE ${swe.startsWith('NORM') ? 'NORM' : 'AUTO'}`]),
    ...(s.stat.toUpperCase().startsWith('STOP') ? ['STOP'] : []),
  ];
}

const genRestore = (g: State['gen'], model: Model) => [
  // SOUR:FUNC is refused above the shape's limit, so bring the frequency under it first.
  `OUTP ${g.out ? 'ON' : 'OFF'}`, `SOUR:FREQ ${Math.min(g.freq, MODELS[model].maxHz[g.shape])}`, `SOUR:FUNC ${SHAPE_CMD[g.shape]}`, `SOUR:FREQ ${g.freq}`,
];

// Next V/div per channel: a step up when it clips (> ±3.8 div), a step down when it is tiny
// (< 1.5 div p-p), else unchanged.
export function rerange(frames: Frame[], vdiv: number[], probe: number[]): number[] {
  return frames.map((fr, i) => {
    const { mn, mx } = extent(fr.volts);
    const peak = Math.max(Math.abs(mn), Math.abs(mx)) / vdiv[i], pp = (mx - mn) / vdiv[i];
    const steps = VDIV_MV.map((m) => (m * probe[i]) / 1000);
    const idx = steps.indexOf(nearest(steps, vdiv[i]));
    const want = peak > 3.8 ? Math.min(steps.length - 1, idx + 1) : pp < 1.5 ? Math.max(0, idx - 1) : idx;
    return want === idx ? vdiv[i] : steps[want];
  });
}

// One point from a CH1/CH2 pair of the same frame. A channel that clips or is tiny is
// re-ranged and the point retried. Null when no clean pair came in 5 tries.
async function measurePoint(f: number, vdiv: number[], probe: number[]) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await link.run(['WAV:SNAP']); // release, so the next frame is captured after the change
    await fetchChannel(0, 4096, 5000); // discard one frame
    const a = await fetchChannel(0, 4096, 5000);
    const c = await fetchChannel(1, 4096, 5000);
    if (a.seq !== c.seq) continue;
    const next = rerange([a, c], vdiv, probe);
    const fix = next.flatMap((v, i) => (v !== vdiv[i] ? [`CHAN${i + 1}:SCAL ${v}`] : []));
    if (!fix.length) return { f, ...gainPhase(a, c, f) };
    if (!(await ctl(fix))) return null;
    next.forEach((v, i) => (vdiv[i] = v));
    await sleep(100);
  }
  return null;
}

async function sweepPoint(f: number, vdiv: number[], probe: number[]) {
  const tb = TIMEBASES.find((t) => t * 10 >= 4 / f) ?? TIMEBASES.at(-1)!; // ≥ 4 periods on screen
  await ctl(pointCmds(f, tb));
  await sleep(Math.max(80, 5000 / f)); // settle: ≥ 5 periods
  return measurePoint(f, vdiv, probe);
}

export async function bodeSweep() {
  if (get().profile !== 'DS1052') return fail('Bode needs the scope profile.');
  const { model, gen: g0, bode: b } = get();
  const freqs = bodePlan(b.start, Math.min(b.stop, bodeMaxHz(model, g0.amp)), b.ppd);
  get().patch('bode', { running: true, progress: 0, points: [] });
  let restore: string[] = [];
  let skipped = 0;
  try {
    const keys = Object.keys(SAVE_Q) as (keyof Saved)[];
    const vals = await link.texts(Object.values(SAVE_Q));
    const saved = Object.fromEntries(keys.map((k, i) => [k, vals[i]])) as Saved;
    restore = scopeRestore(saved);
    const vdiv = [num(saved.s1) || 1, num(saved.s2) || 1], probe = [num(saved.p1) || 1, num(saved.p2) || 1];
    await link.run(['WAV:MODE RAW', 'WAV:FORM BYTE']);
    if (!(await ctl([`SOUR:FREQ ${freqs[0]}`, 'SOUR:FUNC SINusoid', 'OUTP ON', ...SWEEP_SCOPE]))) return;
    for (let k = 0; k < freqs.length && get().bode.running; k++) {
      const p = await sweepPoint(freqs[k], vdiv, probe);
      if (p) get().patch('bode', { points: [...get().bode.points, p] });
      else skipped++;
      get().patch('bode', { progress: (k + 1) / freqs.length });
    }
  } catch (e) {
    if (!link.closed) fail(`Bode sweep stopped: ${errText(e)}`);
  } finally {
    await link.run(['WAV:SNAP']).catch(() => {});
    await ctl([...genRestore(g0, model), ...restore]);
    await readGen(true);
    get().patch('bode', { running: false });
  }
  if (skipped) fail(`Bode: ${skipped} point(s) skipped, no clean CH1/CH2 frame pair.`);
}

export const bodeStop = () => get().patch('bode', { running: false });
