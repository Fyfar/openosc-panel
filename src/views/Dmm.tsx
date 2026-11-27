import { clsx } from 'clsx';
import { Download, Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import uPlot from 'uplot';
import { DMM_FUNCS, dmmBase, dmmScale, HOLD_MODES, scaleFor, type DmmFunc } from '../device';
import { heldIdx, histogram, stdDev, windowExtent, yFloor } from '../dsp';
import * as io from '../io';
import { AXIS, legendIn, legendValue, Plot } from '../Plot';
import { decimate, REC_MAX, type Trace } from '../recording';
import { useDev, type Cond, type SaveOff, type State } from '../store';
import { Btn, Panel, Seg, Stat, Toggle } from '../ui';

// In the meter's key order: F1 V, F2 Ω → •)) → →| → ⊣⊢, F3 A, F4 mV → Type K (mA with the probe in
// the mA jack). A pair is one button: clicking it again flips DC ⇄ AC.
const GROUPS: DmmFunc[][] = [['VDC', 'VAC'], ['RES'], ['CONT'], ['DIOD'], ['CAP'], ['ADC', 'AAC'], ['MVDC', 'MVAC'], ['TEMP'], ['MADC', 'MAAC']];

const WINDOWS = [{ id: 10, label: '10s' }, { id: 60, label: '1m' }, { id: 600, label: '10m' }, { id: 3600, label: '1h' }, { id: 0, label: 'all' }];
const KINDS = [{ id: 'line' as const, label: 'Line' }, { id: 'hist' as const, label: 'Histogram' }];
// A reading holds until the next one: the meter never shows the values a sloped segment would claim.
const STEPPED = uPlot.paths.stepped!({ align: 1 });
const BARS = uPlot.paths.bars!({ size: [0.92, 100] });
const CLOCK = uPlot.fmtDate('{HH}:{mm}:{ss}');
// uPlot picks the tick step from these (whole seconds: readings come ~3/s) and formats with its
// template table: [min step, format, year, month, day, hour, min, sec, mode]; day shown on change.
const TIME_INCRS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
const TIME_FMT: uPlot.Axis.Values = [
  [60, '{HH}:{mm}', null, null, '\n{D}.{MM}', null, null, null, 1],
  [1, '{HH}:{mm}:{ss}', null, null, '\n{D}.{MM}', null, null, null, 1],
];

const siLabel = (v: number, base: string) => {
  const s = scaleFor(v, base);
  return `${+(v / s.div).toPrecision(4)} ${s.unit}`;
};

export function Dmm() {
  const dmm = useDev((s) => s.dmm);
  const patch = useDev((s) => s.patch);
  const ranges = useDev((s) => s.ranges);
  const reading = useDev((s) => s.reading);
  const dstats = useDev((s) => s.dstats);
  const f = DMM_FUNCS.find((x) => x.id === dmm.func)!;
  const junctionNeeded = useDev((s) => s.junctionNeeded);

  const fahrenheit = useDev((s) => s.fahrenheit);
  const sc = dmmScale(dmm.func, ranges[dmm.range], fahrenheit);
  const recordedSc = useRecordedScale(sc);
  const ac = dmm.func.endsWith('AC');

  const shown = reading === null ? '- - - -' : reading.over ? 'OL' : reading.blank || reading.v === null ? '----' : (reading.v / sc.div).toFixed(sc.dp);
  const live = reading !== null && !reading.blank && !reading.over;
  const n = dstats.n;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-4">
        <Panel
          title={f.label}
          right={
            <div className="flex gap-1.5 text-xs font-semibold">
              {dmm.auto && ranges.length > 0 && <Badge tone="muted">AUTO</Badge>}
              {dmm.rel && <Badge tone="accent">REL Δ</Badge>}
              {dmm.hold && <Badge tone="amber">HOLD</Badge>}
              <LogBadge />
              {!dmm.hold && live && <Badge tone="success">LIVE</Badge>}
            </div>
          }
        >
          <div className="@container flex items-end justify-center gap-4 py-6">
            <span
              className={clsx(
                'font-mono text-[length:clamp(3rem,14cqw,7rem)] leading-none font-bold tabular-nums',
                reading?.over ? 'text-danger' : dmm.hold ? 'text-amber' : live ? 'text-accent' : 'text-muted',
              )}
              style={live ? { textShadow: dmm.hold ? '0 0 28px rgba(245,158,11,0.35)' : '0 0 28px rgba(59,130,246,0.35)' } : undefined}
            >
              {shown}
            </span>
            <span className="mb-2 font-mono text-3xl font-semibold text-muted">{sc.unit}</span>
          </div>
          <div className="flex flex-wrap justify-around gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
            <Meta label="Range" value={ranges.length ? `${dmm.auto ? 'Auto · ' : ''}${ranges[dmm.range] !== undefined ? siLabel(ranges[dmm.range], f.base) : '?'}` : '—'} />
            <Meta label="Secondary" value={reading?.sec != null ? (ac ? siLabel(reading.sec, 'Hz') : String(reading.sec)) : '—'} />
            <Meta label="Resolution" value={`${(10 ** -sc.dp).toFixed(sc.dp)} ${sc.unit}`} />
            <Meta label="Samples" value={n.toLocaleString('en')} />
          </div>
        </Panel>

        <SavedNotice />

        <Trend sc={recordedSc} />

        <Statistics sc={recordedSc} />
      </div>

      <aside className="space-y-4">
        <FunctionPanel />

        <RangePanel />

        <Panel title="Hold & Relative">
          <div className="space-y-3">
            <Seg size="xs" className="w-full" value={dmm.holdMode} options={HOLD_MODES.map((h) => ({ id: h, label: { MAN: 'Manual', DEL: 'Delay', STAB: 'Stable', AUTO: 'Auto' }[h] }))} onChange={(holdMode) => patch('dmm', { holdMode })} />
            <div className="grid grid-cols-2 gap-2">
              <Btn tone="amber" active={dmm.hold} onClick={() => patch('dmm', { hold: !dmm.hold })}>HOLD</Btn>
              <Btn tone="neutral" active={dmm.rel} onClick={() => patch('dmm', { rel: !dmm.rel })}>REL Δ</Btn>
            </div>
            {dmm.holdMode !== 'MAN' && <p className="text-[11px] text-muted">Device arms and captures by itself ({dmm.holdMode === 'STAB' ? 'when the reading settles' : dmm.holdMode === 'DEL' ? 'after a delay' : 'on each new stable value'}).</p>}
          </div>
        </Panel>

        {(dmm.func === 'TEMP' || junctionNeeded) && (
          <Panel title="Thermocouple">
            <div className="space-y-2">
              <label className="flex items-center justify-between text-xs">
                <span className="text-muted">Manual junction °C</span>
                <input
                  key={dmm.cj ?? 'unset'}
                  type="number"
                  step="0.1"
                  min={-50}
                  max={100}
                  placeholder="—"
                  defaultValue={dmm.cj ?? ''}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  onBlur={(e) => {
                    const v = e.target.value.trim() === '' ? NaN : +e.target.value;
                    // Firmware range and step: −50.0 … 100.0 °C in 0.1 °C (else -222).
                    const cj = Number.isFinite(v) ? Math.min(100, Math.max(-50, Math.round(v * 10) / 10)) : dmm.cj;
                    if (cj !== dmm.cj) patch('dmm', { cj });
                    e.target.value = cj === null ? '' : String(cj); // show what was sent (clamped/rounded)
                  }}
                  className="w-20 rounded border border-border bg-canvas px-2 py-1 text-right font-mono"
                />
              </label>
              <p className="text-[11px] text-muted">Entering a value switches the meter to this manual junction. Back to the built-in sensor: MENU → Measurement → Junction source on the meter.</p>
            </div>
          </Panel>
        )}

        <LogPanel sc={sc} />
      </aside>
    </div>
  );
}

