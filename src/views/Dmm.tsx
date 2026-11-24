import { clsx } from 'clsx';
import { Download, Pause, Play, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type uPlot from 'uplot';
import { DMM_FUNCS, HOLD_MODES, scaleFor, type DmmFunc } from '../device';
import * as io from '../io';
import { AXIS, Plot } from '../Plot';
import { useDev } from '../store';
import { Btn, Panel, Seg, Stat, Toggle } from '../ui';

// One button per group; the second entry is reached by clicking the active button again.
const GROUPS: DmmFunc[][] = [['VDC', 'MVDC'], ['VAC', 'MVAC'], ['ADC', 'MADC'], ['AAC', 'MAAC'], ['RES'], ['CONT'], ['DIOD'], ['CAP'], ['TEMP']];

const WINDOWS = [{ id: 60, label: '1m' }, { id: 600, label: '10m' }, { id: 3600, label: '1h' }, { id: 0, label: 'all' }];

const siLabel = (v: number, base: string) => {
  const s = scaleFor(v, base);
  return `${+(v / s.div).toPrecision(4)} ${s.unit}`;
};

export function Dmm() {
  const dmm = useDev((s) => s.dmm);
  const patch = useDev((s) => s.patch);
  const ranges = useDev((s) => s.ranges);
  const reading = useDev((s) => s.reading);
  const logging = useDev((s) => s.logging);
  const hist = useDev((s) => s.hist);
  const f = DMM_FUNCS.find((x) => x.id === dmm.func)!;
  const [win, setWin] = useState(60);

  const ref = ranges[dmm.range] ?? (reading?.v ? Math.abs(reading.v) : 1);
  const sc = scaleFor(ref, f.base);
  const fmt = (x: number) => (x / sc.div).toFixed(sc.dp);
  const ac = dmm.func.endsWith('AC');

  const stats = useMemo(() => {
    const v = hist.v;
    if (!v.length) return null;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const x of v) { if (x < min) min = x; if (x > max) max = x; sum += x; }
    return { n: v.length, min, max, avg: sum / v.length, pp: max - min };
  }, [hist]);

  const opts = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(() => ({
    legend: { show: false },
    cursor: { y: false },
    scales: { x: { time: false, range: (_u, min, max) => (win ? [max - win, max] : [min, max]) } },
    axes: [
      { ...AXIS, values: (u, t) => t.map((v) => (v == null ? '' : ago(u.scales.x.max! - v))) },
      { ...AXIS, size: 70, values: (_u, t) => t.map((v) => (v == null ? '' : `${+(v / sc.div).toFixed(sc.dp)}`)) },
    ],
    series: [{}, { stroke: '#3b82f6', width: 1.5, fill: 'rgba(59,130,246,0.08)' }],
  }), [sc.div, sc.dp, win]);

  const data = useMemo<uPlot.AlignedData>(() => {
    const cut = win ? Date.now() / 1000 - win : 0;
    const i = hist.t.findIndex((t) => t >= cut);
    return i < 0 ? [[], []] : [hist.t.slice(i), hist.v.slice(i)];
  }, [hist, win]);

  const shown = reading === null ? '- - - -' : reading.over ? 'OL' : reading.blank || reading.v === null ? '----' : fmt(reading.v);
  const live = reading !== null && !reading.blank && !reading.over;

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
              {logging && <Badge tone="danger" pulse>REC</Badge>}
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
            <Meta label="Seq" value={reading ? String(reading.seq) : '—'} />
          </div>
        </Panel>

        <Panel title="Trend" right={<Seg size="xs" value={win} options={WINDOWS} onChange={setWin} />}>
          <Plot opts={opts} data={data} className="h-64" />
        </Panel>

        <Panel title="Statistics" right={<Btn onClick={() => void io.resetDmmStats()} title="SYST:DMM:STAT:RES">Reset</Btn>}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Average" value={stats ? `${fmt(stats.avg)} ${sc.unit}` : '—'} />
            <Stat label="Minimum" value={stats ? `${fmt(stats.min)} ${sc.unit}` : '—'} tone="text-success" />
            <Stat label="Maximum" value={stats ? `${fmt(stats.max)} ${sc.unit}` : '—'} tone="text-danger" />
            <Stat label="Peak to peak" value={stats ? `${fmt(stats.pp)} ${sc.unit}` : '—'} />
            <Stat label="Count" value={stats ? stats.n.toLocaleString('en') : '—'} />
          </div>
        </Panel>
      </div>

      <aside className="space-y-4">
        <Panel title="Function">
          <div className="grid grid-cols-3 gap-1.5">
            {GROUPS.map((g) => {
              const active = g.includes(dmm.func);
              const cur = DMM_FUNCS.find((x) => x.id === (active ? dmm.func : g[0]))!;
              const alt = g.length > 1 ? DMM_FUNCS.find((x) => x.id === g[active ? 1 - g.indexOf(dmm.func) : 1])! : null;
              return (
                <button
                  key={g[0]}
                  title={alt ? `${cur.label} · click again for ${alt.label}` : cur.label}
                  // Clicking the active paired button flips V⇄mV / A⇄mA.
                  onClick={() => patch('dmm', { func: active && alt ? alt.id : g[0], range: 0, auto: true, rel: false, hold: false })}
                  className={clsx(
                    'flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-md border font-mono text-sm font-semibold transition-colors',
                    active ? 'border-accent bg-accent/15 text-fg' : 'border-border bg-canvas text-muted hover:text-fg',
                  )}
                >
                  {cur.short}
                  {alt && (
                    <span className="flex gap-1.5 text-xs">
                      {g.map((id) => {
                        const unit = DMM_FUNCS.find((x) => x.id === id)!.short.replace(/[⎓~]/, '');
                        return <span key={id} className={id === dmm.func ? 'font-bold text-accent' : 'font-normal text-muted'}>{unit}</span>;
                      })}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel title="Range">
          <div className="space-y-3">
            <Toggle label="Auto range" on={dmm.auto} disabled={!ranges.length} onChange={(auto) => patch('dmm', { auto })} />
            {ranges.length > 0 && (
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
                    {siLabel(r, f.base)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Panel>

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

        {dmm.func === 'TEMP' && (
          <Panel title="Thermocouple">
            <div className="space-y-2">
              <Toggle label="Cold-junction override" on={dmm.cj !== null} onChange={(v) => patch('dmm', { cj: v ? 25 : null })} />
              {dmm.cj !== null && (
                <label className="flex items-center justify-between text-xs">
                  <span className="text-muted">Junction °C</span>
                  <input type="number" step="0.1" defaultValue={dmm.cj} onBlur={(e) => patch('dmm', { cj: +e.target.value })} className="w-20 rounded border border-border bg-canvas px-2 py-1 text-right font-mono" />
                </label>
              )}
            </div>
          </Panel>
        )}

        <LogPanel />
      </aside>
    </div>
  );
}

function LogPanel() {
  const logged = useDev((s) => s.logged);
  const logging = useDev((s) => s.logging);
  const set = useDev((s) => s.set);
  return (
    <Panel title="Logging">
      <div className="space-y-2">
        <Row2 label="Logged rows" value={logged.toLocaleString('en')} />
        <Btn tone={logging ? 'danger' : 'success'} className="w-full" onClick={() => set({ logging: !logging })}>
          {logging ? <><Pause size={13} /> Stop logging</> : <><Play size={13} /> Start logging</>}
        </Btn>
        <div className="grid grid-cols-2 gap-2">
          <Btn disabled={!logged} onClick={io.exportDmmLog}><Download size={13} /> CSV</Btn>
          <Btn tone="danger" disabled={!logged} onClick={io.clearDmmLog}><Trash2 size={13} /> Clear</Btn>
        </div>
      </div>
    </Panel>
  );
}

function ago(s: number) {
  if (s < 0.5) return 'now';
  return s < 120 ? `-${Math.round(s)}s` : `-${Math.round(s / 60)}m`;
}

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
