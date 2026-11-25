// Waveform maths on captured frames: Bode tone detection, the scope's browser-side
// measurements (the fallback before firmware 0.21.9's WAV:MEAS?) and FFT, plus DMM statistics and
// the trend's Y floor. Pure, no device access.
// PEAK frames (WAV:POIN:MODE PEAK) carry each bucket's min and max in lo/hi; volts is then their
// midpoint, good for drawing levels but not for spectra.
// `win` and `scale` say where a device frame sits in its record (samples first…end − 1, `interval`
// seconds apart) and how its bytes became volts: enough to read the same window again.
export type RecordWindow = { first: number; end: number; interval: number };
export type Scale = { yinc: number; zero: number; yref: number }; // volts = (byte − yref − zero) · yinc
export type Frame = {
  ch: 0 | 1; seq: number; xinc: number; xorig: number; volts: Float32Array; lo?: Float32Array; hi?: Float32Array;
  win?: RecordWindow; scale?: Scale;
  screen?: number; clipped?: boolean; // full-rate FFT data: samples across the screen; any on an ADC rail
};

export function extent(v: Float32Array) {
  let mn = Infinity, mx = -Infinity;
  // Indexed: for-of over a typed array is several times slower, and this runs on 65 536 samples.
  for (let i = 0; i < v.length; i++) { const x = v[i]; if (x < mn) mn = x; if (x > mx) mx = x; }
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

// One-slot caches: the view transforms one channel with one window, over and over.
let winCache = { win: 'RECT' as FftWindow, w: new Float64Array(0), sum: 0 };
function windowFor(win: FftWindow, len: number) {
  if (winCache.win !== win || winCache.w.length !== len) {
    const w = new Float64Array(len);
    let sum = 0;
    for (let i = 0; i < len; i++) {
      w[i] = WINDOW_FN[win]((2 * Math.PI * i) / (len - 1));
      sum += w[i];
    }
    winCache = { win, w, sum };
  }
  return winCache;
}

let twiddles = { cos: new Float64Array(0), sin: new Float64Array(0) };
function twiddlesFor(N: number) {
  if (twiddles.cos.length !== N / 2) {
    const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) {
      cos[k] = Math.cos((-2 * Math.PI * k) / N);
      sin[k] = Math.sin((-2 * Math.PI * k) / N);
    }
    twiddles = { cos, sin };
  }
  return twiddles;
}

// Peak amplitude (V) per bin of all of `v`: mean removed, windowed, zero-padded to a power of two N.
// The result holds bins k < N/2, bin k at k / (N·dt) Hz; a sine of amplitude A reads ≈ A at its bin.
export function spectrum(v: Float32Array, win: FftWindow): Float32Array {
  const L = v.length, { w, sum } = windowFor(win, L);
  let N = 1;
  while (N < L) N *= 2;
  let mean = 0;
  for (let i = 0; i < L; i++) mean += v[i];
  mean /= L;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < L; i++) re[i] = (v[i] - mean) * w[i];
  fftInPlace(re, im);
  const amp = new Float32Array(N / 2);
  // ×2: one-sided, not DC. Math.sqrt, as Math.hypot is several times slower.
  for (let k = 0; k < amp.length; k++) amp[k] = ((k ? 2 : 1) * Math.sqrt(re[k] * re[k] + im[k] * im[k])) / sum;
  return amp;
}

// `amp` plus what its bins mean: spacing, the resolution of the analysed samples (1 / their time,
// coarser than the zero-padded spacing) and half the sample rate.
export type Spectrum = { amp: Float32Array; binHz: number; resHz: number; topHz: number };

export function spectrumOf(f: Frame, win: FftWindow): Spectrum {
  const amp = spectrum(f.volts, win), topHz = 1 / (2 * f.xinc);
  return { amp, binHz: topHz / amp.length, resHz: 1 / (f.volts.length * f.xinc), topHz };
}

