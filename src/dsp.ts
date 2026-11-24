// Waveform maths on captured frames: Bode tone detection and the scope's browser-side
// measurements (the firmware only offers the frequency counter), plus DMM statistics and the
// trend's Y floor. Pure, no device access.
export type Frame = { ch: 0 | 1; seq: number; xinc: number; xorig: number; volts: Float32Array };

export function extent(v: Float32Array) {
  let mn = Infinity, mx = -Infinity;
  for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; }
  return { mn, mx };
}

// Amplitude and phase of the `f` component (single-bin DFT over a whole number of periods).
function tone(fr: Frame, f: number) {
  const n = fr.volts.length, per = 1 / (f * fr.xinc), whole = Math.floor(n / per);
  const N = whole >= 1 ? Math.min(n, Math.round(whole * per)) : n;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += fr.volts[i];
  mean /= N;
  let I = 0, Q = 0;
  for (let i = 0; i < N; i++) {
    const w = 2 * Math.PI * f * (fr.xorig + i * fr.xinc), v = fr.volts[i] - mean;
    I += v * Math.cos(w);
    Q += v * Math.sin(w);
  }
  return { amp: (2 / N) * Math.hypot(I, Q), ph: Math.atan2(-Q, I) };
}

// Gain (dB) and phase (degrees, −180…180) of `out` relative to `inp` at `f`.
export function gainPhase(inp: Frame, out: Frame, f: number) {
  const x = tone(inp, f), y = tone(out, f);
  const ph = ((((y.ph - x.ph) * 180) / Math.PI + 540) % 360) - 180;
  return { db: 20 * Math.log10(y.amp / x.amp), ph };
}

export type Meas = { vpp: number; mean: number; rms: number; freq: number; duty: number; rise: number };

// Rising crossings of `mid`, with hysteresis so noise on a slow edge counts once.
function risingEdges(v: Float32Array, mid: number, hyst: number): number[] {
  const rises: number[] = [];
  let armed = false;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < mid - hyst) armed = true;
    else if (armed && v[i] > mid + hyst) { armed = false; rises.push(i); }
  }
  return rises;
}

// Samples from `lo` to `hi` around the edge at index a (10–90 % rise).
function riseSamples(v: Float32Array, a: number, lo: number, hi: number): number {
  let i0 = a, i1 = a;
  while (i0 > 0 && v[i0] > lo) i0--;
  while (i1 < v.length - 1 && v[i1] < hi) i1++;
  return i1 - i0;
}

export function measure(f: Frame): Meas {
  const v = f.volts, n = v.length, { mn, mx } = extent(v), span = mx - mn, mid = (mn + mx) / 2;
  let s = 0, s2 = 0;
  for (const x of v) { s += x; s2 += x * x; }
  const rises = risingEdges(v, mid, span * 0.1);
  // One edge is enough for rise time (fast timebases show a single edge); period/duty need two.
  const rise = rises.length && span > 1e-6 ? riseSamples(v, rises[0], mn + 0.1 * span, mn + 0.9 * span) * f.xinc : NaN;
  let freq = NaN, duty = NaN;
  if (rises.length >= 2) {
    const a = rises[0], b = rises.at(-1)!;
    freq = (rises.length - 1) / ((b - a) * f.xinc);
    let high = 0;
    for (let i = a; i < b; i++) if (v[i] > mid) high++;
    duty = (100 * high) / (b - a);
  }
  return { vpp: span, mean: s / n, rms: Math.sqrt(s2 / n), freq, duty, rise };
}

// --- DMM: running statistics and the value histogram, O(1) per reading (never a rescan) -----

// `lsd` is the coarsest resolution seen (auto-range can change it); counts are keyed by the
// LSD-snapped value, so the map is bounded by distinct displayed values, not by session length.
export type DmmStats = { n: number; mean: number; m2: number; min: number; max: number; lsd: number; counts: Map<number, number> };
export const emptyStats = (): DmmStats => ({ n: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity, lsd: 0, counts: new Map() });

// Welford. Returns a new object (store identity moves) sharing the same counts Map.
export function addStat(s: DmmStats, v: number, lsd: number): DmmStats {
  const n = s.n + 1, d = v - s.mean, mean = s.mean + d / n, k = Math.round(v / lsd) * lsd;
  s.counts.set(k, (s.counts.get(k) ?? 0) + 1);
  return { n, mean, m2: s.m2 + d * (v - mean), min: Math.min(s.min, v), max: Math.max(s.max, v), lsd: Math.max(s.lsd, lsd), counts: s.counts };
}

export const stdDev = (s: DmmStats) => (s.n ? Math.sqrt(s.m2 / s.n) : 0); // population σ

export type Bin = { value: number; count: number; kind: 'under' | 'in' | 'over' };

// One bin per displayable value, centred on the most-counted one (or `center` when empty).
// Shows ±10 bins at least, grows to include data within ±100 bins; anything further collects
// into edge bins one step outside (`under` = ≤ its value, `over` = ≥) so a lone outlier doesn't
// flatten the distribution. Values stay unique and ascending, as an ordinal axis needs.
export function histogram(counts: Map<number, number>, width: number, center = 0): Bin[] {
  let best = -1;
  for (const [v, n] of counts) if (n > best) { best = n; center = v; }
  const cb = Math.round(center / width);
  let lo = cb - 10, hi = cb + 10;
  for (const [v] of counts) {
    const b = Math.round(v / width);
    if (Math.abs(b - cb) <= 100) { lo = Math.min(lo, b); hi = Math.max(hi, b); }
  }
  const inRange = new Array<number>(hi - lo + 1).fill(0);
  let under = 0, over = 0;
  for (const [v, n] of counts) {
    const b = Math.round(v / width);
    if (b < lo) under += n; else if (b > hi) over += n; else inRange[b - lo] += n;
  }
  const bins: Bin[] = inRange.map((count, i) => ({ value: (lo + i) * width, count, kind: 'in' }));
  if (under) bins.unshift({ value: (lo - 1) * width, count: under, kind: 'under' });
  if (over) bins.push({ value: (hi + 1) * width, count: over, kind: 'over' });
  return bins;
}

// Auto Y floor: the data extent, never narrower than ±20 counts around its middle, so a steady
// reading's ±1-count dither doesn't fill the plot. Real spread still widens it.
export function yFloor(min: number, max: number, lsd: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [-20 * lsd, 20 * lsd];
  const mid = (min + max) / 2, half = Math.max(20 * lsd, (max - min) / 2);
  return [mid - half, mid + half];
}