type Scale = ReturnType<typeof dmmScale>;

// Chart and statistics are in the recording's unit and decimals, whatever the meter measures now.
function useRecordedScale(live: Scale): Scale {
  const recorded = useDev((s) => s.recorded);
  return recorded ? dmmScale(recorded.func, recorded.rangeMax, recorded.fahrenheit) : live;
}

function Statistics({ sc }: { sc: Scale }) {
  const dstats = useDev((s) => s.dstats);
  const n = dstats.n;
  // Average and σ resolve below one display count, so they get two extra decimals.
  const fmt = (x: number, extra = 0) => (n ? `${(x / sc.div).toFixed(sc.dp + extra)} ${sc.unit}` : '—');
  return (
    <Panel title="Statistics">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
        <Stat label="Average" value={fmt(dstats.mean, 2)} />
        <Stat label="Minimum" value={fmt(dstats.min)} tone="text-success" />
        <Stat label="Maximum" value={fmt(dstats.max)} tone="text-danger" />
        <Stat label="Peak to peak" value={fmt(dstats.max - dstats.min)} />
        <Stat label="Std dev σ" value={fmt(stdDev(dstats), 2)} />
        <Stat label="Count" value={n ? n.toLocaleString('en') : '—'} />
      </div>
    </Panel>
  );
}

