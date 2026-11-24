import { clsx } from 'clsx';
import { Crosshair, Info, Download, ImageDown, Play, Sparkles, Square, StepForward, Waves, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmtHz, fmtTime, fmtVolt, genHalvesScope, HALVED_NOTE, MEM_DEPTHS, MODELS, PROBES, TIMEBASES, VDIV_MV } from '../device';
import { measure, type Frame, type Meas } from '../dsp';
import * as io from '../io';
import { useDev, type Channel, type State } from '../store';
import { Btn, Panel, Row, Seg, Select, Stepper, Toggle } from '../ui';

const CH_COLOR = ['#facc15', '#22d3ee'];
const vdiv = (c: Channel) => (c.vdivMv * c.probe) / 1000;

export function Scope() {
  const s = useDev((st) => st.scope);
  const status = useDev((st) => st.scopeStatus);
  const model = useDev((st) => st.model);
  const interleaveAuto = MODELS[model].interleaveAuto;
  const halved = genHalvesScope(model, useDev((st) => st.gen));
  const patch = useDev((st) => st.patch);
  const cursors = useDev((st) => st.cursors);
  const fft = useDev((st) => st.fft);
  const setView = useDev((st) => st.set);
  const [toast, setToast] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cur = useRef({ a: 0.3, b: 0.7, drag: null as null | 'a' | 'b' });

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
  const twoCh = s.ch[0].on && s.ch[1].on;
  const depths = MEM_DEPTHS.map((d) => (twoCh ? d / 2 : d));
  const src = s.ch[s.trig.src - 1], srcVd = vdiv(src);

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!cursors) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const c = cur.current;
    if (e.type === 'pointerdown') {
      c.drag = Math.abs(x - c.a) < Math.abs(x - c.b) ? 'a' : 'b';
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (e.type === 'pointerup') c.drag = null;
    if (c.drag) c[c.drag] = Math.min(1, Math.max(0, x));
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
          <div className="ml-auto flex gap-2">
            <Btn active={cursors} onClick={() => setView({ cursors: !cursors })}><Crosshair size={13} /> Cursors</Btn>
            <Btn active={fft} onClick={() => setView({ fft: !fft })}><Waves size={13} /> FFT</Btn>
            <Btn title="Fetch the full record and save CSV" onClick={() => void csv()}><Download size={13} /> CSV</Btn>
            <Btn title="Save plot as PNG" onClick={() => savePng(canvas.current!)}><ImageDown size={13} /></Btn>
          </div>
        </div>

        <div className="relative overflow-hidden rounded-lg border border-border bg-[#07090d]">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-between px-3 py-1.5 font-mono text-[11px] text-muted">
            <span>{fmtTime(tb)}/div · {fmtSps(status.srate)}{halved && <span className="text-amber" title={HALVED_NOTE}> (GEN: max /2)</span>} · {(s.mdepth / 1024).toFixed(0)}K pts</span>
            <span>T {s.trig.slope === 'POS' ? '↑' : '↓'} CH{s.trig.src} {fmtVolt(s.trig.level)}</span>
          </div>
          <canvas
            ref={canvas}
            onPointerDown={onPointer}
            onPointerMove={onPointer}
            onPointerUp={onPointer}
            className={clsx('block h-[clamp(320px,58vh,680px)] w-full', cursors && 'cursor-ew-resize')}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex gap-4 px-3 py-1.5 font-mono text-[11px]">
            {s.ch.map((c, i) => c.on && (
              <span key={i} style={{ color: CH_COLOR[i] }}>CH{i + 1} {fmtVolt(vdiv(c))}/div {c.coup} ×{c.probe}</span>
            ))}
          </div>
        </div>

        <Measurements cur={cur} />
      </div>

      <aside className="space-y-3">
        {([0, 1] as const).map((i) => (
          <ChannelCard key={i} i={i} c={s.ch[i]} other={s.ch[1 - i]} onChange={(p) => setCh(i, p)} />
        ))}

        <Panel title="Horizontal">
          <div className="space-y-3">
            <Stepper label="Time/div" value={s.tb} count={TIMEBASES.length} display={fmtTime(tb)} onChange={(tb) => set({ tb })} />
            <Slider label="Offset" value={s.hoff / tb} min={-5} max={5} step={0.1} show={fmtTime(s.hoff)} onChange={(d) => set({ hoff: d * tb })} />
          </div>
        </Panel>

        <Panel title="Trigger" right={<span className="text-[11px] text-muted">Edge</span>}>
          <div className="space-y-3">
            <Row label="Source">
              <Seg size="xs" value={s.trig.src} options={[{ id: 1, label: 'CH1', disabled: !s.ch[0].on }, { id: 2, label: 'CH2', disabled: !s.ch[1].on }]} onChange={(src) => set({ trig: { ...s.trig, src } })} />
            </Row>
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
          </div>
        </Panel>

        <Panel title="Acquisition">
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
                options={[{ id: 'OFF', label: 'Off' }, { id: 'ON', label: 'On', disabled: s.ch[1].on }, ...(interleaveAuto ? [{ id: 'AUTO' as const, label: 'Auto' }] : [])]}
              />
            </Row>
            <p className="text-[11px] text-muted">On doubles CH1 to 200 MSa/s with CH2 off{interleaveAuto ? '; Auto keeps the factory rules' : ' (experimental on the ZT703S)'}. Two channels split the memory budget.</p>
          </div>
        </Panel>
      </aside>
    </div>
  );
}

