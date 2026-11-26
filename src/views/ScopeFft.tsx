// The scope's spectrum panel (controls, limits, canvas, markers, help), its row in the
// measurements panel and its part of the PNG export. All of them show the same `model()`.
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { fmtHz, fmtStable, fmtVolt, vdiv } from '../device';
import {
  extent, FFT_WINDOWS, fftNotes, fftSpanHz, findPeak, MIN_FFT_SAMPLES, peakNear, spectrumOf,
  type FftNote, type FftWindow, type Frame, type Spectrum,
} from '../dsp';
import * as io from '../io';
import { useDev, type FftScale } from '../store';
import { Columns, M, Seg, strokeGrid } from '../ui';

export const COLOR = '#d946ef'; // the FFT's trace and readout colour
const MUTED = '#8b949e';
const SNAP_PX = 6; // a placed marker takes the highest point this close to the pointer
const WINDOW_LABEL: Record<FftWindow, string> = { RECT: 'Rect', HANN: 'Hann', HAMM: 'Hamming', BLACK: 'Blackman' };
const SCALES: { id: FftScale; label: string }[] = [{ id: 'DBV', label: 'dBV' }, { id: 'DBFS', label: 'dBFS' }, { id: 'LIN', label: 'Linear' }];

// Per level scale: a bin's peak volts → the shown value, the plot's range and its gridlines.
// fs: full scale in volts (±4 div).
type Level = {
  name: string; lines: number; range: (fs: number) => [top: number, bottom: number]; tick: (v: number) => string;
  value: (amp: number, fs: number) => number; text: (v: number) => string; delta: (d: number) => string;
};
const db = (ratio: number) => 20 * Math.log10(ratio + 1e-12);
const dbText = (unit: string, digits = 1) => (v: number) => `${v.toFixed(digits)} ${unit}`;
const LEVEL: Record<FftScale, Level> = {
  DBV: { name: 'dBV rms', lines: 5, range: () => [20, -80], tick: dbText('dBV', 0), value: (a) => db(a / Math.SQRT2), text: dbText('dBV'), delta: dbText('dB') },
  DBFS: { name: 'dBFS (0 = ±4 div)', lines: 5, range: () => [0, -100], tick: dbText('dBFS', 0), value: (a, fs) => db(a / fs), text: dbText('dBFS'), delta: dbText('dB') },
  LIN: { name: 'V peak', lines: 4, range: (fs) => [fs, 0], tick: fmtVolt, value: (a) => a, text: fmtVolt, delta: fmtVolt },
};

const NOTE: Record<FftNote, string> = {
  partial: 'Analysing the middle {n} % of the screen. For all of it, set Analyze → Acquisition → Deep memory to "Longer record" on the device (switch to Local if its keys are locked).',
  clipped: 'Signal clipped: some peaks are false. Raise volts/div or move the trace.',
  small: 'Signal small: weak peaks may be false. Lower volts/div.',
  few: 'Too few samples: use a slower timebase.',
  low: 'Strongest signal too low to measure: use a slower timebase.',
  limit: 'Strongest signal at the frequency limit: use a faster timebase.',
  periods: '≈ Fewer than 5 periods on screen: the level is rough. A slower timebase helps.',
  rect: '≈ Rect window: values are rough. Use Hann for most signals.',
  beyond: 'Strongest peak is outside the view: choose Full.',
};

const HELP: [head: string, text: string][] = [
  ['', 'One channel is analysed: the samples across the screen, updated about twice a second.'],
  ['Highest frequency', 'is half the sample rate. The scope has no filter for anything higher, so it appears at a false frequency and the app can\'t tell. Faster time/div raises it. To check a peak, change time/div: a real one stays put.'],
  ['Detail', 'is 1 ÷ the time on screen: closer peaks merge. A slower time/div gives finer detail but can lower the highest frequency.'],
  ['Levels', 'depend on the scope\'s calibration; the two channels can differ by a few percent. ≈ marks a rough value.'],
  ['Weak peaks:', 'the scope measures in 256 steps. Fill the screen height without clipping. Peaks far below the strongest one may come from the scope or the signal source.'],
  ['Window:', 'Hann suits most signals. The average (DC) is removed.'],
];

