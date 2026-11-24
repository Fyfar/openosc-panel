// Self-check for the pure logic: typed frequency, DMM scaling, Bode maths/plan/restore,
// scope measurements and generator command order. Run: `npm run check`.
import assert from 'node:assert/strict';
import { bodePlan, fmtStable, fwAtLeast, genMaxHz, interleaveBlockers, parseHz, scaleFor, seenRef, VDIV_MV } from '../src/device.ts';
import { addStat, emptyStats, FFT_WINDOWS, gainPhase, histogram, measure, spectrum, stdDev, yFloor, type Frame } from '../src/dsp.ts';
import { parseFrame, parseMeas, screenWindow } from '../src/io/scope.ts';
import { pointCmds, rerange, scopeRestore, SWEEP_SCOPE } from '../src/io/bode.ts';
import { dmmDiff } from '../src/io/dmm.ts';
import { genDiff } from '../src/io/gen.ts';
import { unsavedData, useDev } from '../src/store.ts';

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
  near(s.lsd, s.div * 10 ** -dp, 1e-18, `scaleFor(${ref}, ${base}).lsd`);
  checks++;
}

// --- seenRef: no ranges (continuity, diode) → scale from the largest reading so far, never shrinking
assert.equal(seenRef(0.2, { n: 3, min: 0, max: 5 }), 5, 'seenRef keeps the largest seen');
assert.equal(seenRef(-7, { n: 3, min: 0, max: 5 }), 7, 'seenRef grows with |v|');
assert.equal(seenRef(0, { n: 0, min: Infinity, max: -Infinity }), 1, 'seenRef with nothing seen');
checks += 3;

// --- DMM running stats: match a full rescan, counts keyed by display count -----------------
{
  const vals = [1.2344, 1.2345, 1.2345, 1.2346, 1.2345, 1.2391], lsd = 1e-4;
  let st = emptyStats();
  for (const v of vals) st = addStat(st, v, lsd);
  const mean = vals.reduce((a, b) => a + b) / vals.length;
  near(st.mean, mean, 1e-12, 'stats mean');
  near(stdDev(st), Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length), 1e-12, 'stats σ (population)');
  assert.deepEqual([st.n, st.min, st.max, st.counts.size], [6, 1.2344, 1.2391, 4], 'stats n/min/max/distinct');
  checks++;
  // 1.2345 ×3 is the centre, ±10 bins shown; 1.2391 is 46 counts out, still inside ±100.
  const bins = histogram(st.counts, lsd);
  const at = (v: number) => bins.find((b) => Math.round(b.value / lsd) === Math.round(v / lsd));
  assert.deepEqual([at(1.2345)?.count, at(1.2391)?.count, bins.reduce((a, b) => a + b.count, 0)], [3, 1, 6], 'histogram counts');
  near(bins[0].value, 1.2335, 1e-9, 'histogram left edge = centre − 10 counts');
  st = addStat(st, 1.3, lsd); // 655 counts out: an over-range edge bin, the window doesn't stretch
  const wide = histogram(st.counts, lsd);
  assert.deepEqual([wide.at(-1)?.kind, wide.at(-1)?.count, wide.length], ['over', 1, bins.length + 1], 'histogram over-range bin');
  near(wide.at(-1)!.value - wide.at(-2)!.value, lsd, 1e-12, 'over bin sits one step past the window (unique ordinal x)');
  assert.equal(histogram(new Map(), lsd, 5).length, 21, 'empty histogram frames the live value');
  checks += 4;
}

// --- dmmDiff cold junction: a value selects Manual on the meter; NONE (back to DC mV) is never sent
{
  const base = useDev.getState().dmm;
  assert.deepEqual(dmmDiff({ ...base, func: 'TEMP', cj: null }, { ...base, func: 'TEMP', cj: 21.5 }), ['SYST:DMM:TEMP:CJUN 21.5'], 'cj set');
  assert.deepEqual(dmmDiff({ ...base, func: 'TEMP', cj: 21.5 }, { ...base, func: 'TEMP', cj: null }), [], 'cj cleared sends nothing');
  checks += 2;
}