function Trend({ sc }: { sc: Scale }) {
  const recRev = useDev((s) => s.recRev);
  const dstats = useDev((s) => s.dstats);
  const center = useDev((s) => s.reading?.v ?? 0);
  const [kind, setKind] = useState<'line' | 'hist'>('line');
  const [win, setWin] = useState(60);
  const [manual, setManual] = useManualY();
  const legend = useRef<HTMLDivElement>(null);
  const { end, x0, x1 } = useTimeWindow(win);
  // `recRev` is the recording's change signal: `io.dmmRec` itself keeps its identity.
  const trace = useMemo(() => decimate(io.dmmRec, x0, x1), [recRev, x0, x1]);
  const gaps = useRef(trace.gaps);
  gaps.current = trace.gaps;
  const width = dstats.lsd || sc.lsd;
  const bins = useMemo(() => (kind === 'hist' ? histogram(dstats.counts, width, center) : []), [kind, dstats, width, center]);
  const hdp = Math.max(0, Math.round(-Math.log10(width / sc.div)));

  // Rebuilt only when the axis format changes: `sc` is a new object on every reading.
  const opts = useMemo(
    () => ({ ...trendOpts(kind, sc, manual, hdp), legend: legendIn(legend), ...(kind === 'line' ? { hooks: { draw: [gapTicks(gaps)] } } : {}) }),
    [kind, sc.div, sc.dp, sc.lsd, manual, hdp],
  );
  const data = useMemo<uPlot.AlignedData>(
    () => (kind === 'hist'
      ? [bins.map((b) => b.value), bins.map((b) => (b.kind === 'in' ? b.count : null)), bins.map((b) => (b.kind === 'in' ? null : b.count))]
      // The last reading holds until now: a stepped line ends at its last point, so without this tail
      // HOLD or a slow function (large CAP) scrolls the trace out of a short window.
      : trace.v.at(-1) != null && end > trace.t.at(-1)! ? [[...trace.t, end], [...trace.v, trace.v.at(-1)!]] : [trace.t, trace.v]),
    [kind, bins, trace, end],
  );

  const setY = (lo: number, hi: number) => { if (lo < hi) setManual({ lo, hi }); };
  return (
    <Panel
      title={kind === 'line' ? 'Trend' : 'Distribution'}
      right={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {/* One trace: clicking the legend must not hide it. */}
          <div ref={legend} className="head-legend dmm-legend pointer-events-none font-mono text-xs" />
          <Seg size="xs" value={kind} options={KINDS} onChange={setKind} />
          {kind === 'line' && <Seg size="xs" value={win} options={WINDOWS} onChange={setWin} />}
        </div>
      }
    >
      <div className="relative">
        <Plot opts={opts} data={data} x={kind === 'line' ? [x0, x1] : undefined} className="h-64" />
        <ChartNotes manual={kind === 'line' ? manual : null} trace={trace} x0={x0} x1={x1} sc={sc} />
      </div>
      {kind === 'line' ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="w-36"><Toggle label="Auto Y" on={!manual} onChange={(auto) => setManual(auto ? null : range(yAuto(...windowExtent(trace.t, trace.v, x0, x1), sc.lsd)))} /></div>
          {manual && <YInput label="Min" v={manual.lo} sc={sc} onCommit={(lo) => setY(lo, manual.hi)} />}
          {manual && <YInput label="Max" v={manual.hi} sc={sc} onCommit={(hi) => setY(manual.lo, hi)} />}
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-muted">{dstats.n.toLocaleString('en')} readings recorded, one bar per display count{bins.some((b) => b.kind !== 'in') ? ' · amber: beyond ±100 counts' : ''}.</p>
      )}
    </Panel>
  );
}

