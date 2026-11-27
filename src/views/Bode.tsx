import { Download, Loader2, Play, Square } from 'lucide-react';
import { clsx } from 'clsx';
import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import uPlot from 'uplot';
import { bodeEta, bodeMaxHz, bodePlan, bodeSlow, fmtHz } from '../device';
import { bodeResults, spanAtLeast, unwrapPhase, wrap180, type BodePt, type BodeResults } from '../dsp';
import * as io from '../io';
import { AXIS, Plot, legendIn, legendValue } from '../Plot';
import { useDev } from '../store';
import { Btn, Panel, Row, Seg, Select, Stat } from '../ui';

export function Bode() {
  const b = useDev((s) => s.bode);
  const patch = useDev((s) => s.patch);
  const model = useDev((s) => s.model);
  const amp = useDev((s) => s.gen.amp);
  const pts = useMemo(() => continuous(b.points), [b.points]);
  const fw = useDev((s) => s.idn?.fw);
  const sineMax = bodeMaxHz(model, amp, fw); // same ceiling as io.bodeSweep
  const plan = useMemo(() => bodePlan(b.start, Math.min(b.stop, sineMax), b.ppd), [b.start, b.stop, b.ppd, sineMax]);

  const res = useMemo(() => bodeResults(pts), [pts]);

  const set = (p: Partial<typeof b>) => patch('bode', p);
  const startOpts = [1, 10, 100, 1000].map((f) => ({ id: f, label: fmtHz(f, true) }));
  const stopOpts = stopList(sineMax);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-4">
        <ResponseChart pts={pts} res={res} progress={b.running ? b.progress : null} slow={b.at !== null && bodeSlow(b.at) ? b.at : null} />
        <Results pts={pts} res={res} planned={plan.length} />
      </div>

      <aside className="space-y-4">
        <Panel title="Sweep">
          <div className="space-y-3">
            {/* A sweep runs the plan it started with: Stop it to change the plan. */}
            <fieldset disabled={b.running} className="space-y-3 disabled:opacity-40">
              <Row label="Start"><Select label="Start frequency" value={b.start} options={startOpts} onChange={(start) => set({ start })} /></Row>
              <Row label="Stop"><Select label="Stop frequency" value={b.stop} options={stopOpts} onChange={(stop) => set({ stop })} /></Row>
              <Row label="Points / decade"><Select label="Points per decade" value={b.ppd} options={[5, 10, 20, 50].map((n) => ({ id: n, label: String(n) }))} onChange={(ppd) => set({ ppd })} /></Row>
            </fieldset>
            <Row label="Est. time"><span className="font-mono">~{etaText(bodeEta(plan, model))}</span></Row>
            <RunButton running={b.running} stopping={b.stopping} />
            <Btn className="w-full" disabled={!pts.length || b.running} onClick={() => exportCsv(pts)}><Download size={13} /> Export CSV</Btn>
          </div>
        </Panel>

        <LimitsNote top={`${fmtHz(sineMax, true)}${model === 'ZT706S' ? ` at ${amp.toFixed(1)} V` : ''}`} />

        <Panel title="Wiring">
          <svg viewBox="0 0 280 120" className="w-full text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="8" y="42" width="56" height="36" rx="4" />
            <text x="36" y="64" textAnchor="middle" fill="currentColor" stroke="none" fontSize="11">GEN</text>
            <rect x="130" y="42" width="56" height="36" rx="4" stroke="#3b82f6" />
            <text x="158" y="64" textAnchor="middle" fill="#3b82f6" stroke="none" fontSize="11">DUT</text>
            <path d="M64 60 H130" />
            <path d="M96 60 V20 H244" stroke="#facc15" />
            <path d="M186 60 H244" stroke="#22d3ee" />
            <circle cx="96" cy="60" r="3" fill="currentColor" />
            <text x="250" y="24" fill="#facc15" stroke="none" fontSize="11">CH1</text>
            <text x="250" y="64" fill="#22d3ee" stroke="none" fontSize="11">CH2</text>
            <text x="8" y="108" fill="currentColor" stroke="none" fontSize="10">CH1 = DUT input · CH2 = DUT output</text>
          </svg>
        </Panel>

        <p className="px-1 text-[11px] text-muted">The device's own Bode analyzer can't run in Remote; this sweep drives the generator and scope from the browser.</p>
      </aside>
    </div>
  );
}