// --- yFloor: ±20-count floor on a steady reading, real spread kept as is --------------------
{
  const [lo, hi] = yFloor(1.2345, 1.2346, 1e-4);
  near(hi - lo, 40e-4, 1e-12, 'yFloor on a steady reading');
  assert.deepEqual(yFloor(0, 1, 1e-4), [0, 1], 'yFloor keeps a real spread');
  assert.deepEqual(yFloor(Infinity, -Infinity, 1e-4), [-20e-4, 20e-4], 'yFloor with no data');
  checks += 3;
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
  near(m.max, 3.3, 1e-6, 'square max');
  near(m.acRms, 3.3 * Math.sqrt(0.3 * 0.7), 0.05, 'square AC RMS');
  near(m.edges, 4, 0, 'square rising edges (4 periods)');
}

// --- spectrum: a bin-centred 1.5 V sine reads 1.5 V at its bin with every window ------------
{
  const N = 2048, bin = 64, v = Float32Array.from({ length: N }, (_, i) => 1.5 * Math.sin((2 * Math.PI * bin * i) / N) + 0.2);
  for (const w of FFT_WINDOWS) {
    const amp = spectrum(v, w);
    assert.equal(amp.length, N / 2);
    near(amp[bin], 1.5, 0.02, `${w} sine amplitude`);
    near(amp[0], 0.2, 0.02, `${w} DC bin (not doubled)`);
  }
}

// --- fmtStable: a reading hovering at a prefix edge keeps its unit and its width --------------
{
  const seq = (vals: number[], unit: string, digits: number) => {
    let exp: number | undefined;
    return vals.map((v) => { const r = fmtStable(v, unit, digits, exp); exp = r.exp; return r.text; });
  };
  assert.deepEqual(seq([1000.2, 999.8, 1000, 951, 940, 1000.1], 'Hz', 5),
    ['1.0002 kHz', '0.9998 kHz', '1.0000 kHz', '0.9510 kHz', '940.00 Hz', '1.0001 kHz']);
  assert.deepEqual(seq([0.1, 0.10004, 1.2, 0, -0.05], 'V', 4), ['100.0 mV', '100.0 mV', '1.200 V', '0.000 V', '-50.00 mV']);
  assert.equal(fmtStable(999.996, 'Hz', 5).text, '1.0000 kHz', 'rounding up to 1000 moves the prefix');
  assert.equal(fmtStable(NaN, 'V', 4, -3).text, '—');
  assert.equal(fmtStable(0, 'V', 4).text, '0.000 V', 'zero on the first call (grounded input, cursors together)');
  assert.equal(fmtStable(2e-7, 's', 4).text, '200.0 ns');
  checks += 6;
}

// --- firmware gating: version compare and the ZT703S DAC limit from 0.21.8 -------------------
for (const [fw, min, want] of [
  ['0.21.9', '0.21.9', true], ['0.21.10', '0.21.9', true], ['0.21.8', '0.21.9', false], ['0.22.0', '0.21.9', true],
  ['0.21.9-dirty', '0.21.9', true], ['', '0.21.9', false], [undefined, '0.21.8', false],
] as const) {
  assert.equal(fwAtLeast(fw, min), want, `fwAtLeast(${fw}, ${min})`);
  checks++;
}
assert.equal(genMaxHz('ZT703S', '0.21.8').SIN, 223_214);
assert.equal(genMaxHz('ZT703S', '0.21.8').POS, 223_214);
assert.equal(genMaxHz('ZT703S', '0.21.8').HALF, 129_000);
assert.equal(genMaxHz('ZT703S', '0.21.7').SIN, 343_999);
assert.equal(genMaxHz('ZT706S', '0.21.9').SIN, 10_000_000);
assert.deepEqual(interleaveBlockers(4 | 8 | 64), ['timebase', 'not CH1 alone', 'generator DAC']);
checks += 6;