// An amber tick at the bottom of the plot for each gap (OL, blank, pause): on a wide window a short one
// is narrower than a pixel, so the line's own break can't show it.
const gapTicks = (gaps: RefObject<number[]>) => (u: uPlot) => {
  const { ctx, bbox } = u, dpr = devicePixelRatio, bottom = bbox.top + bbox.height;
  ctx.save();
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  for (const t of gaps.current) {
    const x = Math.round(u.valToPos(t, 'x', true));
    if (x < bbox.left || x > bbox.left + bbox.width) continue;
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom - 6 * dpr);
  }
  ctx.stroke();
  ctx.restore();
};

// The line view's x window. A bounded one starts at the first reading while it fills (the trace grows
// rightward), then rolls with the clock while logging (also when HOLD stops new readings). Not logging,
// it ends at the last point.
function useTimeWindow(win: number) {
  const logging = useDev((s) => s.logging);
  useDev((s) => s.recRev); // re-read io.dmmRec when the recording changes
  const now = useNow(1000);
  const { first, last } = io.dmmRec;
  const end = !logging && last !== undefined ? last : Math.max(now, last ?? 0), t0 = first ?? end;
  const x0 = win ? Math.max(t0, end - win) : t0, x1 = win ? x0 + win : Math.max(end, t0 + 10);
  return { end, x0, x1 };
}

// Text over the plot: how to fill an empty chart, and which side of a manual Y range cuts readings off.
function ChartNotes({ manual, trace, x0, x1, sc }: { manual: { lo: number; hi: number } | null; trace: Trace; x0: number; x1: number; sc: Scale }) {
  if (!io.dmmRec.length) return <EmptyNote sc={sc} />;
  if (!manual) return null;
  const [lo, hi] = windowExtent(trace.t, trace.v, x0, x1);
  const value = (x: number) => fmtIn(x, sc);
  const label = 'pointer-events-none absolute right-2 z-10 rounded border border-amber/50 bg-panel px-2 py-0.5 font-mono text-[11px] text-amber';
  return (
    <>
      {hi > manual.hi && <span className={clsx(label, 'top-1')}>▲ above range: {value(hi)}</span>}
      {lo < manual.lo && <span className={clsx(label, 'bottom-14')}>▼ below range: {value(lo)}</span>}
    </>
  );
}

const fmtIn = (x: number, sc: Scale) => `${(x / sc.div).toFixed(sc.dp)} ${sc.unit}`;

// An empty chart names the start control as it reads now, or, armed, the condition it waits for.
function EmptyNote({ sc }: { sc: Scale }) {
  const logging = useDev((s) => s.logging);
  const armed = useDev(shownArmed);
  const start = useDev((s) => io.liveTrig(s).start);
  if (logging) return null;
  const text = armed && start
    ? `Waiting for the start condition: ${start.above ? 'above' : 'below'} ${fmtIn(start.v, sc)}`
    : `Press "${start ? 'Arm' : 'Start logging'}" to chart readings and collect statistics`;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center pr-3 pb-6 pl-18">
      <p className="rounded-md border border-border bg-panel px-3 py-2 text-center text-sm text-muted">{text}</p>
    </div>
  );
}

// The manual Y range is in one unit: a chart of another function or unit drops back to auto.
function useManualY() {
  const key = useDev((s) => {
    const { func, fahrenheit } = s.recorded ?? { func: s.dmm.func, fahrenheit: s.fahrenheit };
    return `${func} ${dmmBase(func, fahrenheit)}`;
  });
  const [y, setY] = useState<{ key: string; lo: number; hi: number } | null>(null);
  return [y?.key === key ? y : null, (r: { lo: number; hi: number } | null) => setY(r && { key, ...r })] as const;
}

const yAuto = (mn: number, mx: number, lsd: number) => uPlot.rangeNum(...yFloor(mn, mx, lsd), 0.1, true) as [number, number];