function ChannelCard({ i, c, other, onChange }: { i: 0 | 1; c: Channel; other: Channel; onChange: (p: Partial<Channel>) => void }) {
  const color = CH_COLOR[i];
  const vIdx = VDIV_MV.indexOf(c.vdivMv);
  return (
    <section className="rounded-lg border bg-panel p-4" style={{ borderColor: c.on ? `${color}55` : undefined }}>
      <div className="mb-3 flex items-center justify-between">
        <button
          onClick={() => onChange({ on: !c.on })}
          disabled={c.on && !other.on}
          title={c.on && !other.on ? 'The last enabled channel cannot be switched off' : undefined}
          className="flex items-center gap-2 text-sm font-semibold disabled:cursor-not-allowed"
        >
          <span className="flex h-5 w-9 items-center justify-center rounded font-mono text-[11px] font-bold text-black" style={{ background: c.on ? color : '#30363d' }}>CH{i + 1}</span>
          <span className={c.on ? 'text-fg' : 'text-muted'}>{c.on ? 'On' : 'Off'}</span>
        </button>
        <Seg size="xs" value={c.coup} options={[{ id: 'DC', label: 'DC' }, { id: 'AC', label: 'AC' }]} onChange={(coup) => onChange({ coup })} />
      </div>
      <div className={clsx('space-y-3', !c.on && 'pointer-events-none opacity-40')}>
        <Stepper label="Volts/div" value={vIdx} count={VDIV_MV.length} display={fmtVolt(vdiv(c))} color={color} onChange={(k) => onChange({ vdivMv: VDIV_MV[k] })} />
        <Slider label="Position" value={c.offsetDiv} min={-4} max={4} step={0.05} show={`${c.offsetDiv.toFixed(2)} div`} color={color} onChange={(offsetDiv) => onChange({ offsetDiv })} />
        <Row label="Probe">
          <Select label={`CH${i + 1} probe`} value={c.probe} options={PROBES.map((p) => ({ id: p, label: `×${p}` }))} onChange={(probe) => onChange({ probe })} />
        </Row>
      </div>
    </section>
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

function Measurements({ cur }: { cur: React.RefObject<{ a: number; b: number }> }) {
  const s = useDev((st) => st.scope);
  const cursors = useDev((st) => st.cursors);
  const st = useDev((x) => x.scopeStatus);
  const [rows, setRows] = useState<{ ch: 0 | 1; m: Meas }[]>([]);
  useEffect(() => {
    let ver = -1;
    const id = setInterval(() => {
      if (io.scopeData.version === ver) return;
      ver = io.scopeData.version;
      setRows(io.scopeData.frames.map((f) => ({ ch: f.ch, m: measure(f) })));
    }, 300);
    return () => clearInterval(id);
  }, []);
  const f0 = io.scopeData.frames[0];
  const dt = (cur.current.b - cur.current.a) * (f0 ? f0.xinc * f0.volts.length : 10 * TIMEBASES[s.tb]);
  const si = (v: number, f: (x: number) => string) => (Number.isFinite(v) ? f(v) : '—');
  return (
    <Panel>
      <div className="grid gap-x-6 gap-y-1.5 font-mono text-xs">
        {!rows.length && <span className="text-muted">No frame yet</span>}
        {rows.map(({ ch, m }) => {
          const hw = st.fcnt[ch];
          const freq = Number.isFinite(hw) && hw > 0 ? hw : m.freq;
          return (
            <div key={ch} className="flex flex-wrap gap-x-5 gap-y-1">
              <span className="w-10 font-bold" style={{ color: CH_COLOR[ch] }}>CH{ch + 1}</span>
              <M l="Freq" v={si(freq, fmtHz)} hint={freq === hw ? `hardware counter · ${st.qual}` : 'computed from the waveform'} />
              <M l="Period" v={si(1 / freq, fmtTime)} />
              <M l="Vpp" v={fmtVolt(m.vpp)} />
              <M l="Vrms" v={fmtVolt(m.rms)} />
              <M l="Mean" v={fmtVolt(m.mean)} />
              <M l="Duty" v={si(m.duty, (d) => `${d.toFixed(1)} %`)} />
              <M l="Rise" v={si(m.rise, fmtTime)} hint="10–90 %, from the live screen window (≤ 1024 points)" />
            </div>
          );
        })}
        {cursors && (
          <div className="flex flex-wrap gap-x-5 border-t border-border pt-1.5 text-accent">
            <span className="w-10 font-bold">CUR</span>
            <M l="ΔT" v={fmtTime(Math.abs(dt))} />
            <M l="1/ΔT" v={dt ? fmtHz(1 / Math.abs(dt)) : '—'} />
            <span className="text-muted">drag on the plot</span>
          </div>
        )}
      </div>
    </Panel>
  );
}

function M({ l, v, hint }: { l: string; v: string; hint?: string }) {
  return <span title={hint}><span className="text-muted">{l} </span><span className="tabular-nums text-fg">{v}</span></span>;
}

// rAF loop reads io.scopeData and the store directly: frames never go through React state.
function useDrawLoop(ref: React.RefObject<HTMLCanvasElement | null>, cur: React.RefObject<{ a: number; b: number }>) {
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const st = useDev.getState();
      draw(ref.current!, st.scope, io.scopeData.frames, cur.current, st);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ref, cur]);
}

