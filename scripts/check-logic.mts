// Self-check for the pure logic: typed frequency, DMM scaling, Bode maths/plan/restore,
// scope measurements and generator command order. Run: `npm run check`.
import assert from 'node:assert/strict';
import { bodePlan, parseHz, scaleFor, VDIV_MV } from '../src/device.ts';
import { gainPhase, measure, type Frame } from '../src/dsp.ts';
import { pointCmds, rerange, scopeRestore, SWEEP_SCOPE } from '../src/io/bode.ts';
import { genDiff } from '../src/io/gen.ts';
import { useDev } from '../src/store.ts';

let checks = 0;
const near = (got: number, want: number, tol: number, what: string) => {
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} ± ${tol}`);
  checks++;
};

// --- parseHz: k/K kilo, m milli, M mega; junk is null --------------------------------------
for (const [text, hz] of [
  ['10k', 1e4], ['10K', 1e4], ['10 kHz', 1e4], ['2.5MHz', 2.5e6], ['500 mHz', 0.5], ['1e3', 1e3],
  ['1.0000 kHz', 1e3], ['.5k', 500], ['50', 50], ['1.2.3', null], ['abc', null], ['', null], ['0', null], ['-5', null],
] as const) {
  assert.equal(parseHz(text), hz, `parseHz("${text}")`);
  checks++;
}

// --- scaleFor: prefix and decimals from the range maximum (25000 / 66000 counts) -----------
for (const [ref, base, unit, dp] of [
  [2.5, 'V', 'V', 4], [25, 'V', 'V', 3], [0.25, 'V', 'mV', 2], [0.025, 'V', 'mV', 3], [6.6, 'V', 'V', 4],
  [9.999e-9, 'F', 'nF', 3], [99.99e-3, 'F', 'mF', 2], [25e6, 'Ω', 'MΩ', 3], [100, '°C', '°C', 1],
] as const) {
  const s = scaleFor(ref, base);
  assert.deepEqual([s.unit, s.dp], [unit, dp], `scaleFor(${ref}, ${base})`);
  checks++;
}

// --- bodePlan: log-spaced, both ends included ---------------------------------------------
{
  const p = bodePlan(10, 100_000, 10);
  assert.equal(p.length, 41);
  near(p[0], 10, 1e-9, 'plan start');
  near(p.at(-1)!, 100_000, 1e-6, 'plan stop');
  near(p[10], 100, 1e-9, 'plan one decade in');
}

// --- gainPhase: a known −6 dB / −45° pair, over a non-integer number of periods ------------
const frame = (ch: 0 | 1, n: number, xinc: number, fn: (t: number) => number): Frame =>
  ({ ch, seq: 1, xinc, xorig: -n * xinc * 0.3, volts: Float32Array.from({ length: n }, (_, i) => fn(-n * xinc * 0.3 + i * xinc)) });
{
  const f = 1234, w = 2 * Math.PI * f;
  const inp = frame(0, 4096, 1e-6, (t) => 1.0 * Math.cos(w * t) + 0.2);
  const out = frame(1, 4096, 1e-6, (t) => 0.5 * Math.cos(w * t - Math.PI / 4) - 0.1);
  const r = gainPhase(inp, out, f);
  near(r.db, 20 * Math.log10(0.5), 0.05, 'gain dB');
  near(r.ph, -45, 0.5, 'phase deg');
  near(gainPhase(out, inp, f).ph, 45, 0.5, 'phase sign flips');
}

// --- measure: 1 kHz square, 30 % duty, 0…3.3 V --------------------------------------------
{
  const sq = frame(0, 4096, 1e-6, (t) => (((t * 1000) % 1 + 1) % 1 < 0.3 ? 3.3 : 0));
  const m = measure(sq);
  near(m.freq, 1000, 10, 'square freq');
  near(m.duty, 30, 1, 'square duty');
  near(m.vpp, 3.3, 1e-6, 'square vpp');
  near(m.mean, 0.99, 0.05, 'square mean');
}

// --- genDiff: SOUR:FUNC must never be sent while the frequency is over the new shape's limit
{
  const g = useDev.getState().gen;
  assert.deepEqual(genDiff({ ...g, shape: 'SQU', freq: 1e6 }, { ...g, shape: 'SIN', freq: 343_999 }, 'ZT703S'), ['SOUR:FREQ 343999', 'SOUR:FUNC SINusoid']);
  assert.deepEqual(genDiff({ ...g, shape: 'SIN', freq: 1e3 }, { ...g, shape: 'SQU', freq: 5e5 }, 'ZT703S'), ['SOUR:FUNC SQUare', 'SOUR:FREQ 500000']);
  // ZT706S: lower amplitude before the shape/frequency change, higher after; no DAC level commands.
  assert.deepEqual(genDiff({ ...g, amp: 5, freq: 1e3 }, { ...g, amp: 3, freq: 8e6 }, 'ZT706S'), ['SOUR:VOLT 3.0', 'SOUR:FREQ 8000000']);
  assert.deepEqual(genDiff({ ...g, amp: 3, freq: 8e6 }, { ...g, amp: 5, freq: 1e3 }, 'ZT706S'), ['SOUR:FREQ 1000', 'SOUR:VOLT 5.0']);
  assert.deepEqual(genDiff(g, { ...g, low: 100, out: true }, 'ZT706S'), ['OUTP ON']);
  assert.deepEqual(genDiff(g, { ...g, low: 100, out: true }, 'ZT703S'), ['SOUR:LEV:LOW 100', 'OUTP ON']);
  checks += 6;
}

// --- Bode re-range: one step up on clipping, down when tiny, else exactly unchanged ---------
{
  const sine = (amp: number) => frame(0, 1000, 1e-5, (t) => amp * Math.sin(2 * Math.PI * 1000 * t));
  const steps = VDIV_MV.map((m) => m / 1000), i1v = steps.indexOf(1);
  assert.deepEqual(rerange([sine(4.5), sine(0.5), sine(2)], [1, 1, 1.0000001], [1, 1, 1]), [steps[i1v + 1], steps[i1v - 1], 1.0000001]);
  checks++;
}

// --- Bode restore covers everything the sweep touches on the scope -------------------------
{
  const head = (c: string) => c.split(' ')[0];
  const touched = new Set([...SWEEP_SCOPE, ...pointCmds(1000, 1e-3), 'CHAN1:SCAL 1', 'CHAN2:SCAL 1'].map(head).filter((h) => !h.startsWith('SOUR') && h !== 'RUN'));
  const saved = {
    tb: '0.001', hoff: '0', swe: 'NORMal', stat: 'STOP', src: 'CHAN2', d1: '1', d2: '0',
    s1: '0.5', s2: '2', o1: '0.1', o2: '-0.4', p1: '10', p2: '1',
  };
  const restore = scopeRestore(saved);
  for (const h of touched) assert.ok(restore.some((c) => head(c) === h), `restore misses ${h}`);
  assert.ok(restore.includes('TRIG:SWE NORM') && restore.includes('TRIG:EDGE:SOUR CHAN2') && restore.at(-1) === 'STOP', restore.join('; '));
  assert.ok(scopeRestore({ ...saved, swe: 'SINGle', stat: 'WAIT' }).at(-1) === 'SING', 'single is restored with SING');
  assert.ok(!scopeRestore({ ...saved, s1: '' }).some((c) => c.startsWith('CHAN1:SCAL')), 'missing value is skipped');
  checks += 4;
}

console.log(`check-logic: ${checks} checks passed`);