// --- screenWindow: 10 div around the trigger; untriggered (origin 0 or rounding dust) uses TRIG:POS
{
  const tb = 10; // TIMEBASES[10] = 20 µs/div → 200 µs screen = 2000 samples at 100 MSa/s
  const s = { tb, trig: { src: 1, slope: 'POS', level: 0, nrej: false, pos: 50 } } as const;
  assert.deepEqual(screenWindow(65536, 1e-7, -1e-7 * 30000, s), { first: 29000, end: 31000 }, 'triggered at 30000');
  assert.deepEqual(screenWindow(65536, 1e-7, 0, s), { first: 31768, end: 33768 }, 'untriggered: record centre');
  assert.deepEqual(screenWindow(65536, 1e-7, -1e-21, s), { first: 31768, end: 33768 }, 'origin rounding dust is untriggered');
  assert.deepEqual(screenWindow(1000, 1e-7, 0, s), { first: 0, end: 1000 }, 'record shorter than the screen');
  checks += 4;
}

// --- parseFrame: WAV:FRAM? block with a STR channel and a PEAK channel (bytes may be 0x0a) -----
{
  const enc = new TextEncoder();
  const head = enc.encode('42,2\nCHAN1,0,0,3,1,1e-6,-2e-6,0,0.1,0,128\nCHAN2,0,1,2,1,2e-6,0,0,0.5,-28,128\n');
  const data = Uint8Array.from([128, 138, 10, /* CH2 pairs */ 10, 120, 100, 110]);
  const fr = parseFrame(Uint8Array.from([...head, ...data]));
  assert.equal(fr.length, 2);
  assert.deepEqual([fr[0].ch, fr[0].seq, fr[0].xinc, fr[0].xorig], [0, 42, 1e-6, -2e-6]);
  assert.deepEqual([...fr[0].volts].map((v) => +v.toFixed(3)), [0, 1, -11.8]);
  assert.equal(fr[0].lo, undefined, 'STR frame has no envelope');
  assert.deepEqual([...fr[1].lo!], [-45, 0], 'PEAK min: (code − 128 − (−28)) × 0.5');
  assert.deepEqual([...fr[1].hi!], [10, 5]);
  assert.deepEqual([...fr[1].volts], [-17.5, 2.5], 'PEAK volts = bucket midpoint');
  assert.throws(() => parseFrame(Uint8Array.from([...head, 1, 2])), /cut short/);
  checks += 7;
}

// --- parseMeas: WAV:MEAS? field order; NAN stays NaN ----------------------------------------
{
  const m = parseMeas('1000,3.3,1.8,0.001,0.99,0,3.3,1.5,30,10,NAN,1000.2,3.28,3.29,0.01,1,EDGE')!;
  assert.deepEqual([m.freq, m.vpp, m.rms, m.period, m.mean, m.min, m.max, m.acRms, m.duty, m.edges], [1000, 3.3, 1.8, 0.001, 0.99, 0, 3.3, 1.5, 30, 10]);
  assert.deepEqual([m.amp, m.top, m.base, m.clipped, m.src], [3.28, 3.29, 0.01, true, 'EDGE']);
  assert.ok(Number.isNaN(parseMeas('NAN,1,1,NAN,0,0,0,0,NAN,0,NAN,NAN,NAN,NAN,NAN,0,NONE')!.freq));
  assert.equal(parseMeas('NAN'), null, 'a failed query (-230) gives no readouts');
  checks += 4;
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

// --- unsavedData: the reload/close guard fires exactly when a log or Bode result would be lost
const s0 = useDev.getInitialState();
for (const [s, want, what] of [
  [s0, false, 'fresh state'],
  [{ ...s0, logging: true }, false, 'logging armed, no rows yet'],
  [{ ...s0, logged: 1 }, true, 'DMM log rows'],
  [{ ...s0, bode: { ...s0.bode, running: true } }, true, 'Bode sweep running'],
  [{ ...s0, bode: { ...s0.bode, points: [{ f: 1, db: 0, ph: 0 }] } }, true, 'Bode result'],
] as const) {
  assert.equal(unsavedData(s), want, `unsavedData: ${what}`);
  checks++;
}

console.log(`check-logic: ${checks} checks passed`);