function draw(c: HTMLCanvasElement, s: State['scope'], frames: Frame[], cur: { a: number; b: number }, view: { cursors: boolean; fft: boolean }) {
  const dpr = devicePixelRatio || 1;
  const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const dx = W / 10, dy = H / 8;

  g.strokeStyle = '#1f2630';
  g.lineWidth = 1;
  g.setLineDash([2 * dpr, 4 * dpr]);
  for (let i = 1; i < 10; i++) line(g, i * dx, 0, i * dx, H);
  for (let i = 1; i < 8; i++) line(g, 0, i * dy, W, i * dy);
  g.setLineDash([]);
  g.strokeStyle = '#2d3643';
  line(g, W / 2, 0, W / 2, H);
  line(g, 0, H / 2, W, H / 2);
  for (let i = 0; i <= 50; i++) line(g, (i * W) / 50, H / 2 - 3 * dpr, (i * W) / 50, H / 2 + 3 * dpr);
  for (let i = 0; i <= 40; i++) line(g, W / 2 - 3 * dpr, (i * H) / 40, W / 2 + 3 * dpr, (i * H) / 40);

  // io.fetchChannel returns the 10-div screen window (or the whole record when it's shorter).
  // ponytail: no zoom into the full record yet.
  const f0 = frames[0];
  const t0 = f0?.xorig ?? 0, span = f0 ? f0.xinc * f0.volts.length : 10 * TIMEBASES[s.tb];

  for (const f of frames) {
    const ch = s.ch[f.ch];
    const vd = vdiv(ch), offs = ch.offsetDiv * vd;
    const Y = (v: number) => H / 2 - ((v + offs) / vd) * dy;
    const v = f.volts, n = v.length;
    g.strokeStyle = CH_COLOR[f.ch];
    g.lineWidth = 1.3 * dpr;
    g.beginPath();
    let started = false;
    for (let x = 0; x < W; x++) {
      // min/max of the samples falling in this pixel column
      const i0 = Math.max(0, Math.floor((t0 + (x / W) * span - f.xorig) / f.xinc));
      const i1 = Math.min(n, Math.ceil((t0 + ((x + 1) / W) * span - f.xorig) / f.xinc));
      if (i1 <= 0 || i0 >= n) continue;
      let mn = Infinity, mx = -Infinity;
      for (let i = i0; i < Math.max(i1, i0 + 1) && i < n; i++) { if (v[i] < mn) mn = v[i]; if (v[i] > mx) mx = v[i]; }
      const ya = clampY(Y(mn), H), yb = clampY(Y(mx), H);
      if (started) g.lineTo(x, ya); else { g.moveTo(x, ya); started = true; }
      g.lineTo(x, yb);
    }
    g.stroke();
  }

  s.ch.forEach((ch, i) => {
    if (!ch.on) return;
    const vd = vdiv(ch), offs = ch.offsetDiv * vd;
    const Y = (v: number) => H / 2 - ((v + offs) / vd) * dy;
    marker(g, 0, clampY(Y(0), H), CH_COLOR[i], String(i + 1), 'right', dpr);
    if (s.trig.src === i + 1) {
      const yl = clampY(Y(s.trig.level), H);
      g.strokeStyle = CH_COLOR[i] + '55';
      g.setLineDash([6 * dpr, 6 * dpr]);
      g.lineWidth = 1;
      line(g, 0, yl, W, yl);
      g.setLineDash([]);
      marker(g, W, yl, CH_COLOR[i], 'T', 'left', dpr);
    }
  });

  const xTrig = (s.trig.pos / 100) * W;
  {
    g.fillStyle = '#f59e0b';
    g.beginPath();
    g.moveTo(xTrig - 6 * dpr, 0); g.lineTo(xTrig + 6 * dpr, 0); g.lineTo(xTrig, 8 * dpr);
    g.fill();
  }

  if (!frames.length) {
    g.fillStyle = '#8b949e';
    g.font = `${13 * dpr}px "Geist Variable", sans-serif`;
    g.textAlign = 'center';
    g.fillText('Waiting for a frame…', W / 2, H / 2 - 12 * dpr);
    g.textAlign = 'start';
  }

  if (view.fft && f0) drawFft(g, W, H, f0, dpr);

  if (view.cursors) {
    g.strokeStyle = '#3b82f6';
    g.lineWidth = 1.5 * dpr;
    g.setLineDash([5 * dpr, 4 * dpr]);
    for (const p of [cur.a, cur.b]) line(g, p * W, 0, p * W, H);
    g.setLineDash([]);
    g.fillStyle = '#3b82f6';
    g.font = `${11 * dpr}px "Geist Mono Variable", monospace`;
    g.fillText('A', cur.a * W + 4 * dpr, 30 * dpr);
    g.fillText('B', cur.b * W + 4 * dpr, 30 * dpr);
  }
}