// Marker frequencies in Hz, NaN until first shown. Replaced, never mutated: a new object = a move.
let marks = { a: NaN, b: NaN };

// The spectrum is computed once per data frame and window.
let cache: { f: Frame; win: FftWindow; sp: Spectrum | null; swing: number } | null = null;
function analyse(f: Frame, win: FftWindow) {
  if (cache?.f !== f || cache.win !== win) {
    const { mn, mx } = extent(f.volts);
    cache = { f, win, sp: f.volts.length >= MIN_FFT_SAMPLES ? spectrumOf(f, win) : null, swing: mx - mn };
  }
  return cache;
}

// What the panel shows right now: the settings, and the latest data if it is the shown channel's.
function model() {
  const { fftSrc, fftWin, fftScale, fftSpan, fftMarkers, scope } = useDev.getState();
  const ch = scope.ch[fftSrc].on ? fftSrc : ((1 - fftSrc) as 0 | 1); // as io reads: the enabled channel
  const f = io.scopeData.fft?.ch === ch ? io.scopeData.fft : null;
  const { sp, swing } = f ? analyse(f, fftWin) : { sp: null, swing: 0 };
  const vd = vdiv(scope.ch[ch]);
  const read = (hz: number) => (sp && fftMarkers ? peakNear(sp, hz, sp.resHz) : null);
  return {
    ch, f, sp, swing, vd, win: fftWin, level: LEVEL[fftScale], markers: fftMarkers,
    spanHz: sp ? fftSpanHz(sp, fftSpan) : NaN,
    peak: sp ? findPeak(sp, vd, fftWin) : null,
    a: read(marks.a), b: read(marks.b),
  };
}
type Model = ReturnType<typeof model>;

// New data and marker moves arrive outside React: look once a frame, re-render on a change.
let snap = { data: null as Frame | null, marks };
function snapshot() {
  if (snap.data !== io.scopeData.fft || snap.marks !== marks) snap = { data: io.scopeData.fft, marks };
  return snap;
}
function everyFrame(changed: () => void) {
  let raf = requestAnimationFrame(function tick() { changed(); raf = requestAnimationFrame(tick); });
  return () => cancelAnimationFrame(raf);
}
function useSpectrum() {
  useSyncExternalStore(everyFrame, snapshot);
  // The settings the model reads, as one value that changes only when one of them does.
  useDev((s) => [s.fftSrc, s.fftWin, s.fftScale, s.fftSpan, s.fftMarkers,
    ...s.scope.ch.map((c) => `${c.on} ${c.vdivMv} ${c.probe}`)].join());
  return model();
}


function notes({ f, swing, vd, peak, spanHz }: Model): string[] {
  if (!f) return [];
  const samples = f.volts.length, screen = f.screen ?? samples;
  const ids = fftNotes({ samples, screen, clipped: f.clipped === true, swing, vdiv: vd, peak, spanHz });
  return ids.map((id) => NOTE[id].replace('{n}', String(Math.round((100 * samples) / screen))));
}

// --- readouts (measurements panel and PNG) --------------------------------------------------

type Cell = { l: string; v: string; hint?: string };
const approx = (rough: boolean, text: string) => (rough ? `≈ ${text}` : text);
const exps = new Map<string, number>(); // sticky SI prefix per readout (fmtStable)
function hzText(key: string, v: number) {
  const r = fmtStable(v, 'Hz', 5, exps.get(key));
  exps.set(key, r.exp);
  return r.text;
}
const WITHHELD = { none: '—', low: 'too low', limit: 'at limit' };

function peakCells({ peak, sp, spanHz, level, vd }: Model): Cell[] {
  const shown = peak?.withheld === null ? peak : null;
  const why = peak?.withheld ? WITHHELD[peak.withheld] : '—';
  const beyond = shown !== null && shown.hz > spanHz;
  return [
    {
      l: beyond ? 'Off view' : 'Peak', v: shown ? approx(shown.approxHz, hzText('peak', shown.hz)) : why,
      hint: beyond ? 'strongest component, above the displayed span' : 'strongest component above DC',
    },
    { l: 'Level', v: shown ? approx(shown.approxLevel, level.text(level.value(shown.amp, 4 * vd))) : why },
    { l: 'Resolution', v: hzText('res', sp?.resHz ?? NaN), hint: '1 / the time analysed: closer peaks merge' },
  ];
}

