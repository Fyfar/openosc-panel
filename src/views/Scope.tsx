import { clsx } from 'clsx';
import { ChevronRight, Crosshair, Info, Download, ImageDown, Play, Sparkles, Square, StepForward, Waves, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmtStable, fmtTime, fmtVolt, genHalvesScope, HALVED_NOTE, interleaveBlockers, MEM_DEPTHS, PROBES, TIMEBASES, vdiv, VDIV_MV } from '../device';
import { extent, measure, type Frame, type Meas } from '../dsp';
import * as io from '../io';
import { useDev, type Channel, type CursorMode, type State } from '../store';
import { Btn, CH_COLOR, Columns, M, Panel, Row, Seg, Select, Stepper, strokeGrid, Toggle } from '../ui';
import { COLOR as FFT_COLOR, fftPngText, FONT, SpectrumPanel, SpectrumReadout, wrap } from './ScopeFft';

// Roll runs with Auto sweep from 200 ms/div (wiki: Oscilloscope → Roll mode).
const isRolling = (s: State['scope']) => s.roll && s.sweep === 'AUTO' && TIMEBASES[s.tb] >= 0.2;

// Cursor lines: time a/b and level ya/yb, normalized to the plot (0 = left / top).
type CurLine = 'a' | 'b' | 'ya' | 'yb';
type Cur = Record<CurLine, number> & { drag: CurLine | null };
const hasT = (m: CursorMode) => m === 'T' || m === 'TV';
const hasV = (m: CursorMode) => m === 'V' || m === 'TV';
const CURSOR_MODES: { id: CursorMode; label: string }[] = [{ id: 'OFF', label: 'Off' }, { id: 'T', label: 'Time' }, { id: 'V', label: 'Level' }, { id: 'TV', label: 'Both' }];
const CURSOR_CLASS: Record<CursorMode, string | false> = { OFF: false, T: 'cursor-ew-resize', V: 'cursor-ns-resize', TV: 'cursor-crosshair' };

function nearestLine(c: Cur, mode: CursorMode, x: number, y: number, w: number, h: number): CurLine {
  const lines: [CurLine, number][] = [];
  if (hasT(mode)) lines.push(['a', Math.abs(x - c.a) * w], ['b', Math.abs(x - c.b) * w]);
  if (hasV(mode)) lines.push(['ya', Math.abs(y - c.ya) * h], ['yb', Math.abs(y - c.yb) * h]);
  return lines.reduce((m, l) => (l[1] < m[1] ? l : m))[0];
}