// Highest bin in lo…hi (never bin 0, the window's DC leftover) as a fractional bin and level. A local
// maximum is refined by a parabola through the logs of its three bins; null when the range is empty.
export function peakIn(amp: Float32Array, lo: number, hi: number): { bin: number; amp: number } | null {
  const from = Math.max(1, Math.round(lo)), to = Math.min(amp.length - 1, Math.round(hi));
  if (from > to) return null;
  let k = from;
  for (let i = from + 1; i <= to; i++) if (amp[i] > amp[k]) k = i;
  const a = amp[k - 1], b = amp[k], c = amp[k + 1] ?? Infinity;
  if (!(a > 0 && c > 0 && b >= a && b >= c)) return { bin: k, amp: b };
  const la = Math.log(a), lb = Math.log(b), lc = Math.log(c), curve = la - 2 * lb + lc;
  const shift = curve < 0 ? (0.5 * (la - lc)) / curve : 0;
  return { bin: k + shift, amp: Math.exp(lb - 0.25 * (la - lc) * shift) };
}

// The highest point within `reachHz` of `hz` (a marker's reading); null above half the sample rate.
export function peakNear(s: Spectrum, hz: number, reachHz: number): { hz: number; amp: number } | null {
  if (!(hz <= s.topHz)) return null;
  const found = peakIn(s.amp, (hz - reachHz) / s.binHz, (hz + reachHz) / s.binHz);
  return found && { hz: found.bin * s.binHz, amp: found.amp };
}

// Auto shows 1000 resolution steps (100 kHz at 1 ms/div), never past half the sample rate.
export type FftSpan = 'AUTO' | 'FULL';
export const fftSpanHz = (s: Spectrum, span: FftSpan) => (span === 'FULL' ? s.topHz : Math.min(s.topHz, 1000 * s.resHz));

// The strongest component and how far to trust it. Thresholds come from simulation: under 5 periods
// the level is rough, under 2 or within 2 resolutions of half the sample rate both values are.
export type Peak = {
  hz: number; amp: number; withheld: 'none' | 'low' | 'limit' | null;
  fewPeriods: boolean; approxHz: boolean; approxLevel: boolean;
};

export function findPeak(s: Spectrum, vdiv: number, win: FftWindow): Peak {
  const found = peakIn(s.amp, 1, s.amp.length - 1) ?? { bin: 0, amp: 0 };
  const hz = found.bin * s.binHz, periods = hz / s.resHz;
  let withheld: Peak['withheld'] = null;
  if (found.amp < vdiv / 50) withheld = 'none';
  else if (periods < 2) withheld = 'low';
  else if (hz > s.topHz - 2 * s.resHz) withheld = 'limit';
  const rect = win === 'RECT', fewPeriods = periods < 5;
  return { hz, amp: found.amp, withheld, fewPeriods, approxHz: rect, approxLevel: rect || fewPeriods };
}

// Why the spectrum may mislead, as ids in the order the panel lists them (the view holds the text).
// samples: analysed; screen: samples across the screen; swing and vdiv in volts.
export const MIN_FFT_SAMPLES = 64;
export type FftState = {
  samples: number; screen: number; clipped: boolean; swing: number; vdiv: number; peak: Peak | null; spanHz: number;
};
export type FftNote = 'partial' | 'clipped' | 'small' | 'few' | 'low' | 'limit' | 'periods' | 'rect' | 'beyond';

export function fftNotes(s: FftState): FftNote[] {
  const p = s.peak;
  const active: Record<FftNote, boolean> = {
    partial: s.screen > s.samples,
    clipped: s.clipped,
    small: s.swing < s.vdiv,
    few: s.samples < MIN_FFT_SAMPLES,
    low: p?.withheld === 'low',
    limit: p?.withheld === 'limit',
    periods: p?.withheld === null && p.fewPeriods,
    rect: p?.approxHz === true,
    beyond: p != null && p.withheld !== 'none' && p.hz > s.spanHz,
  };
  return (Object.keys(active) as FftNote[]).filter((id) => active[id]);
}

// Radix-2 decimation in time; N a power of two.
function fftInPlace(re: Float64Array, im: Float64Array) {
  const N = re.length, { cos, sin } = twiddlesFor(N);
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  // Values held in locals: about 20 % faster than re-reading the arrays.
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1, step = N / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t], wi = sin[t], a = i + k, b = a + half;
        const ar = re[a], ai = im[a], br = re[b], bi = im[b];
        const tr = br * wr - bi * wi, ti = br * wi + bi * wr;
        re[a] = ar + tr; im[a] = ai + ti;
        re[b] = ar - tr; im[b] = ai - ti;
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