function markerCells({ a, b, win, level, vd }: Model): Cell[] {
  const rough = win === 'RECT';
  const value = (p: Model['a']) => (p ? level.value(p.amp, 4 * vd) : NaN);
  const freq = (key: string, p: Model['a']) => (p ? approx(rough, hzText(key, p.hz)) : '—');
  const lvl = (p: Model['a']) => (p ? approx(rough, level.text(value(p))) : '—');
  const both = a && b;
  return [
    { l: 'A', v: freq('a', a) },
    { l: 'B', v: freq('b', b) },
    { l: 'ΔF', v: both ? approx(rough, hzText('df', b.hz - a.hz)) : '—', hint: 'B − A' },
    { l: 'A level', v: lvl(a) },
    { l: 'B level', v: lvl(b) },
    { l: 'ΔL', v: both ? approx(rough, level.delta(value(b) - value(a))) : '—', hint: 'B − A' },
  ];
}

const cells = (m: Model) => (m.markers ? [...peakCells(m), ...markerCells(m)] : peakCells(m));

export const SpectrumReadout = memo(function SpectrumReadout() {
  const m = useSpectrum();
  return (
    <Columns className="border-t border-border pt-1.5" head={<span className="font-bold" style={{ color: COLOR }}>FFT</span>}>
      {cells(m).map((c) => <M key={c.l} {...c} />)}
    </Columns>
  );
});

// --- canvas ---------------------------------------------------------------------------------

// Greedy line breaking of `parts` joined by `sep` to at most `width` canvas pixels.
export function wrap(g: CanvasRenderingContext2D, parts: string[], sep: string, width: number) {
  const lines: string[] = [];
  for (const part of parts) {
    const joined = lines.length ? `${lines.at(-1)}${sep}${part}` : part;
    if (lines.length && g.measureText(joined).width <= width) lines[lines.length - 1] = joined;
    else lines.push(part);
  }
  return lines;
}

export const FONT = (dpr: number) => `${11 * dpr}px "Geist Mono Variable", monospace`;
type Plot = { g: CanvasRenderingContext2D; W: number; top: number; h: number; dpr: number };

// A level (0 = plot top … 1 = bottom) of a bin's peak volts, kept inside the plot.
function yOf({ top, h }: Plot, { level, vd }: Model, amp: number) {
  const [hi, lo] = level.range(4 * vd);
  return top + Math.min(1, Math.max(0, (hi - level.value(amp, 4 * vd)) / (hi - lo))) * h;
}

// 1-2-5 step giving at most 10 divisions of `span`.
function tickStep(span: number) {
  const raw = span / 10, pow = 10 ** Math.floor(Math.log10(raw));
  return pow * ([1, 2, 5].find((k) => k * pow >= raw * 0.999) ?? 10);
}

function drawLevels({ g, W, top, h, dpr }: Plot, { level }: Model) {
  g.beginPath();
  for (let i = 0; i <= level.lines; i++) { const y = top + (i / level.lines) * h; g.moveTo(0, y); g.lineTo(W, y); }
  strokeGrid(g, dpr);
}

// Drawn after the curve, on a backing, so noise never hides them.
function drawLevelLabels({ g, top, h, dpr }: Plot, { level, vd }: Model) {
  const [hi, lo] = level.range(4 * vd);
  for (let i = 0; i < level.lines; i++) {
    const text = level.tick(hi - (i * (hi - lo)) / level.lines), y = top + (i / level.lines) * h;
    g.fillStyle = '#07090dcc';
    g.fillRect(2 * dpr, y + 2 * dpr, g.measureText(text).width + 4 * dpr, 13 * dpr);
    g.fillStyle = MUTED;
    g.fillText(text, 4 * dpr, y + 12 * dpr);
  }
}

function drawFrequencies({ g, W, top, h, dpr }: Plot, { spanHz }: Model) {
  const step = tickStep(spanHz), px = (step / spanHz) * W, every = Math.ceil((64 * dpr) / px);
  g.beginPath();
  for (let i = 1; i * px < W; i++) { g.moveTo(i * px, top); g.lineTo(i * px, top + h); }
  strokeGrid(g, dpr);
  g.fillStyle = MUTED;
  for (let i = 0; i * px <= W + 1; i += every) {
    const text = fmtHz(i * step, true), w = g.measureText(text).width;
    g.fillText(text, Math.min(W - w - 2 * dpr, Math.max(2 * dpr, i * px - w / 2)), top + h + 12 * dpr);
  }
}

