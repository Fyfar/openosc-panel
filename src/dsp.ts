// Waveform maths on captured frames: Bode tone detection, the scope's browser-side
// measurements (the fallback before firmware 0.21.9's WAV:MEAS?) and FFT, plus DMM statistics and
// the trend's Y floor. Pure, no device access.
// PEAK frames (WAV:POIN:MODE PEAK) carry each bucket's min and max in lo/hi; volts is then their
// midpoint, good for drawing levels but not for spectra.
export type Frame = { ch: 0 | 1; seq: number; xinc: number; xorig: number; volts: Float32Array; lo?: Float32Array; hi?: Float32Array };

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

// The device's readout set (WAV:MEAS? order, SCPI_DESKTOP.md) plus rise time, which only the
// browser computes. NaN = not measured. src: EDGE/SPEC/CNT from the device, HOST when computed here.
export type Meas = {
  freq: number; period: number; vpp: number; amp: number; top: number; base: number; max: number; min: number;
  mean: number; rms: number; acRms: number; duty: number; edges: number; rise: number; clipped: boolean; src: string;
};

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
  const mean = s / n, rms = Math.sqrt(s2 / n);
  return {
    freq, period: 1 / freq, vpp: span, amp: NaN, top: NaN, base: NaN, max: mx, min: mn, mean, rms,
    acRms: Math.sqrt(Math.max(0, rms * rms - mean * mean)), duty, edges: rises.length, rise, clipped: false, src: 'HOST',
  };
}

// --- FFT ------------------------------------------------------------------------------------

export const FFT_WINDOWS = ['RECT', 'HANN', 'HAMM', 'BLACK'] as const;
export type FftWindow = (typeof FFT_WINDOWS)[number];
const WINDOW_FN: Record<FftWindow, (x: number) => number> = { // x = 2πi/(N−1)
  RECT: () => 1,
  HANN: (x) => 0.5 - 0.5 * Math.cos(x),
  HAMM: (x) => 0.54 - 0.46 * Math.cos(x),
  BLACK: (x) => 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x),
};

// Peak amplitude (V) per bin 0..N/2 of the largest power-of-two prefix of `v`, corrected for the
// window's coherent gain so a sine of amplitude A reads ≈ A at its bin.
export function spectrum(v: Float32Array, win: FftWindow): Float32Array {
  let N = 1;
  while (N * 2 <= v.length) N *= 2;
  const re = new Float64Array(N), im = new Float64Array(N), w = WINDOW_FN[win];
  let gain = 0;
  for (let i = 0; i < N; i++) {
    const k = w((2 * Math.PI * i) / (N - 1));
    re[i] = v[i] * k;
    gain += k;
  }
  fftInPlace(re, im);
  const amp = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) amp[k] = ((k ? 2 : 1) * Math.hypot(re[k], im[k])) / gain; // ×2: one-sided, not DC
  return amp;
}

// Radix-2 decimation in time; N a power of two.
function fftInPlace(re: Float64Array, im: Float64Array) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
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