export function Scope() {
  const s = useDev((st) => st.scope);
  const status = useDev((st) => st.scopeStatus);
  const halved = genHalvesScope(useDev((st) => st.model), useDev((st) => st.gen));
  const patch = useDev((st) => st.patch);
  const cursors = useDev((st) => st.cursors);
  const fft = useDev((st) => st.fft);
  const setView = useDev((st) => st.set);
  const [toast, setToast] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cur = useRef<Cur>({ a: 0.3, b: 0.7, ya: 0.3, yb: 0.55, drag: null });
  const fftCanvas = useRef<HTMLCanvasElement>(null);
  const onDrag = useRef(() => {}); // the cursor readouts follow a drag (set by Measurements)

  const set = (p: Partial<typeof s>) => patch('scope', p);
  const setCh = (i: 0 | 1, p: Partial<Channel>) => {
    const ch = [...s.ch] as [Channel, Channel];
    ch[i] = { ...ch[i], ...p };
    set({ ch });
  };
  const stopped = status.stat === 'STOP';
  const say = (m: string, ms = 3000) => { setToast(m); setTimeout(() => setToast((t) => (t === m ? null : t)), ms); };
  const auto = async () => { setToast('Auto setup… (frame reads paused)'); say(await io.scopeAuto(), 4000); };
  const csv = async () => { setToast('Fetching full record…'); await io.exportScopeCsv(); setToast(null); };

  useDrawLoop(canvas, cur);

  const tb = TIMEBASES[s.tb];
  const recordS = s.mdepth / status.srate;

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (cursors === 'OFF') return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const c = cur.current;
    if (e.type === 'pointerdown') {
      c.drag = nearestLine(c, cursors, x, y, r.width, r.height);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (e.type === 'pointerup') c.drag = null;
    if (c.drag) {
      c[c.drag] = Math.min(1, Math.max(0, c.drag.startsWith('y') ? y : x));
      onDrag.current();
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Btn tone={stopped ? 'danger' : 'success'} active className="w-24" onClick={() => void (stopped ? io.scopeRun() : io.scopeStop())}>
            {stopped ? <><Square size={12} /> Stopped</> : <><Play size={12} /> Running</>}
          </Btn>
          <Btn onClick={() => void io.scopeSingle()} active={s.sweep === 'SING'}><StepForward size={13} /> Single</Btn>
          <Btn onClick={() => void io.scopeForce()} disabled={status.stat !== 'WAIT'} title="TFORce"><Zap size={13} /> Force</Btn>
          <Btn onClick={() => void auto()}><Sparkles size={13} /> Auto</Btn>
          <span className={clsx('rounded border px-2 py-0.5 font-mono text-xs font-semibold', {
            TD: 'border-success/40 text-success', RUN: 'border-success/40 text-success', AUTO: 'border-amber/40 text-amber', WAIT: 'border-amber/40 text-amber', STOP: 'border-danger/40 text-danger',
          }[status.stat] ?? 'border-border text-muted')}>{status.stat}</span>
          {toast && <span className="text-xs text-muted">{toast}</span>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted"><Crosshair size={13} /><Seg size="xs" value={cursors} options={CURSOR_MODES} onChange={(c) => setView({ cursors: c })} /></span>
            <Btn active={fft} onClick={() => setView({ fft: !fft })}><Waves size={13} /> FFT</Btn>
            <Btn title="Fetch the full record and save CSV" onClick={() => void csv()}><Download size={13} /> CSV</Btn>
            <Btn title="Save plot as PNG" onClick={() => savePng(canvas.current!, fftCanvas.current)}><ImageDown size={13} /></Btn>
          </div>
        </div>

        <div className="relative overflow-hidden rounded-lg border border-border bg-[#07090d]">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-between px-3 py-1.5 font-mono text-[11px] text-muted">
            <span>
              {fmtTime(tb)}/div · {fmtSps(status.srate)}{halved && <span className="text-amber" title={HALVED_NOTE}> (GEN: max /2)</span>} · {(s.mdepth / 1024).toFixed(0)}K pts
              {status.capture.active && !isRolling(s) && recordS > 1 && (
                <span className="text-amber"> · {status.stat === 'WAIT' ? 'waiting' : 'capturing'} {Math.round((performance.now() - status.capture.since) / 1000)} s</span>
              )}
            </span>
            <span>T {s.trig.slope === 'POS' ? '↑' : '↓'} CH{s.trig.src} {fmtVolt(s.trig.level)}</span>
          </div>
          <canvas
            ref={canvas}
            onPointerDown={onPointer}
            onPointerMove={onPointer}
            onPointerUp={onPointer}
            className={clsx('block w-full', fft ? 'h-[clamp(240px,40vh,460px)]' : 'h-[clamp(320px,58vh,680px)]', CURSOR_CLASS[cursors])}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex gap-4 px-3 py-1.5 font-mono text-[11px]">
            {s.ch.map((c, i) => c.on && (
              <span key={i} style={{ color: CH_COLOR[i] }}>CH{i + 1} {fmtVolt(vdiv(c))}/div {c.coup} ×{c.probe}</span>
            ))}
          </div>
        </div>

        {fft && <SpectrumPanel canvas={fftCanvas} />}

        <Measurements cur={cur} onDrag={onDrag} />
      </div>

      <Sidebar s={s} set={set} setCh={setCh} say={say} />
    </div>
  );
}

function TriggerBody({ s, set, say }: { s: State['scope']; set: (p: Partial<State['scope']>) => void; say: (m: string) => void }) {
  const src = s.ch[s.trig.src - 1], srcVd = vdiv(src);
  // TIM:OFFS and TRIG:POS set the same firmware value (the trigger position), so both go to centre.
  const center = () => set({ hoff: 0, trig: { ...s.trig, pos: 50 } });
  // The device's hold-F3 / "Trigger 50%": level to the signal midpoint, pretrigger 50 %.
  const trigger50 = () => {
    const f = io.scopeData.frames.find((fr) => fr.ch === s.trig.src - 1);
    if (!f) return say('No frame from the trigger channel yet');
    const lo = extent(f.lo ?? f.volts).mn, hi = extent(f.hi ?? f.volts).mx;
    set({ hoff: 0, trig: { ...s.trig, level: +((lo + hi) / 2).toPrecision(4), pos: 50 } });
  };
  return (
    <div className="space-y-3">
        <Row label="Slope">
          <Seg size="xs" value={s.trig.slope} options={[{ id: 'POS', label: '↑ Rising' }, { id: 'NEG', label: '↓ Falling' }]} onChange={(slope) => set({ trig: { ...s.trig, slope } })} />
        </Row>
        <Row label="Sweep">
          <Seg size="xs" value={s.sweep} options={[{ id: 'AUTO', label: 'Auto' }, { id: 'NORM', label: 'Normal' }, { id: 'SING', label: 'Single' }]} onChange={(sweep) => (sweep === 'SING' ? void io.scopeSingle() : set({ sweep }))} />
        </Row>
        <Slider
          label="Level" value={s.trig.level} min={(-4 - src.offsetDiv) * srcVd} max={(4 - src.offsetDiv) * srcVd} step={srcVd / 25}
          show={fmtVolt(s.trig.level)} color={CH_COLOR[s.trig.src - 1]} onChange={(level) => set({ trig: { ...s.trig, level } })}
        />
        <Slider label="Position" value={s.trig.pos} min={0} max={100} step={0.5} show={`${s.trig.pos.toFixed(1)} %`} onChange={(pos) => set({ trig: { ...s.trig, pos } })} />
        <Toggle label="Noise reject" on={s.trig.nrej} onChange={(nrej) => set({ trig: { ...s.trig, nrej } })} />
        <div className="flex gap-2">
          <Btn className="flex-1" title="Level to the signal midpoint, pretrigger 50 %" onClick={trigger50}>Trigger 50 %</Btn>
          <Btn className="flex-1" title="Trigger mark to the middle of the screen (pretrigger 50 %)" onClick={center}>Center trigger</Btn>
        </div>
    </div>
  );
}

function InterleaveState({ requested, state }: { requested: State['scope']['interleave']; state: State['scopeStatus']['interleave'] }) {
  if (requested === 'OFF' || !state) return null;
  if (state.active) return <p className="text-[11px] text-success">Interleave in force</p>;
  const why = interleaveBlockers(state.blockers);
  return <p className="text-[11px] text-amber">Not in force{why.length ? `: ${why.join(', ')}` : ''}</p>;
}

function ChannelBody({ i, c, onChange }: { i: 0 | 1; c: Channel; onChange: (p: Partial<Channel>) => void }) {
  const color = CH_COLOR[i];
  return (
    <div className={clsx('space-y-3', !c.on && 'pointer-events-none opacity-40')}>
      <Stepper label="Volts/div" value={VDIV_MV.indexOf(c.vdivMv)} count={VDIV_MV.length} display={fmtVolt(vdiv(c))} color={color} onChange={(k) => onChange({ vdivMv: VDIV_MV[k] })} />
      <Slider label="Position" value={c.offsetDiv} min={-4} max={4} step={0.05} show={`${c.offsetDiv.toFixed(2)} div`} color={color} onChange={(offsetDiv) => onChange({ offsetDiv })} />
      <Row label="Probe">
        <Select label={`CH${i + 1} probe`} value={c.probe} options={PROBES.map((p) => ({ id: p, label: `×${p}` }))} onChange={(probe) => onChange({ probe })} />
      </Row>
    </div>
  );
}

// A sidebar section that folds to one line of its current values; each opens and closes on its own.
// `tail` is a control shown in the header while open, in place of the summary.
function Fold({ title, summary, open, onToggle, color, lead, tail, children }: {
  title: string; summary: string; open: boolean; onToggle: () => void; color?: string; lead?: React.ReactNode; tail?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-panel" style={{ borderColor: open && color ? `${color}55` : undefined }}>
      <div className="flex items-center gap-2 px-3">
        {lead}
        <button onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left text-sm font-semibold">
          <ChevronRight size={14} className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
          <span style={{ color }}>{title}</span>
          {!open && <span className="ml-auto truncate font-mono text-[11px] font-normal text-muted">{summary}</span>}
        </button>
        {open && tail}
      </div>
      {open && <div className="border-t border-border px-4 py-3">{children}</div>}
    </section>
  );
}

type FoldId = 'ch0' | 'ch1' | 'hor' | 'trig' | 'acq';
const SWEEP_LABEL = { AUTO: 'Auto', NORM: 'Normal', SING: 'Single' };

function Sidebar({ s, set, setCh, say }: {
  s: State['scope']; set: (p: Partial<State['scope']>) => void; setCh: (i: 0 | 1, p: Partial<Channel>) => void; say: (m: string) => void;
}) {
  const [open, setOpen] = useState<Set<FoldId>>(() => new Set(['ch0', 'hor', 'trig']));
  const fold = (id: FoldId) => ({
    open: open.has(id),
    onToggle: () => setOpen((o) => { const n = new Set(o); if (!n.delete(id)) n.add(id); return n; }),
  });
  const srate = useDev((st) => st.scopeStatus.srate);
  const tb = TIMEBASES[s.tb];
  return (
    <aside className="space-y-2">
      {([0, 1] as const).map((i) => {
        const c = s.ch[i], other = s.ch[1 - i];
        const lead = (
          <button
            onClick={() => setCh(i, { on: !c.on })}
            disabled={c.on && !other.on}
            aria-label={`Switch CH${i + 1} ${c.on ? 'off' : 'on'}`}
            aria-pressed={c.on}
            title={c.on && !other.on ? 'The last enabled channel cannot be switched off' : c.on ? 'Switch off' : 'Switch on'}
            className="flex h-5 w-9 shrink-0 items-center justify-center rounded font-mono text-[11px] font-bold text-black disabled:cursor-not-allowed"
            style={{ background: c.on ? CH_COLOR[i] : '#30363d' }}
          >
            {c.on ? 'ON' : 'OFF'}
          </button>
        );
        const summary = c.on ? `${fmtVolt(vdiv(c))}/div · ${c.coup} · ×${c.probe} · ${c.offsetDiv.toFixed(2)} div` : 'off';
        const coupling = (
          <Seg size="xs" value={c.coup} options={[{ id: 'DC', label: 'DC', disabled: !c.on }, { id: 'AC', label: 'AC', disabled: !c.on }]} onChange={(coup) => setCh(i, { coup })} />
        );
        return (
          <Fold key={i} title={`CH${i + 1}`} color={CH_COLOR[i]} lead={lead} tail={coupling} summary={summary} {...fold(i ? 'ch1' : 'ch0')}>
            <ChannelBody i={i} c={c} onChange={(p) => setCh(i, p)} />
          </Fold>
        );
      })}
      <Fold title="Horizontal" summary={`${fmtTime(tb)}/div · ${fmtTime(s.hoff)}`} {...fold('hor')}>
        <div className="space-y-3">
          <Stepper label="Time/div" value={s.tb} count={TIMEBASES.length} display={fmtTime(tb)} onChange={(tb) => set({ tb })} />
          <Slider label="Offset" value={s.hoff / tb} min={-5} max={5} step={0.1} show={fmtTime(s.hoff)} onChange={(d) => set({ hoff: d * tb })} />
        </div>
      </Fold>
      <Fold title="Trigger" summary={`CH${s.trig.src} ${s.trig.slope === 'POS' ? '↑' : '↓'} ${fmtVolt(s.trig.level)} · ${SWEEP_LABEL[s.sweep]}`} {...fold('trig')}
        tail={<Seg size="xs" value={s.trig.src} options={[{ id: 1, label: 'CH1', disabled: !s.ch[0].on }, { id: 2, label: 'CH2', disabled: !s.ch[1].on }]} onChange={(src) => set({ trig: { ...s.trig, src } })} />}
      >
        <TriggerBody s={s} set={set} say={say} />
      </Fold>
      <Fold title="Acquisition" summary={`${(s.mdepth / 1024).toFixed(0)}K · ${fmtSps(srate)}${s.roll ? ' · roll' : ''}`} {...fold('acq')}>
        <AcquisitionBody s={s} set={set} />
      </Fold>
    </aside>
  );
}

function AcquisitionBody({ s, set }: { s: State['scope']; set: (p: Partial<State['scope']>) => void }) {
  const status = useDev((st) => st.scopeStatus);
  const model = useDev((st) => st.model);
  const halved = genHalvesScope(model, useDev((st) => st.gen));
  const depths = MEM_DEPTHS.map((d) => (s.ch[0].on && s.ch[1].on ? d / 2 : d));
  return (
    <div className="space-y-3">
      <Row label="Points / channel">
        <Select label="Memory depth" value={depths.reduce((b, d) => (Math.abs(d - s.mdepth) < Math.abs(b - s.mdepth) ? d : b))} options={depths.map((d) => ({ id: d, label: `${d / 1024}K` }))} onChange={(mdepth) => set({ mdepth })} />
      </Row>
      <Row label="Sample rate"><span className="font-mono">{fmtSps(status.srate)}</span></Row>
      {halved && <p className="flex gap-1.5 text-[11px] text-amber"><Info size={13} className="shrink-0" /> {HALVED_NOTE}</p>}
      <Toggle label="Roll mode (slow timebases)" on={s.roll} onChange={(roll) => set({ roll })} />
      <Row label="CH1 interleave">
        <Seg
          size="xs" value={s.interleave} onChange={(interleave) => set({ interleave })}
          options={[{ id: 'OFF', label: 'Off' }, { id: 'ON', label: 'On', disabled: s.ch[1].on }, { id: 'AUTO', label: 'Auto' }]}
        />
      </Row>
      <InterleaveState requested={s.interleave} state={status.interleave} />
      <p className="text-[11px] text-muted">On doubles CH1 to 200 MSa/s with CH2 off{model === 'ZT703S' ? ' (experimental on the ZT703S)' : ''}; Auto interleaves only where the firmware's rule allows it (CH1 alone at 10 or 25 ns/div). Two channels split the memory budget.</p>
    </div>
  );
}

function Slider({ label, value, min, max, step, show, onChange, color }: {
  label: string; value: number; min: number; max: number; step: number; show: string; onChange: (v: number) => void; color?: string;
}) {
  return (
    <label className="block text-xs">
      <div className="mb-1 flex justify-between">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular-nums" style={{ color }}>{show}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} onDoubleClick={() => onChange(0)} className="w-full" style={{ accentColor: color ?? '#3b82f6' }} />
    </label>
  );
}

const SRC_HINT: Record<string, string> = {
  EDGE: 'device: from edges in the screen window',
  SPEC: 'device: estimated from the spectrum (fewer than 8 points per period)',
  CNT: 'device: hardware counter',
  NONE: 'device: no frequency found',
  HOST: 'computed in the browser from the live frame',
};

// The device's readouts (WAV:MEAS?, firmware ≥ 0.21.9) with the browser's rise time; before
// 0.21.9 everything is computed here and amplitude/top/base stay empty.
function readouts(f: Frame): Meas {
  const host = measure(f), dev = io.scopeData.meas[f.ch];
  return dev ? { ...dev, rise: host.rise } : host;
}

// A cursor drag re-renders only this panel, not the whole Scope view.
function Measurements({ cur, onDrag }: { cur: React.RefObject<Cur>; onDrag: React.RefObject<() => void> }) {
  const s = useDev((st) => st.scope);
  const cursors = useDev((st) => st.cursors);
  const fft = useDev((st) => st.fft);
  const st = useDev((x) => x.scopeStatus);
  const [rows, setRows] = useState<{ ch: 0 | 1; m: Meas }[]>([]);
  const [, setDragTick] = useState(0);
  useEffect(() => { onDrag.current = () => setDragTick((t) => t + 1); }, [onDrag]);
  const exps = useRef(new Map<string, number>()); // sticky SI prefix per readout (fmtStable)
  useEffect(() => {
    let ver = -1;
    const id = setInterval(() => {
      if (io.scopeData.version === ver) return;
      ver = io.scopeData.version;
      setRows(io.scopeData.frames.map((f) => ({ ch: f.ch, m: readouts(f) })));
    }, 300);
    return () => clearInterval(id);
  }, []);
  const f0 = io.scopeData.frames[0];
  const c = cur.current;
  const dt = (c.b - c.a) * timeWindow(s, f0).span;
  const si = (v: number, f: (x: number) => string) => (Number.isFinite(v) ? f(v) : '—');
  const fmt = (key: string, v: number, unit: string, digits: number) => {
    const r = fmtStable(v, unit, digits, exps.current.get(key));
    exps.current.set(key, r.exp);
    return r.text;
  };
  return (
    <Panel>
      <div className="grid gap-y-2.5 font-mono text-xs">
        {!rows.length && <span className="text-muted">No frame yet</span>}
        {rows.map(({ ch, m }) => {
          const fc = st.fcnt[ch];
          const qual = s.trig.src === ch + 1 && st.qual ? ` · ${st.qual}` : '';
          const hz = (k: string, v: number) => fmt(k, v, 'Hz', 5);
          const volt = (k: string, v: number) => fmt(`${ch}${k}`, v, 'V', 4);
          return (
            <Columns key={ch} head={<>
              <span className="font-bold" style={{ color: CH_COLOR[ch] }}>CH{ch + 1}</span>
              <span className={clsx('font-bold text-danger', !m.clipped && 'invisible')} title="The ADC clipped: Vpp, max/min, top and RMS read low">CLIP</span>
            </>}>
              <M l="Freq" v={hz(`${ch}f`, m.freq)} hint={SRC_HINT[m.src] ?? m.src} />
              <M l="Period" v={fmt(`${ch}T`, m.period, 's', 4)} />
              <M l="FC" v={hz(`${ch}fc`, fc > 0 ? fc : NaN)} hint={`hardware frequency counter${qual}`} />
              <M l="Vpp" v={volt('pp', m.vpp)} />
              <M l="Max" v={volt('max', m.max)} />
              <M l="Min" v={volt('min', m.min)} />
              <M l="Amp" v={volt('amp', m.amp)} hint="top − base" />
              <M l="Top" v={volt('top', m.top)} />
              <M l="Base" v={volt('base', m.base)} />
              <M l="Mean" v={volt('mean', m.mean)} />
              <M l="RMS" v={volt('rms', m.rms)} />
              <M l="AC RMS" v={volt('ac', m.acRms)} />
              <M l="Duty" v={si(m.duty, (d) => `${d.toFixed(1)} %`)} />
              <M l="Edges" v={si(m.edges, String)} hint="rising edges in the window" />
              <M l="Rise" v={fmt(`${ch}rise`, m.rise, 's', 4)} hint="10–90 %, computed in the browser from the live frame (≤ 1024 points)" />
            </Columns>
          );
        })}
        {fft && <SpectrumReadout />}
        {cursors !== 'OFF' && (
          <Columns className="border-t border-border pt-1.5 text-accent" head={<span className="font-bold" title="drag the lines on the plot">CUR</span>}>
            {hasT(cursors) && [<M key="dt" l="ΔT" v={fmt('dt', Math.abs(dt), 's', 4)} />, <M key="1dt" l="1/ΔT" v={fmt('1dt', dt ? 1 / Math.abs(dt) : NaN, 'Hz', 4)} />]}
            {hasV(cursors) && s.ch.map((ch, i) => ch.on && <M key={i} l={`ΔV CH${i + 1}`} v={fmt(`dv${i}`, Math.abs(c.yb - c.ya) * 8 * vdiv(ch), 'V', 4)} />)}
          </Columns>
        )}
      </div>
    </Panel>
  );
}

// rAF loop reads io.scopeData and the store directly: frames never go through React state. It draws
// only when something drawn changed: a new frame array, the settings, the cursors, the canvas size.
function useDrawLoop(ref: React.RefObject<HTMLCanvasElement | null>, cur: React.RefObject<Cur>) {
  useEffect(() => {
    let raf = 0, last: unknown[] = [];
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const st = useDev.getState(), c = ref.current!, k = cur.current;
      const now = [io.scopeData.frames, st.scope, st.cursors, k.a, k.b, k.ya, k.yb, c.clientWidth, c.clientHeight, devicePixelRatio];
      if (now.every((v, i) => v === last[i])) return;
      last = now;
      draw(c, st.scope, io.scopeData.frames, k, st.cursors);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ref, cur]);
}

function draw(c: HTMLCanvasElement, s: State['scope'], frames: Frame[], cur: Cur, cursors: CursorMode) {
  const dpr = devicePixelRatio || 1;
  const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  drawGrid(g, W, H, dpr);

  // io.fetchChannel returns the 10-div screen window (or the whole record when it's shorter).
  // ponytail: no zoom into the full record yet.
  const f0 = frames[0], { t0, span } = timeWindow(s, f0);
  for (const f of frames) drawTrace(g, W, H, f, s.ch[f.ch], t0, span, dpr);
  drawMarkers(g, W, H, s, dpr);

  if (!frames.length) {
    g.fillStyle = '#8b949e';
    g.font = `${13 * dpr}px "Geist Variable", sans-serif`;
    g.textAlign = 'center';
    g.fillText('Waiting for a frame…', W / 2, H / 2 - 12 * dpr);
    g.textAlign = 'start';
  }
  if (cursors !== 'OFF') drawCursors(g, W, H, cur, cursors, dpr);
}

// The time span across the plot: the frame's own window. Roll (Auto, ≥ 200 ms/div) fills from the
// right: a record still shorter than the screen ends at its right edge, at the real timebase, as on the device.
function timeWindow(s: State['scope'], f0: Frame | undefined) {
  const screen = 10 * TIMEBASES[s.tb];
  if (!f0) return { t0: 0, span: screen };
  const fspan = f0.xinc * f0.volts.length, span = isRolling(s) && fspan < screen ? screen : fspan;
  return { t0: f0.xorig + fspan - span, span };
}

function drawGrid(g: CanvasRenderingContext2D, W: number, H: number, dpr: number) {
  const dx = W / 10, dy = H / 8;
  g.beginPath();
  for (let i = 1; i < 10; i++) { g.moveTo(i * dx, 0); g.lineTo(i * dx, H); }
  for (let i = 1; i < 8; i++) { g.moveTo(0, i * dy); g.lineTo(W, i * dy); }
  strokeGrid(g, dpr);
  // Centre cross and its ticks: one path, one stroke.
  g.strokeStyle = '#5a6678';
  g.beginPath();
  g.moveTo(W / 2, 0); g.lineTo(W / 2, H);
  g.moveTo(0, H / 2); g.lineTo(W, H / 2);
  for (let i = 0; i <= 50; i++) { g.moveTo((i * W) / 50, H / 2 - 3 * dpr); g.lineTo((i * W) / 50, H / 2 + 3 * dpr); }
  for (let i = 0; i <= 40; i++) { g.moveTo(W / 2 - 3 * dpr, (i * H) / 40); g.lineTo(W / 2 + 3 * dpr, (i * H) / 40); }
  g.stroke();
}

// Min/max of the samples (or PEAK buckets) falling in each pixel column.
function drawTrace(g: CanvasRenderingContext2D, W: number, H: number, f: Frame, ch: Channel, t0: number, span: number, dpr: number) {
  const vd = vdiv(ch), offs = ch.offsetDiv * vd, dy = H / 8;
  const Y = (v: number) => H / 2 - ((v + offs) / vd) * dy;
  const lo = f.lo ?? f.volts, hi = f.hi ?? f.volts, n = lo.length;
  g.strokeStyle = CH_COLOR[f.ch];
  g.lineWidth = 1.3 * dpr;
  g.beginPath();
  let started = false;
  for (let x = 0; x < W; x++) {
    const i0 = Math.max(0, Math.floor((t0 + (x / W) * span - f.xorig) / f.xinc));
    const i1 = Math.min(n, Math.ceil((t0 + ((x + 1) / W) * span - f.xorig) / f.xinc));
    if (i1 <= 0 || i0 >= n) continue;
    let mn = Infinity, mx = -Infinity;
    for (let i = i0; i < Math.max(i1, i0 + 1) && i < n; i++) { if (lo[i] < mn) mn = lo[i]; if (hi[i] > mx) mx = hi[i]; }
    const ya = clampY(Y(mn), H), yb = clampY(Y(mx), H);
    if (started) g.lineTo(x, ya); else { g.moveTo(x, ya); started = true; }
    g.lineTo(x, yb);
  }
  g.stroke();
}

function drawMarkers(g: CanvasRenderingContext2D, W: number, H: number, s: State['scope'], dpr: number) {
  const dy = H / 8;
  s.ch.forEach((ch, i) => {
    if (!ch.on) return;
    const vd = vdiv(ch), offs = ch.offsetDiv * vd;
    const Y = (v: number) => H / 2 - ((v + offs) / vd) * dy;
    marker(g, 0, clampY(Y(0), H), CH_COLOR[i], String(i + 1), 'right', dpr);
    if (s.trig.src !== i + 1) return;
    const yl = clampY(Y(s.trig.level), H);
    g.strokeStyle = CH_COLOR[i] + '55';
    g.setLineDash([6 * dpr, 6 * dpr]);
    g.lineWidth = 1;
    line(g, 0, yl, W, yl);
    g.setLineDash([]);
    marker(g, W, yl, CH_COLOR[i], 'T', 'left', dpr);
  });
  const xTrig = (s.trig.pos / 100) * W;
  g.fillStyle = '#f59e0b';
  g.beginPath();
  g.moveTo(xTrig - 6 * dpr, 0); g.lineTo(xTrig + 6 * dpr, 0); g.lineTo(xTrig, 8 * dpr);
  g.fill();
}

function drawCursors(g: CanvasRenderingContext2D, W: number, H: number, cur: Cur, mode: CursorMode, dpr: number) {
  g.strokeStyle = g.fillStyle = '#3b82f6';
  g.lineWidth = 1.5 * dpr;
  g.font = `${11 * dpr}px "Geist Mono Variable", monospace`;
  g.setLineDash([5 * dpr, 4 * dpr]);
  if (hasT(mode)) for (const p of [cur.a, cur.b]) line(g, p * W, 0, p * W, H);
  if (hasV(mode)) for (const p of [cur.ya, cur.yb]) line(g, 0, p * H, W, p * H);
  g.setLineDash([]);
  if (hasT(mode)) { g.fillText('A', cur.a * W + 4 * dpr, 30 * dpr); g.fillText('B', cur.b * W + 4 * dpr, 30 * dpr); }
  if (hasV(mode)) { g.fillText('a', 22 * dpr, cur.ya * H - 4 * dpr); g.fillText('b', 22 * dpr, cur.yb * H - 4 * dpr); }
}

const clampY = (y: number, H: number) => Math.min(H + 2, Math.max(-2, y));

function marker(g: CanvasRenderingContext2D, x: number, y: number, color: string, text: string, dir: 'left' | 'right', dpr: number) {
  const w = 16 * dpr, h = 14 * dpr;
  const x0 = dir === 'right' ? x : x - w;
  g.fillStyle = color;
  g.beginPath();
  if (dir === 'right') { g.moveTo(x0, y - h / 2); g.lineTo(x0 + w - 5 * dpr, y - h / 2); g.lineTo(x0 + w, y); g.lineTo(x0 + w - 5 * dpr, y + h / 2); g.lineTo(x0, y + h / 2); }
  else { g.moveTo(x0 + w, y - h / 2); g.lineTo(x0 + 5 * dpr, y - h / 2); g.lineTo(x0, y); g.lineTo(x0 + 5 * dpr, y + h / 2); g.lineTo(x0 + w, y + h / 2); }
  g.fill();
  g.fillStyle = '#000';
  g.font = `bold ${10 * dpr}px "Geist Mono Variable", monospace`;
  g.fillText(text, x0 + (dir === 'right' ? 3 : 7) * dpr, y + 3.5 * dpr);
}

function line(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
}

function fmtSps(r: number) {
  if (!Number.isFinite(r)) return '— Sa/s';
  return r >= 1e6 ? `${+(r / 1e6).toPrecision(3)} MSa/s` : r >= 1e3 ? `${+(r / 1e3).toPrecision(3)} kSa/s` : `${+r.toPrecision(3)} Sa/s`;
}

// The plot as on screen (FFT too when shown) on the plot's background, with the settings, basic
// readouts per channel and the notes for readings known to be off written below.
function savePng(trace: HTMLCanvasElement, spectrum: HTMLCanvasElement | null) {
  const dpr = devicePixelRatio || 1, pad = 8 * dpr, row = 16 * dpr, W = trace.width;
  const out = document.createElement('canvas'), g = out.getContext('2d')!;
  g.font = FONT(dpr);
  const lines = pngLines(g, W - 2 * pad, spectrum !== null);
  const top = trace.height + (spectrum?.height ?? 0);
  out.width = W; // resizing resets the context
  out.height = top + lines.length * row + 2 * pad;
  g.fillStyle = '#07090d';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(trace, 0, 0);
  if (spectrum) g.drawImage(spectrum, 0, trace.height);
  g.font = FONT(dpr);
  lines.forEach(({ text, color }, i) => { g.fillStyle = color; g.fillText(text, pad, top + pad + row * (i + 0.75)); });
  out.toBlob((b) => b && io.download(`scope-${Date.now()}.png`, b), 'image/png');
}

function pngLines(g: CanvasRenderingContext2D, width: number, withFft: boolean) {
  const { scope: s, scopeStatus } = useDev.getState();
  const lines: { text: string; color: string }[] = [], notes: string[] = [];
  const add = (parts: string[], sep: string, color: string) => { for (const text of wrap(g, parts, sep, width)) lines.push({ text, color }); };
  add([
    `${fmtTime(TIMEBASES[s.tb])}/div`, fmtSps(scopeStatus.srate), `${(s.mdepth / 1024).toFixed(0)}K pts`,
    `trigger CH${s.trig.src} ${s.trig.slope === 'POS' ? '↑' : '↓'} ${fmtVolt(s.trig.level)}`,
  ], ' · ', '#8b949e');
  s.ch.forEach((c, i) => {
    if (!c.on) return;
    const f = io.scopeData.frames.find((fr) => fr.ch === i), m = f && readouts(f);
    const parts = [`CH${i + 1} ${fmtVolt(vdiv(c))}/div ${c.coup} ×${c.probe}`];
    if (m) {
      parts.push(`Freq ${m.src === 'SPEC' ? '≈ ' : ''}${fmtStable(m.freq, 'Hz', 5).text}`, `Vpp ${fmtStable(m.vpp, 'V', 4).text}`);
      if (m.clipped) notes.push(`CH${i + 1} clipped: Vpp reads low. Raise volts/div or move the trace.`);
    }
    add(parts, '   ', CH_COLOR[i]);
  });
  if (withFft) {
    const fft = fftPngText();
    add(fft.cells, '   ', FFT_COLOR);
    notes.push(...fft.notes);
  }
  for (const note of notes) add(note.split(' '), ' ', '#f59e0b');
  return lines;
}