// Stopping takes a moment: the point in progress ends, then the generator and scope are restored.
function RunButton({ running, stopping }: { running: boolean; stopping: boolean }) {
  if (!running) return <Btn tone="accent" className="w-full py-2" onClick={() => void io.bodeSweep()}><Play size={13} /> Run sweep</Btn>;
  return (
    <Btn tone="danger" className="w-full py-2" disabled={stopping} onClick={io.bodeStop}>
      <Square size={13} /> {stopping ? 'Stopping…' : 'Stop sweep'}
    </Btn>
  );
}

type Point = BodePt;
// A/B cursor lines as point indices (a line keeps its point as the sweep appends), clamped when read.
type Cur = { a: number; b: number; drag: 'a' | 'b' | null };
const at = (i: number, n: number) => Math.min(i, n - 1);

// The gain/phase chart. uPlot's live legend sits in the panel header: the hovered point's values.
// f0/f1/f2 tags and the A/B lines are painted by uPlot's draw hook; A/B are dragged on uPlot's overlay.
function ResponseChart({ pts, res, progress, slow }: { pts: Point[]; res: BodeResults; progress: number | null; slow: number | null }) {
  const legend = useRef<HTMLDivElement>(null);
  const cursors = useDev((s) => s.bodeCursors);
  const setView = useDev((s) => s.set);
  const plot = useRef<uPlot | null>(null);
  const marks = useRef(res); // read by the draw hook, so new results need no plot rebuild
  const cur = useRef<Cur>({ a: 0, b: Math.max(0, pts.length - 1), drag: null }); // A first, B last
  const onMove = useRef(() => {}); // the readout re-renders on a drag (set by CursorReadout)
  useEffect(() => { marks.current = res; plot.current?.redraw(false); }, [res]);
  const toggle = (on: boolean) => {
    cur.current = { a: 0, b: Math.max(0, pts.length - 1), drag: null };
    setView({ bodeCursors: on });
  };
  const opts = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(() => ({
    legend: legendIn(legend),
    cursor: { y: false, drag: { x: !cursors } }, // with cursors on, a drag moves a line instead of zooming
    hooks: {
      ready: [(u) => { plot.current = u; if (cursors) bindCursors(u, cur.current, () => onMove.current()); }],
      draw: [(u) => drawMarks(u, marks.current, cursors ? cur.current : null)],
      destroy: [() => { plot.current = null; }],
    },
    scales: { x: { time: false, distr: 3, log: 10 }, db: { range: (_u, mn, mx) => spanAtLeast(mn, mx, 6) }, ph: { range: (_u, mn, mx) => spanAtLeast(mn, mx, 90) } },
    axes: [
      { ...AXIS, values: (_u, t) => t.map((v) => (v == null ? '' : fmtHz(v, true))) },
      { ...AXIS, scale: 'db', size: 64, values: (_u, t) => t.map((v) => (v == null ? '' : `${v} dB`)) },
      { ...AXIS, scale: 'ph', side: 1, size: 48, grid: { show: false }, values: (_u, t) => t.map((v) => (v == null ? '' : `${v}°`)) },
    ],
    series: SERIES,
  }), [cursors]);
  const data = useMemo<uPlot.AlignedData>(() => [pts.map((p) => p.f), pts.map((p) => p.db), pts.map((p) => p.ph)], [pts]);
  const right = (
    <div className="flex items-center gap-3">
      <div ref={legend} className="head-legend font-mono text-xs" />
      <Seg size="xs" value={cursors ? 'ON' : 'OFF'} options={[{ id: 'OFF', label: 'No cursors' }, { id: 'ON', label: 'Cursors A B' }]} onChange={(v) => toggle(v === 'ON')} />
    </div>
  );
  return (
    <Panel title="Frequency response" right={right}>
      <Plot opts={opts} data={data} className={clsx('h-[clamp(300px,52vh,620px)]', cursors && 'cursor-ew-resize')} />
      {cursors && <CursorReadout pts={pts} cur={cur} onMove={onMove} />}
      {progress !== null && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface">
          <div className="h-full bg-accent transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {slow !== null && <SlowPoint key={slow} f={slow} />}
    </Panel>
  );
}

// A ≤ 10 Hz point takes seconds with nothing else on screen moving: the count shows the sweep is alive.
// Keyed on the frequency, so each point counts from 0.
function SlowPoint({ f }: { f: number }) {
  const model = useDev((s) => s.model);
  const [t0] = useState(() => performance.now());
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
      <Loader2 size={12} className="animate-spin" />
      Measuring {fmtHz(f, true)} · slow signal: {Math.floor((performance.now() - t0) / 1000)} s of ~{etaText(bodeEta([f], model))}
    </p>
  );
}

