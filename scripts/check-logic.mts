// Self-check for the pure logic: typed frequency, DMM scaling, Bode maths/plan/restore,
// scope measurements and generator command order. Run: `npm run check`.
import assert from 'node:assert/strict';
import { bodeEta, bodePlan, fmtStable, fwAtLeast, genMaxHz, interleaveBlockers, parseHz, scaleFor, seenRef, VDIV_MV } from '../src/device.ts';
import { addStat, emptyStats, FFT_WINDOWS, fftNotes, fftSpanHz, bodeTone, findPeak, histogram, spanAtLeast, unwrapPhase, measure, peakIn, peakNear, spectrum, spectrumOf, stdDev, yFloor, type FftWindow, type Frame } from '../src/dsp.ts';
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

const frame = (ch: 0 | 1, n: number, xinc: number, fn: (t: number) => number): Frame =>
  ({ ch, seq: 1, xinc, xorig: -n * xinc * 0.3, volts: Float32Array.from({ length: n }, (_, i) => fn(-n * xinc * 0.3 + i * xinc)) });

// --- bodeEta: from each point's record, so slow points dominate --------------------------
{
  const low = bodePlan(1, 100_000, 10), eta = bodeEta(low, 'ZT703S'), slow = bodeEta(low.filter((f) => f < 10), 'ZT703S');
  assert.ok(slow > eta / 2, `points below 10 Hz dominate: ${slow} of ${eta} s`);
  assert.ok(bodeEta(bodePlan(1000, 100_000, 10), 'ZT703S') < 120, 'a 1 kHz–100 kHz sweep stays under 2 min');
  assert.ok(bodeEta([1000], 'ZT706S') > bodeEta([1000], 'ZT703S'), 'ZT706S waits for its module');
  checks += 3;
}

// --- bodeTone: −6 dB / −45° with DC, non-whole periods, generator 0.1 % off the request ----
{
  const req = 37, f = req * 1.001, w = 2 * Math.PI * f, n = 20_000, xinc = 2.5e-5; // 18.5 periods
  const inp = frame(0, n, xinc, (t) => 1.0 * Math.cos(w * t) + 0.2);
  const out = frame(1, n, xinc, (t) => 0.5 * Math.cos(w * t - Math.PI / 4) - 0.1);
  const r = bodeTone(inp, out, req);
  near(r.db, 20 * Math.log10(0.5), 0.05, 'tone gain dB');
  near(r.ph, -45, 0.2, 'tone phase deg');
  near(r.f, f, f * 1e-4, 'tone frequency is the played one');
  near(bodeTone(out, inp, req).ph, 45, 0.2, 'tone phase sign flips');
  // 8-bit samples (25 codes/div at 1 V/div) with ±0.5 code of noise before rounding.
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
  const q = (x: number) => Math.round(x / 0.04 + rnd()) * 0.04;
  const qi = frame(0, n, xinc, (t) => q(1.0 * Math.cos(w * t) + 0.2)), qo = frame(1, n, xinc, (t) => q(0.5 * Math.cos(w * t - Math.PI / 4) - 0.1));
  const rq = bodeTone(qi, qo, req);
  near(rq.db, 20 * Math.log10(0.5), 0.1, 'quantised tone gain dB');
  near(rq.ph, -45, 0.5, 'quantised tone phase deg');
}

// --- unwrapPhase: no step over 180° between neighbours ------------------------------------
assert.deepEqual(unwrapPhase([-170, 175, 160]), [-170, -185, -200]);
assert.deepEqual(unwrapPhase([10, -20, -90, -150]), [10, -20, -90, -150]);
assert.deepEqual(unwrapPhase([170, -170]), [170, 190]);
assert.deepEqual(unwrapPhase([]), []);
assert.deepEqual(unwrapPhase([42]), [42]);
checks += 5;