// The highest bin per pixel column, so a narrow peak survives; bin 0 (the DC leftover) is left out.
function drawCurve(p: Plot, m: Model, { amp, binHz }: Spectrum) {
  const perBin = (binHz / m.spanHz) * p.W;
  let col = Math.floor(perBin), best = amp[1];
  p.g.strokeStyle = COLOR;
  p.g.lineWidth = 1.2 * p.dpr;
  p.g.beginPath();
  for (let k = 2; k < amp.length && col <= p.W; k++) {
    const x = Math.floor(k * perBin);
    if (x === col) { best = Math.max(best, amp[k]); continue; }
    p.g.lineTo(col, yOf(p, m, best));
    col = x;
    best = amp[k];
  }
  p.g.lineTo(col, yOf(p, m, best));
  p.g.stroke();
}

function drawPeakTag(p: Plot, m: Model) {
  const { g, W, dpr } = p, peak = m.peak;
  if (peak?.withheld !== null || peak.hz > m.spanHz) return;
  const x = (peak.hz / m.spanHz) * W, y = Math.max(p.top + 14 * dpr, yOf(p, m, peak.amp) - 3 * dpr);
  g.fillStyle = COLOR;
  g.beginPath();
  g.moveTo(x, y); g.lineTo(x - 4 * dpr, y - 6 * dpr); g.lineTo(x + 4 * dpr, y - 6 * dpr);
  g.fill();
  const text = fmtHz(peak.hz), w = g.measureText(text).width;
  g.fillText(text, x + 8 * dpr + w > W ? x - 8 * dpr - w : x + 8 * dpr, y - 1 * dpr);
}

function drawMarkerLines({ g, W, top, h, dpr }: Plot, { a, b, spanHz }: Model) {
  g.strokeStyle = g.fillStyle = '#3b82f6';
  g.lineWidth = 1.5 * dpr;
  g.setLineDash([5 * dpr, 4 * dpr]);
  for (const [id, p] of [['A', a], ['B', b]] as const) {
    if (!p) continue;
    const x = (p.hz / spanHz) * W;
    g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + h); g.stroke();
    g.fillText(id, x + 4 * dpr, top + h - 4 * dpr);
  }
  g.setLineDash([]);
}

function caption({ ch, f, sp, win, level }: Model) {
  if (!f || !sp) return [`CH${ch + 1}`];
  return [`CH${ch + 1}`, `${f.volts.length.toLocaleString('en-US')} samples`, `resolution ${fmtHz(sp.resHz, true)}`, WINDOW_LABEL[win], level.name];
}

function drawSpectrum(c: HTMLCanvasElement, m: Model) {
  const dpr = devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr);
  c.height = Math.round(c.clientHeight * dpr);
  const g = c.getContext('2d')!;
  g.font = FONT(dpr);
  const head = wrap(g, caption(m), ' · ', c.width - 16 * dpr);
  g.fillStyle = COLOR;
  head.forEach((line, i) => g.fillText(line, 8 * dpr, (13 + 14 * i) * dpr));
  const top = (6 + 14 * head.length) * dpr;
  const p: Plot = { g, W: c.width, top, h: c.height - top - 16 * dpr, dpr };
  if (!m.sp) {
    g.fillStyle = MUTED;
    g.textAlign = 'center';
    g.fillText(m.f ? NOTE.few : 'Waiting for spectrum data…', c.width / 2, c.height / 2);
    return;
  }
  drawLevels(p, m);
  drawFrequencies(p, m);
  drawCurve(p, m, m.sp);
  drawLevelLabels(p, m);
  drawPeakTag(p, m);
  drawMarkerLines(p, m);
}

// The spectrum's part of the PNG text: its readouts and the notes that apply.
export function fftPngText() {
  const m = model();
  return { cells: cells(m).map((c) => `${c.l} ${c.v}`), notes: notes(m) };
}

// --- panel ----------------------------------------------------------------------------------