// The meter's result set, f1/f2 labelled with what they are 3 dB under, then roll-off and progress.
// '—': not crossed.
function Results({ pts, res, planned }: { pts: Point[]; res: BodeResults; planned: number }) {
  const notch = res.centre?.notch, under = notch ? 'notch −3 dB' : `−3 dB vs ${res.ref}`;
  const atHz = (v: string, f: number) => `${v} @ ${fmtHz(f, true)}`;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label={notch ? 'Notch (f0)' : 'Peak (f0)'} value={res.centre ? atHz(`${res.centre.db.toFixed(2)} dB`, res.centre.f) : '—'} tone="text-ch1" />
      <Stat label={`f1 (${under})`} value={hzOrDash(res.f1)} />
      <Stat label={`f2 (${under})`} value={hzOrDash(res.f2)} />
      <Stat label={notch ? 'Notch width' : 'Bandwidth'} value={hzOrDash(res.bw)} />
      <Stat label="Gain margin" value={res.gm ? atHz(`${res.gm.v.toFixed(1)} dB`, res.gm.f) : '—'} />
      <Stat label="Phase margin" value={res.pm ? atHz(`${res.pm.v.toFixed(1)}°`, res.pm.f) : '—'} tone="text-ch2" />
      <Stat label="Roll-off (last decade)" value={res.slope !== null ? `${res.slope.toFixed(1)} dB/dec` : '—'} />
      <Stat label="Points" value={`${pts.length} / ${planned}`} />
    </div>
  );
}

const TAG = '#8b949e', LINE = '#3b82f6'; // axis grey, accent

// Vertical marks on the plot area: the analysis' f0/f1/f2 (dotted, top row) and the A/B lines (solid,
// second row). Canvas pixels throughout (valToPos with `true`, bbox, pxRatio).
function drawMarks(u: uPlot, res: BodeResults, cur: Cur | null) {
  const f = u.data[0], n = f.length;
  const marks = [{ f: res.centre?.f, label: 'f0', solid: false }, { f: res.f1, label: 'f1', solid: false }, { f: res.f2, label: 'f2', solid: false }];
  if (cur && n) marks.push({ f: f[at(cur.a, n)], label: 'A', solid: true }, { f: f[at(cur.b, n)], label: 'B', solid: true });
  const { ctx, bbox } = u, px = uPlot.pxRatio, right = bbox.left + bbox.width;
  ctx.save();
  ctx.font = `${10 * px}px "Geist Mono Variable", monospace`;
  ctx.lineWidth = px;
  for (const m of marks) {
    if (m.f == null) continue;
    const x = Math.round(u.valToPos(m.f, 'x', true)), w = ctx.measureText(m.label).width;
    if (x < bbox.left || x > right) continue;
    ctx.strokeStyle = ctx.fillStyle = m.solid ? LINE : TAG;
    ctx.setLineDash(m.solid ? [] : [2 * px, 3 * px]);
    ctx.beginPath();
    ctx.moveTo(x, bbox.top);
    ctx.lineTo(x, bbox.top + bbox.height);
    ctx.stroke();
    ctx.fillText(m.label, x + 3 * px + w > right ? x - 3 * px - w : x + 3 * px, bbox.top + (m.solid ? 24 : 12) * px);
  }
  ctx.restore();
}