// --- spanAtLeast: Bode axes never magnify noise, never cut data ---------------------------
{
  const [lo, hi] = spanAtLeast(-0.12, -0.03, 6);
  assert.ok(hi - lo >= 6 - 1e-9 && lo <= -0.12 && hi >= -0.03, `flat gain axis ${lo}…${hi}`);
  assert.deepEqual(spanAtLeast(-40, 0, 6), [-40, 0]);
  assert.deepEqual(spanAtLeast(Number.NaN, Number.NaN, 90), [-45, 45]);
  checks += 3;
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

// --- spectrum: every sample, mean removed; a bin-centred 1.5 V sine on 2 V reads 1.5 V ------
{
  const L = 3000, N = 4096, bin = 256, phase = (i: number) => (2 * Math.PI * bin * i) / N;
  const v = Float32Array.from({ length: L }, (_, i) => 1.5 * Math.sin(phase(i)) + 2);
  for (const w of FFT_WINDOWS) {
    const amp = spectrum(v, w);
    assert.equal(amp.length, N / 2, `${w}: ${L} samples padded to ${N}`);
    near(amp[bin], 1.5, 0.03, `${w} sine amplitude within 2 %`);
    near(amp[0], 0, 0.02, `${w} DC removed`);
  }
  const tail = Float32Array.from({ length: L }, (_, i) => (i < 2048 ? 0 : Math.sin(phase(i))));
  assert.ok(spectrum(tail, 'RECT')[bin] > 0.2, 'samples past the last power of two contribute');
  checks++;

  const dt = 1 / 6.25e6;
  const amp = spectrum(Float32Array.from({ length: 62_500 }, (_, i) => Math.sin(2 * Math.PI * 150e3 * i * dt)), 'HANN');
  let top = 1;
  for (let k = 2; k < amp.length; k++) if (amp[k] > amp[top]) top = k;
  near(top / (2 * amp.length * dt), 150e3, 48, '150 kHz at 6.25 MSa/s peaks at 150 kHz');
}

// --- findPeak: interpolated between bins; withheld or ≈ where it can't be trusted -----------
const wave = (L: number, fn: (i: number) => number): Frame =>
  ({ ch: 0, seq: 1, xinc: 1e-6, xorig: 0, volts: Float32Array.from({ length: L }, (_, i) => fn(i)) });
// 1 V sine with `periods` periods in L samples, so its frequency is `periods` resolutions.
const tonePk = (L: number, periods: number, win: FftWindow, phase = 0) => {
  const s = spectrumOf(wave(L, (i) => Math.sin((2 * Math.PI * periods * i) / L + phase) + 0.5), win);
  return { s, p: findPeak(s, 1, win) };
};
{
  for (const [win, tol] of [['HANN', 0.05], ['BLACK', 0.05], ['HAMM', 0.06]] as const) {
    let worstHz = 0, worstLevel = 0;
    for (const L of [1000, 600]) { // barely and heavily zero-padded
      for (let periods = 5; periods < L / 2 - 2.1; periods += 0.37) {
        for (const phase of [0, 1, 2]) {
          const { s, p } = tonePk(L, periods, win, phase);
          assert.deepEqual([p.withheld, p.approxHz], [null, false], `${win} L=${L} ${periods} periods`);
          if (periods >= 5.1) assert.equal(p.approxLevel, false, `${win} L=${L} ${periods} periods is exact`); // boundary ± the error
          worstHz = Math.max(worstHz, Math.abs(p.hz / s.resHz - periods));
          worstLevel = Math.max(worstLevel, Math.abs(p.amp - 1));
        }
      }
    }
    near(worstHz, 0, 0.1, `${win} worst frequency error in resolutions`);
    near(worstLevel, 0, tol, `${win} worst level error`);
  }
  for (const phase of [0, 1, 2, 3]) assert.equal(tonePk(1000, 1.5, 'HANN', phase).p.withheld, 'low', `1.5 periods, phase ${phase}`);
  const few = tonePk(1000, 3, 'HANN').p;
  assert.deepEqual([few.withheld, few.approxHz, few.approxLevel, few.fewPeriods], [null, false, true, true], '3 periods');
  assert.equal(tonePk(1000, 499, 'HANN').p.withheld, 'limit', '1 resolution below half rate');
  const rect = tonePk(1000, 20.5, 'RECT').p;
  assert.deepEqual([rect.withheld, rect.approxHz, rect.approxLevel, rect.fewPeriods], [null, true, true, false], 'Rect is approximate');
  const noise = spectrumOf(wave(1000, (i) => 0.01 * Math.sin(i * i * 12.9898)), 'HANN');
  assert.equal(findPeak(noise, 1, 'HANN').withheld, 'none', 'noise far below vdiv/50');

  const { s } = tonePk(1000, 20.3, 'HANN'), at = (20.3 * s.resHz) / s.binHz;
  near(peakIn(s.amp, 14, 22)!.bin, at, 0.1, 'a range holding the peak off-centre finds it');
  assert.equal(peakIn(s.amp, 14, 18)!.bin, 18, 'a range on the slope gives its highest bin, not an extrapolation');
  assert.equal(peakIn(Float32Array.of(9, 1, 2, 1), 0, 3)!.bin, 2, 'never bin 0');
  assert.equal(peakIn(s.amp, s.amp.length, s.amp.length + 5), null, 'a range past the end is empty');
  checks += 10;
}

// --- fftNotes: one id per condition, in the order the panel lists them -----------------------
{
  const peak = tonePk(1000, 20.5, 'HANN').p; // 20.5 kHz
  const fine = { samples: 1000, screen: 1000, clipped: false, swing: 4, vdiv: 1, peak, spanHz: 1e5 };
  assert.deepEqual(fftNotes(fine), [], 'nothing wrong, no notes');
  for (const [change, ids] of [
    [{ screen: 2000 }, ['partial']],
    [{ clipped: true }, ['clipped']],
    [{ swing: 0.25 }, ['small']],
    [{ samples: 63, screen: 63, peak: null }, ['few']],
    [{ peak: { ...peak, withheld: 'low', fewPeriods: true } }, ['low']],
    [{ peak: { ...peak, withheld: 'limit' } }, ['limit']],
    [{ peak: { ...peak, fewPeriods: true } }, ['periods']],
    [{ peak: { ...peak, approxHz: true } }, ['rect']],
    [{ spanHz: 1e4 }, ['beyond']],
    [{ spanHz: 1e4, peak: { ...peak, withheld: 'none' } }, []],
    [{ spanHz: 1e4, screen: 2000, clipped: true, peak: { ...peak, fewPeriods: true, approxHz: true } }, ['partial', 'clipped', 'periods', 'rect', 'beyond']],
  ] as const) {
    assert.deepEqual(fftNotes({ ...fine, ...change }), ids, ids.join() || 'no signal is not "beyond the view"');
  }
  checks += 12;
}

// --- fftSpanHz: Auto shows 1000 resolution steps, never past half the sample rate ------------
{
  const at = (samples: number, xinc: number) => spectrumOf({ ch: 0, seq: 1, xinc, xorig: 0, volts: new Float32Array(samples) }, 'HANN');
  const slow = at(62_500, 1 / 6.25e6); // 1 ms/div: 10 ms on screen
  near(fftSpanHz(slow, 'AUTO'), 100_000, 1e-6, 'Auto span for 10 ms at 6.25 MSa/s');
  near(fftSpanHz(slow, 'FULL'), 3.125e6, 1e-6, 'Full span is half the sample rate');
  near(fftSpanHz(at(1000, 1e-6), 'AUTO'), 500_000, 1e-6, 'Auto stops at half the sample rate');
}

// --- peakNear: what a marker reads; nothing above half the sample rate -----------------------
{
  const { s } = tonePk(1000, 20.3, 'HANN'); // 20.3 kHz, resolution 1 kHz
  const on = peakNear(s, 19_500, 1000)!;
  near(on.hz, 20_300, 100, 'a marker next to a peak reads the peak');
  near(on.amp, 1, 0.05, 'and its level');
  assert.equal(peakNear(s, 600_000, 1000), null, 'above half the sample rate there is no value');
  assert.equal(peakNear(s, NaN, 1000), null, 'an unplaced marker reads nothing');
  checks += 2;
  const square = spectrumOf(wave(2000, (i) => ((i % 100) < 50 ? 1 : -1)), 'HANN'); // 10 kHz
  const a = peakNear(square, 10_000, 500)!, b = peakNear(square, 30_000, 500)!;
  near(b.hz - a.hz, 20_000, 50, 'ΔF from the fundamental to the third harmonic');
  near(20 * Math.log10(b.amp / a.amp), -9.5, 0.3, 'their level difference in dB');
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
    s1: '0.5', s2: '2', o1: '0.1', o2: '-0.4', p1: '10', p2: '1', c1: 'DC', c2: 'GND', roll: '1', mdep: '2.58048e+5',
  };
  const restore = scopeRestore(saved);
  // ACQ:MDEP? is the planned length: 258 048 sent back would select 512K (measured), so snap it.
  assert.ok(restore.includes('ACQ:MDEP 262144') && restore.includes('ACQ:ROLL ON') && restore.includes('CHAN1:COUP DC') && restore.includes('CHAN2:COUP GND'), restore.join('; '));
  const at = (h: string) => restore.findIndex((c) => c.startsWith(h));
  assert.ok(at('ACQ:MDEP') > at('CHAN1:DISP') && at('ACQ:MDEP') > at('CHAN2:DISP'), 'depth restored after the channels');
  assert.ok(!scopeRestore({ ...saved, c1: '', mdep: 'NAN' }).some((c) => c.startsWith('CHAN1:COUP') || c.startsWith('ACQ:MDEP')), 'unreported coupling/depth skipped');
  assert.ok(SWEEP_SCOPE.indexOf('ACQ:MDEP 32768') > SWEEP_SCOPE.indexOf('CHAN2:DISP ON'), 'sweep: 32 768 per channel of two = the 64K budget, the smallest');
  // ACQ:MDEP is per enabled channel (firmware RecordBudget::covering): 2 channels on a 64K budget report 32 768.
  const two = (mdep: string) => scopeRestore({ ...saved, d2: '1', mdep }).find((c) => c.startsWith('ACQ:MDEP'));
  assert.deepEqual([two('3.2768e+4'), two('1.26976e+5'), two('2.58048e+5')], ['ACQ:MDEP 32768', 'ACQ:MDEP 131072', 'ACQ:MDEP 262144']);
  checks += 5;
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
