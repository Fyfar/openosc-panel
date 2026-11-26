import { Download, Loader2, Play, Square } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type uPlot from 'uplot';
import { bodeEta, bodeMaxHz, bodePlan, bodeSlow, fmtHz } from '../device';
import { spanAtLeast, unwrapPhase } from '../dsp';
import * as io from '../io';
import { AXIS, Plot, legendIn, legendValue } from '../Plot';
import { useDev } from '../store';
import { Btn, Panel, Row, Select, Stat } from '../ui';

export function Bode() {
  const b = useDev((s) => s.bode);
  const patch = useDev((s) => s.patch);
  const model = useDev((s) => s.model);
  const amp = useDev((s) => s.gen.amp);
  const pts = useMemo(() => continuous(b.points), [b.points]);
  const fw = useDev((s) => s.idn?.fw);
  const sineMax = bodeMaxHz(model, amp, fw); // same ceiling as io.bodeSweep
  const plan = useMemo(() => bodePlan(b.start, Math.min(b.stop, sineMax), b.ppd), [b.start, b.stop, b.ppd, sineMax]);

  // -3 dB point by linear interpolation in log-frequency.
  const f3 = useMemo(() => {
    const i = pts.findIndex((p) => p.db <= -3);
    if (i < 1) return null;
    const a = pts[i - 1], c = pts[i];
    return a.f * (c.f / a.f) ** ((-3 - a.db) / (c.db - a.db));
  }, [pts]);
  const ph3 = useMemo(() => {
    if (!f3) return null;
    const i = pts.findIndex((p) => p.f >= f3);
    if (i < 1) return null;
    const a = pts[i - 1], c = pts[i], t = Math.log(f3 / a.f) / Math.log(c.f / a.f);
    return a.ph + t * (c.ph - a.ph);
  }, [pts, f3]);
  const slope = pts.length > 3 ? (pts.at(-1)!.db - pts.at(-4)!.db) / Math.log10(pts.at(-1)!.f / pts.at(-4)!.f) : null;

  const set = (p: Partial<typeof b>) => patch('bode', p);
  const startOpts = [1, 10, 100, 1000].map((f) => ({ id: f, label: fmtHz(f, true) }));
  const stopOpts = stopList(sineMax);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-4">
        <ResponseChart pts={pts} progress={b.running ? b.progress : null} slow={b.running && b.at !== null && bodeSlow(b.at) ? b.at : null} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="−3 dB corner" value={f3 ? fmtHz(f3) : '—'} tone="text-ch1" />
          <Stat label="Phase at corner" value={ph3 !== null ? `${ph3.toFixed(1)}°` : '—'} tone="text-ch2" />
          <Stat label="Roll-off (last decade)" value={slope ? `${slope.toFixed(1)} dB/dec` : '—'} />
          <Stat label="Points" value={`${pts.length} / ${plan.length}`} />
        </div>
      </div>

      <aside className="space-y-4">
        <Panel title="Sweep">
          <div className="space-y-3">
            <Row label="Start"><Select label="Start frequency" value={b.start} options={startOpts} onChange={(start) => set({ start })} /></Row>
            <Row label="Stop"><Select label="Stop frequency" value={b.stop} options={stopOpts} onChange={(stop) => set({ stop })} /></Row>
            <Row label="Points / decade"><Select label="Points per decade" value={b.ppd} options={[5, 10, 20, 50].map((n) => ({ id: n, label: String(n) }))} onChange={(ppd) => set({ ppd })} /></Row>
            <Row label="Est. time"><span className="font-mono">~{etaText(bodeEta(plan, model))}</span></Row>
            <Btn tone={b.running ? 'danger' : 'accent'} className="w-full py-2" onClick={() => void (b.running ? io.bodeStop() : io.bodeSweep())}>
              {b.running ? <><Square size={13} /> Stop sweep</> : <><Play size={13} /> Run sweep</>}
            </Btn>
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

type Point = { f: number; db: number; ph: number };

// The gain/phase chart. uPlot's live legend sits in the panel header: the hovered point's values.
function ResponseChart({ pts, progress, slow }: { pts: Point[]; progress: number | null; slow: number | null }) {
  const legend = useRef<HTMLDivElement>(null);
  const opts = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(() => ({
    legend: legendIn(legend),
    cursor: { y: false },
    scales: { x: { time: false, distr: 3, log: 10 }, db: { range: (_u, mn, mx) => spanAtLeast(mn, mx, 6) }, ph: { range: (_u, mn, mx) => spanAtLeast(mn, mx, 90) } },
    axes: [
      { ...AXIS, values: (_u, t) => t.map((v) => (v == null ? '' : fmtHz(v, true))) },
      { ...AXIS, scale: 'db', size: 64, values: (_u, t) => t.map((v) => (v == null ? '' : `${v} dB`)) },
      { ...AXIS, scale: 'ph', side: 1, size: 48, grid: { show: false }, values: (_u, t) => t.map((v) => (v == null ? '' : `${v}°`)) },
    ],
    series: SERIES,
  }), []);
  const data = useMemo<uPlot.AlignedData>(() => [pts.map((p) => p.f), pts.map((p) => p.db), pts.map((p) => p.ph)], [pts]);
  return (
    <Panel title="Frequency response" right={<div ref={legend} className="head-legend font-mono text-xs" />}>
      <Plot opts={opts} data={data} className="h-[clamp(300px,52vh,620px)]" />
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
      </ul>
    </Panel>
  );
}

function exportCsv(pts: Point[]) {
  const rows = pts.map((p) => `${p.f},${p.db.toFixed(3)},${p.ph.toFixed(2)}`).join('\n');
  io.download(`bode-${Date.now()}.csv`, new Blob([`freq_hz,gain_db,phase_deg\n${rows}\n`], { type: 'text/csv' }));
}