// Press grabs the nearer line (CSS pixels on the overlay), drag moves it; uPlot's posToIdx snaps it to
// the nearest measured point. Listeners go with the overlay when uPlot is destroyed.
function bindCursors(u: uPlot, cur: Cur, moved: () => void) {
  const el = u.over, n = () => u.data[0].length;
  const xOf = (i: number) => u.valToPos(u.data[0][at(i, n())], 'x');
  const move = (e: PointerEvent) => {
    if (!cur.drag) return;
    cur[cur.drag] = u.posToIdx(e.offsetX);
    u.redraw(false);
    moved();
  };
  const end = () => { cur.drag = null; };
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => {
    if (!n()) return;
    cur.drag = Math.abs(xOf(cur.a) - e.offsetX) <= Math.abs(xOf(cur.b) - e.offsetX) ? 'a' : 'b';
    el.setPointerCapture(e.pointerId);
    move(e);
  });
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// A, B and B − A (the meter's BodeDelta: phase difference wrapped). Re-renders on a drag tick only.
function CursorReadout({ pts, cur, onMove }: { pts: Point[]; cur: RefObject<Cur>; onMove: RefObject<() => void> }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { onMove.current = tick; }, [onMove]);
  if (!pts.length) return null;
  const a = pts[at(cur.current.a, pts.length)], b = pts[at(cur.current.b, pts.length)];
  const point = (p: Point) => `${fmtHz(p.f, true)} · ${p.db.toFixed(2)} dB · ${p.ph.toFixed(1)}°`;
  const df = b.f - a.f;
  return (
    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs tabular-nums">
      <span><b className="text-accent">A</b> {point(a)}</span>
      <span><b className="text-accent">B</b> {point(b)}</span>
      <span><b className="text-muted">Δ B−A</b> {sign(df)}{fmtHz(Math.abs(df), true)} · {sign(b.db - a.db)}{Math.abs(b.db - a.db).toFixed(2)} dB · {signed(wrap180(b.ph - a.ph))}°</span>
    </div>
  );
}

const sign = (v: number) => (v < 0 ? '-' : '+');
const signed = (v: number) => `${sign(v)}${Math.abs(v).toFixed(1)}`;
const hzOrDash = (f: number | null) => (f === null ? '—' : fmtHz(f, true));

// Series with their live-legend labels and values.
const SERIES: uPlot.Series[] = [
  { label: 'f', value: legendValue(fmtHz) },
  { label: 'Gain CH2/CH1', scale: 'db', stroke: '#facc15', width: 2, points: { size: 4 }, value: legendValue((v) => `${v.toFixed(2)} dB`) },
  { label: 'Phase', scale: 'ph', stroke: '#22d3ee', width: 1.5, dash: [6, 4], points: { size: 3 }, value: legendValue((v) => `${v.toFixed(1)}°`) },
];

// Round stops below the sine ceiling, then the ceiling itself, so the highest frequency is selectable.
const stopList = (max: number) =>
  [...[1000, 10_000, 100_000, 300_000, 1e6, 3e6].filter((f) => f < max), max].map((f) => ({ id: f, label: `${fmtHz(f, true)}${f === max ? ' (max)' : ''}` }));

const etaText = (s: number) => (s < 90 ? `${Math.ceil(s)} s` : `${Math.ceil(s / 60)} min`);

// Phase continuous across points everywhere it's shown or exported (stored wrapped, as measured).
function continuous(points: Point[]): Point[] {
  const ph = unwrapPhase(points.map((p) => p.ph));
  return points.map((p, i) => ({ ...p, ph: ph[i] }));
}

// Measured on a ZT703S (0.21.14) with both probes on the generator and on an RC low-pass.
function LimitsNote({ top }: { top: string }) {
  return (
    <Panel title="Accuracy and limits">
      <ul className="list-disc space-y-1 pl-4 text-[11px] text-muted">
        <li>Sine, up to {top}.</li>
        <li>About ±0.5 dB and ±1°, down to about −40 dB. Calibrating the scope on the device improves it: Settings → Device → Scope calibration → Gain → Match to other channel.</li>
        <li>Inputs are AC coupled: DC gain isn't measured.</li>
        <li>Low frequencies are slow: 1 Hz takes about 20 s per point.</li>
        <li>Gain and phase margins assume CH2/CH1 is the open-loop gain, unstable where its phase reaches −180°. For a filter they mean nothing.</li>
        <li>A narrow peak can fall between points: raise points / decade when the peak spans only a few of them.</li>
      </ul>
    </Panel>
  );
}

function exportCsv(pts: Point[]) {
  const rows = pts.map((p) => `${p.f},${p.db.toFixed(3)},${p.ph.toFixed(2)}`).join('\n');
  io.download(`bode-${Date.now()}.csv`, new Blob([`freq_hz,gain_db,phase_deg\n${rows}\n`], { type: 'text/csv' }));
}