// Line: time axis, x window set by Plot's `x`; Histogram: ordinal x over the bin values.
function trendOpts(kind: 'line' | 'hist', sc: Scale, manual: { lo: number; hi: number } | null, hdp: number): Omit<uPlot.Options, 'width' | 'height'> {
  const cursor = { y: false, drag: { x: false } };
  // A histogram bin; the edge ones (series 2) hold everything beyond the window: ≤ / ≥ their value.
  const bin = (u: uPlot, v: number) => {
    const i = u.data[0].indexOf(v), edge = u.data[2][i] != null ? (i === 0 ? '≤' : '≥') : '';
    return edge + (v / sc.div).toFixed(hdp);
  };
  if (kind === 'hist') return {
    cursor,
    scales: { x: { time: false, distr: 2 }, y: { range: { min: { pad: 0, soft: 0, mode: 1 }, max: { pad: 0.1, soft: 0, mode: 3 } } } },
    axes: [
      { ...AXIS, values: (u, t) => t.map((v) => bin(u, v)) },
      { ...AXIS, size: 56 },
    ],
    series: [
      { label: 'Value', value: (u, v) => (v == null ? '—' : `${bin(u, v)} ${sc.unit}`) },
      { label: 'Count', value: legendValue(String), stroke: '#3b82f6', fill: 'rgba(59,130,246,0.6)', paths: BARS, points: { show: false } },
      { label: 'Beyond', value: legendValue(String), stroke: '#f59e0b', fill: 'rgba(245,158,11,0.7)', paths: BARS, points: { show: false } },
    ],
  };
  return {
    // The value under the cursor is the one the stepped line shows there, with that reading's time.
    cursor: { ...cursor, dataIdx: (u, _series, near, x) => heldIdx(u.data[0], near, x) },
    scales: {
      x: { time: true, auto: false },
      y: { range: manual ? [manual.lo, manual.hi] : (_u, mn, mx) => yAuto(mn, mx, sc.lsd) },
    },
    axes: [
      { ...AXIS, space: 70, incrs: TIME_INCRS, values: TIME_FMT },
      { ...AXIS, size: 70, values: (_u, t) => t.map((v) => (v == null ? '' : (v / sc.div).toFixed(sc.dp))) },
    ],
    series: [
      { label: 'Time', value: legendValue((t) => CLOCK(new Date(t * 1000))) },
      { label: 'Value', value: legendValue((v) => `${(v / sc.div).toFixed(sc.dp)} ${sc.unit}`), stroke: '#3b82f6', width: 1.5, fill: 'rgba(59,130,246,0.08)', paths: STEPPED, points: { show: false } },
    ],
  };
}

const range = ([lo, hi]: [number, number]) => ({ lo, hi });

// Typed in the display unit; an unparseable or crossing value snaps back to the current one. The
// field shows rounded text, so left untouched it commits nothing.
function YInput({ label, v, sc, onCommit, disabled }: { label: string; v: number; sc: Scale; onCommit: (x: number) => void; disabled?: boolean }) {
  const shown = (v / sc.div).toFixed(sc.dp);
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <input
        key={shown}
        type="number"
        step={10 ** -sc.dp}
        defaultValue={shown}
        disabled={disabled}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        onBlur={(e) => {
          const x = e.target.value.trim() === '' ? NaN : +e.target.value * sc.div;
          if (e.target.value !== shown && Number.isFinite(x)) onCommit(x);
          e.target.value = shown;
        }}
        className="w-24 rounded border border-border bg-canvas px-2 py-1 text-right font-mono disabled:opacity-40"
      />
      <span className="text-muted">{sc.unit}</span>
    </label>
  );
}