const clampY = (y: number, H: number) => Math.min(H + 2, Math.max(-2, y));

// In-place radix-2 FFT; returns magnitude in dBV (peak) for bins 0..N/2.
let fftCache: { f: Frame | null; db: Float32Array } = { f: null, db: new Float32Array() };
function spectrum(f: Frame) {
  if (fftCache.f === f) return fftCache.db;
  let N = 1;
  while (N * 2 <= f.volts.length) N *= 2;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = f.volts[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); // Hann
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
  const db = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) db[k] = 20 * Math.log10((4 * Math.hypot(re[k], im[k])) / N + 1e-9); // ×2 Hann, ×2 one-sided
  fftCache = { f, db };
  return db;
}

function drawFft(g: CanvasRenderingContext2D, W: number, H: number, f: Frame, dpr: number) {
  const db = spectrum(f), top = H * 0.62, h = H - top;
  g.fillStyle = 'rgba(7,9,13,0.45)';
  g.fillRect(0, top, W, h);
  g.strokeStyle = '#d946ef';
  g.lineWidth = 1.2 * dpr;
  g.beginPath();
  for (let k = 1; k < db.length; k++) {
    const x = (k / db.length) * W, y = top + (Math.min(100, Math.max(0, 20 - db[k])) / 100) * h; // +20 … −80 dBV
    if (k === 1) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.fillStyle = '#d946ef';
  g.font = `${11 * dpr}px "Geist Mono Variable", monospace`;
  g.fillText(`FFT CH${f.ch + 1} · 0–${fmtHz(1 / (2 * f.xinc), true)} · +20…−80 dBV · Hann`, 8 * dpr, top + 16 * dpr);
}

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

function savePng(c: HTMLCanvasElement) {
  c.toBlob((b) => b && io.download(`scope-${Date.now()}.png`, b), 'image/png');
}