function Controls({ shown }: { shown: 0 | 1 }) {
  const win = useDev((st) => st.fftWin);
  const scale = useDev((st) => st.fftScale);
  const span = useDev((st) => st.fftSpan);
  const markers = useDev((st) => st.fftMarkers);
  const ch = useDev((st) => st.scope.ch);
  const setView = useDev((st) => st.set);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-panel px-2 py-1">
      <span className="font-mono text-[11px] font-semibold" style={{ color: COLOR }}>FFT</span>
      <Seg size="xs" value={shown} options={([0, 1] as const).map((i) => ({ id: i, label: `CH${i + 1}`, disabled: !ch[i].on }))} onChange={(fftSrc) => setView({ fftSrc })} />
      <Seg size="xs" value={win} options={FFT_WINDOWS.map((id) => ({ id, label: WINDOW_LABEL[id] }))} onChange={(fftWin) => setView({ fftWin })} />
      <Seg size="xs" value={scale} options={SCALES} onChange={(fftScale) => setView({ fftScale })} />
      <Seg size="xs" value={span} options={[{ id: 'AUTO', label: 'Auto span' }, { id: 'FULL', label: 'Full' }]} onChange={(fftSpan) => setView({ fftSpan })} />
      <Seg size="xs" value={markers ? 'ON' : 'OFF'} options={[{ id: 'OFF', label: 'No markers' }, { id: 'ON', label: 'Markers A B' }]} onChange={(v) => setView({ fftMarkers: v === 'ON' })} />
    </div>
  );
}

// Drag the nearer marker; it jumps to the highest point close to the pointer.
function useMarkerDrag(m: Model) {
  const drag = useRef<'a' | 'b' | null>(null);
  return (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.type === 'pointerup' || e.type === 'pointercancel') drag.current = null;
    else if (m.markers && m.sp) {
      const r = e.currentTarget.getBoundingClientRect();
      const at = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * m.spanHz;
      if (e.type === 'pointerdown') {
        drag.current = Math.abs(marks.a - at) <= Math.abs(marks.b - at) ? 'a' : 'b';
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      const found = drag.current && peakNear(m.sp, at, (SNAP_PX / r.width) * m.spanHz);
      if (found) marks = { ...marks, [drag.current!]: found.hz };
    }
  };
}

// Redraws on every render of the panel: new data, a setting, a marker move or a new canvas size.
function useSpectrumCanvas(canvas: React.RefObject<HTMLCanvasElement | null>, m: Model) {
  const [, setSize] = useState('');
  useEffect(() => {
    const seen = new ResizeObserver(([e]) => setSize(`${e.contentRect.width} ${e.contentRect.height}`));
    seen.observe(canvas.current!);
    return () => seen.disconnect();
  }, [canvas]);
  useEffect(() => {
    if (m.markers && m.sp && Number.isNaN(marks.a)) marks = { a: 0.25 * m.spanHz, b: 0.5 * m.spanHz };
    drawSpectrum(canvas.current!, m);
  });
}

// memo (also on the readout): the scope view re-renders on status polls and cursor drags, which would
// redraw and rescan an unchanged spectrum. Everything shown here arrives through useSpectrum.
export const SpectrumPanel = memo(function SpectrumPanel({ canvas }: { canvas: React.RefObject<HTMLCanvasElement | null> }) {
  const m = useSpectrum();
  const onPointer = useMarkerDrag(m);
  useSpectrumCanvas(canvas, m);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-[#07090d]">
      <Controls shown={m.ch} />
      {notes(m).length > 0 && (
        <div className="space-y-0.5 px-3 py-1.5 text-[11px]">
          {notes(m).map((n) => <p key={n} className="text-amber">{n}</p>)}
        </div>
      )}
      <canvas
        ref={canvas}
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onPointerUp={onPointer}
        onPointerCancel={onPointer}
        className={`block h-[clamp(200px,30vh,340px)] w-full ${m.markers ? 'cursor-ew-resize touch-none' : ''}`}
      />
      <details className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
        <summary className="cursor-pointer select-none">About this FFT</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {HELP.map(([head, text]) => <li key={text}>{head && <b className="text-fg">{head} </b>}{text}</li>)}
        </ul>
      </details>
    </div>
  );
});