function useNow(ms: number) {
  const [t, setT] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setT(Date.now() / 1000), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

function FunctionPanel() {
  const func = useDev((s) => s.dmm.func);
  const junctionNeeded = useDev((s) => s.junctionNeeded);
  const patch = useDev((s) => s.patch);
  return (
    <Panel title="Function">
      <div className="grid grid-cols-3 gap-1.5">
        {GROUPS.map((g) => {
          const active = g.includes(func);
          const cur = DMM_FUNCS.find((x) => x.id === (active ? func : g[0]))!;
          const next = active && g.length > 1 ? g[1 - g.indexOf(func)] : g[0];
          return (
            <button
              key={g[0]}
              title={g.length > 1 ? `${cur.label} · click again for ${DMM_FUNCS.find((x) => x.id === g[1 - g.indexOf(cur.id)])!.label}` : cur.label}
              onClick={() => patch('dmm', { func: next, range: 0, auto: true, rel: false, hold: false })}
              className={clsx(
                'flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-md border font-mono text-sm font-semibold transition-colors',
                active ? 'border-accent bg-accent/15 text-fg' : 'border-border bg-canvas text-muted hover:text-fg',
              )}
            >
              {g.length > 1 ? cur.short.replace(/[⎓~]/, '') : cur.short}
              {g.length > 1 && (
                <span className="flex gap-1.5 text-xs">
                  {g.map((id) => <span key={id} className={id === func ? 'font-bold text-accent' : 'font-normal text-muted'}>{id.endsWith('AC') ? 'AC' : 'DC'}</span>)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {junctionNeeded && (
        <p className="mt-2 text-[11px] text-amber">Type K needs a cold junction: enter a manual junction below, or pick MCU in MENU → Measurement → Junction source on the meter. Then press °C again.</p>
      )}
    </Panel>
  );
}

function RangePanel() {
  const dmm = useDev((s) => s.dmm);
  const ranges = useDev((s) => s.ranges);
  const patch = useDev((s) => s.patch);
  const base = DMM_FUNCS.find((x) => x.id === dmm.func)!.base;
  if (!ranges.length) return null; // RANG:LIST? is empty for continuity, diode and Type K: nothing to choose
  return (
    <Panel title="Range">
      <div className="space-y-3">
        <Toggle label="Auto range" on={dmm.auto} onChange={(auto) => patch('dmm', { auto })} />
        <div className="flex flex-wrap gap-1">
          {ranges.map((r, i) => (
            <button
              key={i}
              disabled={dmm.auto}
              onClick={() => patch('dmm', { range: i })}
              className={clsx(
                'rounded border px-2 py-1 font-mono text-[11px] disabled:opacity-40',
                i === dmm.range ? 'border-accent bg-accent/15 text-fg' : 'border-border text-muted hover:text-fg',
              )}
            >
              {siLabel(r, base)}
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

// Armed as the panel shows it: not for conditions of another function, cleared by its first reading.
const shownArmed = (s: State) => s.armed && io.liveTrig(s) === s.trig;

// REC while logging, ARM while waiting for the start condition.
function LogBadge() {
  const logging = useDev((s) => s.logging);
  const armed = useDev(shownArmed);
  if (logging) return <Badge tone="danger" pulse>REC</Badge>;
  return armed ? <Badge tone="amber">ARM</Badge> : null;
}

function LogPanel({ sc }: { sc: Scale }) {
  const logged = useDev((s) => s.dstats.n);
  const logging = useDev((s) => s.logging);
  const link = useDev((s) => s.link);
  const recorded = useDev((s) => s.recorded);
  const func = useDev((s) => s.dmm.func);
  const fahrenheit = useDev((s) => s.fahrenheit);
  const full = useDev(io.atLimit);
  const offered = useDev((s) => s.savedOffer !== null);
  // Data of another function or unit stays until cleared: nothing can be added to it.
  const other = !logging && logged > 0 && !io.logMatches(recorded, func, fahrenheit) ? recorded : null;
  const blocked = offered
    ? 'Restore or discard the saved recording first.'
    : full
    ? `The limit of ${REC_MAX.toLocaleString('en')} readings is reached. Export the CSV, then press "Clear data" to start a new recording.`
    : other && `The data is from ${funcName(other.func, other.fahrenheit)}. Switch back to it, or press "Clear data" to record something else.`;
  return (
    <Panel title="Logging">
      <div className="space-y-2">
        <Row2 label="Logged rows" value={logged.toLocaleString('en')} />
        <SaveStatus />
        <TriggerRows sc={sc} />
        <StartButton blocked={blocked || null} />
        <div className="grid grid-cols-2 gap-2">
          <Btn disabled={!logged} onClick={io.exportDmmLog}><Download size={13} /> CSV</Btn>
          {/* Also resets the meter's own statistics, so it works with nothing recorded. */}
          <Btn tone="danger" disabled={link !== 'connected' && !logged} onClick={() => void io.clearDmmData()}><Trash2 size={13} /> Clear data</Btn>
        </div>
      </div>
    </Panel>
  );
}

// Start logging / Arm while idle (refused with the reason when `blocked`), Disarm / Stop logging after.
function StartButton({ blocked }: { blocked: string | null }) {
  const logging = useDev((s) => s.logging);
  const armed = useDev(shownArmed);
  const arms = useDev((s) => io.liveTrig(s).start !== null);
  if (logging || armed) {
    return <Btn tone={logging ? 'danger' : 'amber'} className="w-full" onClick={io.stopDmmLog}><Pause size={13} /> {logging ? 'Stop logging' : 'Disarm'}</Btn>;
  }
  return (
    <>
      <Btn tone="success" className="w-full" disabled={!!blocked} onClick={io.startDmmLog}><Play size={13} /> {arms ? 'Arm' : 'Start logging'}</Btn>
      {blocked && <p className="text-[11px] text-amber">{blocked}</p>}
    </>
  );
}

// Start and stop conditions in the live function's unit. The start is locked once armed or logging.
function TriggerRows({ sc }: { sc: Scale }) {
  const trig = useDev(io.liveTrig);
  const locked = useDev((s) => s.armed || s.logging);
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <CondRow label="Start when" c={trig.start} sc={sc} disabled={locked} onChange={(start) => io.setTrig({ start })} />
      <CondRow label="Stop when" c={trig.stop} sc={sc} onChange={(stop) => io.setTrig({ stop })} />
      {trig.start && <Toggle label="Repeat (arm again after each stop)" on={trig.repeat} onChange={(repeat) => io.setTrig({ repeat })} />}
    </div>
  );
}

const DIRS = [{ id: 'above' as const, label: 'above' }, { id: 'below' as const, label: 'below' }];

function CondRow({ label, c, sc, disabled, onChange }: { label: string; c: Cond | null; sc: Scale; disabled?: boolean; onChange: (c: Cond | null) => void }) {
  // Starts at the reading now: the value the user is most likely to want near.
  const turnOn = () => onChange({ above: true, v: useDev.getState().reading?.v ?? 0 });
  return (
    <div className="space-y-1.5">
      <Toggle label={label} on={c !== null} disabled={disabled} onChange={(on) => (on ? turnOn() : onChange(null))} />
      {c && (
        <div className="flex items-center justify-between gap-2">
          <Seg size="xs" value={c.above ? 'above' : 'below'} options={DIRS.map((d) => ({ ...d, disabled }))} onChange={(d) => onChange({ ...c, above: d === 'above' })} />
          <YInput label="" v={c.v} sc={sc} disabled={disabled} onCommit={(v) => onChange({ ...c, v })} />
        </div>
      )}
    </div>
  );
}

const NOT_SAVED: Record<SaveOff, string> = { unavailable: 'storage unavailable', full: 'storage full', 'other-tab': 'another tab holds the saved recording', failed: 'storage error' };

// Whether the recording would survive a reload.
function SaveStatus() {
  const st = useDev((s) => s.saveState);
  if (st.kind !== 'off') return <Row2 label="Saved" value={st.kind === 'saved' ? CLOCK(new Date(st.at)) : '—'} />;
  return <p className="text-[11px] text-amber">Not saved: {NOT_SAVED[st.why]}. A reload loses this recording.</p>;
}

// A recording found in storage when the page opened: nothing comes back without a choice.
function SavedNotice() {
  const offer = useDev((s) => s.savedOffer);
  const [busy, setBusy] = useState(false);
  if (!offer) return null;
  const run = (action: () => Promise<void>) => () => { setBusy(true); void action().finally(() => setBusy(false)); };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-accent/50 bg-panel px-4 py-3 text-sm">
      <p className="min-w-0 flex-1">
        {offer.known
          ? <>Saved recording: <b>{funcName(offer.func, offer.fahrenheit)}</b>, {offer.valid.toLocaleString('en')} readings, last at {new Date(offer.last * 1000).toLocaleString()}.</>
          : 'A recording saved by another version of the app cannot be restored.'}
      </p>
      <div className="flex gap-2">
        {offer.known && <Btn tone="success" disabled={busy} onClick={run(io.restoreSaved)}>{busy ? 'Restoring…' : 'Restore'}</Btn>}
        <Btn tone="danger" disabled={busy} onClick={run(io.discardSaved)}>Discard</Btn>
      </div>
    </div>
  );
}

// A function as the message names it; temperature with its unit, which also has to match.
const funcName = (func: DmmFunc, fahrenheit: boolean) =>
  DMM_FUNCS.find((x) => x.id === func)!.label + (func === 'TEMP' ? ` in ${dmmBase(func, fahrenheit)}` : '');

function Badge({ tone, pulse, children }: { tone: 'muted' | 'accent' | 'amber' | 'danger' | 'success'; pulse?: boolean; children: React.ReactNode }) {
  const c = { muted: 'border-border text-muted', accent: 'border-accent/50 text-accent', amber: 'border-amber/50 text-amber', danger: 'border-danger/50 text-danger', success: 'border-success/40 text-success' }[tone];
  return (
    <span className={clsx('flex items-center gap-1.5 rounded border px-2 py-0.5', c)}>
      {pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" />}
      {children}
    </span>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <span><span className="text-muted">{label}: </span><span className="font-medium">{value}</span></span>;
}

function Row2({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-xs"><span className="text-muted">{label}</span><span className="font-mono">{value}</span></div>;
}
