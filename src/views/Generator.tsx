import { clsx } from 'clsx';
import { Info, Power } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { ampLimit, fmtHz, genHalvesScope, genMaxHz, HALVED_NOTE, MODELS, parseHz, SHAPES, startsFreqEntry, type Model, type Shape } from '../device';
import { useDev, type State } from '../store';
import { Panel, Row, Seg, SiField, Toggle } from '../ui';

// One period of each shape, y in [0,1].
const WAVE: Record<Shape, (p: number, duty: number) => number> = {
  SIN: (p) => 0.5 + 0.5 * Math.sin(2 * Math.PI * p),
  SQU: (p, d) => (p < d / 100 ? 1 : 0),
  TRI: (p) => (p < 0.5 ? 2 * p : 2 - 2 * p),
  HALF: (p) => (p < 0.5 ? Math.sin(2 * Math.PI * p) : 0),
  POS: (p) => Math.abs(Math.sin(Math.PI * p)),
  RAMP: (p) => p,
};

function path(shape: Shape, duty: number, w: number, h: number, periods: number, pad = 0) {
  const n = 400;
  let d = '';
  for (let i = 0; i <= n; i++) {
    const p = ((i / n) * periods) % 1;
    const x = (i / n) * w;
    const y = pad + (1 - WAVE[shape](p, duty)) * (h - 2 * pad);
    d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

// The firmware refuses SOUR:FUNC (-221) while the current frequency is above the new
// shape's limit, so the app must lower the frequency before switching shape.
// Policy: clamp to the new shape's limit and tell the user, so the frequency never changes silently.
function applyShape(freq: number, next: { label: string; max: number }): { freq: number; note: string | null } {
  if (freq <= next.max) return { freq, note: null };
  return { freq: next.max, note: `${next.label} is limited to ${fmtHz(next.max)}: frequency lowered from ${fmtHz(freq)}.` };
}

// Typing a number anywhere on this view starts a frequency entry. Focusing during keydown, without
// preventDefault, makes the browser type that same key into the field; its focus handler has
// selected the old text, so the key replaces it.
function useTypeToFocus(field: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Fields that take digits themselves (the SCPI console) keep them; a range slider doesn't.
      const typing = (e.target as Element).matches('input:not([type="range"]), textarea, select');
      if (startsFreqEntry(e) && !typing && !useDev.getState().shot) field.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [field]);
}

type Gen = State['gen'];
type SetGen = (p: Partial<Gen>) => void;

export function Generator() {
  const g = useDev((s) => s.gen);
  const model = useDev((s) => s.model);
  const patch = useDev((s) => s.patch);
  const set: SetGen = (p) => patch('gen', p);
  const fw = useDev((s) => s.idn?.fw);
  const spec = { ...MODELS[model], maxHz: genMaxHz(model, fw) };
  const shape = SHAPES.find((s) => s.id === g.shape)!;
  const max = spec.maxHz[g.shape];
  const [note, setNote] = useState<string | null>(null);
  const freqField = useRef<HTMLInputElement>(null);
  useTypeToFocus(freqField);
  const over = g.freq > max;
  const clampFreq = (f: number) => Math.min(max, Math.max(spec.minHz, f));

  const pickShape = (id: Shape) => {
    const next = SHAPES.find((s) => s.id === id)!;
    const r = applyShape(g.freq, { label: next.label, max: spec.maxHz[id] });
    setNote(r.note);
    set({ shape: id, freq: r.freq });
  };
  const commitFreq = (text: string) => {
    const f = parseHz(text);
    if (f === null) setNote(`"${text.trim()}" is not a frequency: try 1k, 2.5 MHz or 500 mHz.`);
    else if (f < spec.minHz) setNote(`${fmtHz(f)} is below the ${fmtHz(spec.minHz)} minimum.`);
    else { setNote(f > max ? `${shape.label} is limited to ${fmtHz(max)}.` : null); set({ freq: clampFreq(f) }); }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-4">
        <Panel title="Waveform">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                onClick={() => pickShape(s.id)}
                className={clsx(
                  'flex flex-col items-center gap-1.5 rounded-md border px-2 py-3 transition-colors',
                  s.id === g.shape ? 'border-accent bg-accent/15 text-fg' : 'border-border bg-canvas text-muted hover:text-fg',
                )}
              >
                <svg viewBox="0 0 64 28" className="h-7 w-16">
                  <path d={path(s.id, g.duty, 64, 28, 2, 3)} fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
                <span className="text-xs font-medium">{s.label}</span>
                <span className="font-mono text-[10px] text-muted">≤ {fmtHz(spec.maxHz[s.id], true)}</span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title="Frequency"
          right={<span className={clsx('rounded border px-2 py-0.5 text-xs font-semibold', g.out ? 'border-success/40 text-success' : 'border-border text-muted')}>{g.out ? 'OUTPUT ON' : 'OUTPUT OFF'}</span>}
        >
          <div className="flex flex-col items-center gap-4 py-4">
            <SiField
              inputRef={freqField}
              label="Frequency"
              value={g.freq}
              fmt={fmtHz}
              onCommit={commitFreq}
              className={clsx(
                'w-full max-w-xl bg-transparent text-center font-mono text-[length:clamp(2.5rem,7vw,5.5rem)] leading-none font-bold tabular-nums outline-none',
                over ? 'text-danger' : g.out ? 'text-success' : 'text-accent',
              )}
            />
            <div className="flex flex-wrap justify-center gap-1.5">
              {['÷10', '÷2', '×2', '×10'].map((k) => (
                <button
                  key={k}
                  onClick={() => set({ freq: clampFreq(g.freq * { '÷10': 0.1, '÷2': 0.5, '×2': 2, '×10': 10 }[k]!) })}
                  className="rounded-md border border-border bg-canvas px-3 py-1 font-mono text-xs text-muted hover:text-fg"
                >
                  {k}
                </button>
              ))}
              <span className="mx-1 w-px bg-border" />
              {[50, 1000, 10_000, 100_000, 1_000_000].map((f) => (
                <button key={f} disabled={f > max} onClick={() => set({ freq: f })} className="rounded-md border border-border bg-canvas px-3 py-1 font-mono text-xs text-muted hover:text-fg disabled:opacity-30">
                  {fmtHz(f, true)}
                </button>
              ))}
            </div>
            <div className="w-full max-w-xl">
              <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                <div className={clsx('h-full', over ? 'bg-danger' : 'bg-accent')} style={{ width: `${Math.min(100, (Math.log10(g.freq / spec.minHz) / Math.log10(max / spec.minHz)) * 100)}%` }} />
              </div>
              <div className="mt-1 flex justify-between font-mono text-[10px] text-muted">
                <span>{fmtHz(spec.minHz, true)}</span>
                <span className={over ? 'text-danger' : undefined}>{over ? 'over the shape limit' : `${shape.label} max ${fmtHz(max, true)}`}</span>
              </div>
            </div>
            {note && <p className="flex items-center gap-1.5 text-xs text-amber"><Info size={13} /> {note}</p>}
          </div>
        </Panel>

        <Preview g={g} model={model} />
      </div>

      <aside className="space-y-4">
        <OutputPanel g={g} model={model} over={over} set={set} />

        {g.shape === 'SQU' && <SquarePanel g={g} model={model} set={set} />}
        {spec.levels ? <LevelPanel g={g} set={set} /> : <AmplitudePanel g={g} set={set} />}

        <Panel title="Power-on">
          <Toggle label="Restore output at power-on" on={g.startup} onChange={(startup) => set({ startup })} />
        </Panel>
      </aside>
    </div>
  );
}

function Preview({ g, model }: { g: Gen; model: Model }) {
  // ZT703S: the DAC codes as set. ZT706S: the nominal amplitude on a 0–5 V scale.
  const [lo, hi, label] = MODELS[model].levels
    ? [g.low / 4095, g.high / 4095, `DAC code ${g.low} → ${g.high}`]
    : [0, g.amp / 5, `Amplitude ${g.amp.toFixed(1)} V (nominal)`];
  const y = (v: number) => 170 - v * 160;
  return (
    <Panel title="Preview" right={<span className="font-mono text-[11px] text-muted">{label}</span>}>
      <svg viewBox="0 0 800 180" className="h-44 w-full" preserveAspectRatio="none">
        {[0, 1, 2, 3].map((i) => <line key={i} x1={i * 200} x2={i * 200} y1="0" y2="180" stroke="#30363d" strokeDasharray="3 5" />)}
        <line x1="0" x2="800" y1={y(hi)} y2={y(hi)} stroke="#8b949e55" strokeDasharray="6 6" />
        <line x1="0" x2="800" y1={y(lo)} y2={y(lo)} stroke="#8b949e55" strokeDasharray="6 6" />
        <g transform={`translate(0 ${y(hi)})`}>
          <path d={path(g.shape, g.duty, 800, (hi - lo) * 160, 4)} fill="none" stroke={g.out ? '#22c55e' : '#3b82f6'} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
    </Panel>
  );
}

function SquarePanel({ g, model, set }: { g: Gen; model: Model; set: SetGen }) {
  const { duty, levels } = MODELS[model];
  return (
    <Panel title="Square">
      <div className="space-y-3">
        <label className="block text-xs">
          <div className="mb-1 flex justify-between"><span className="text-muted">Duty cycle</span><span className="font-mono">{g.duty.toFixed(1)} %</span></div>
          <input type="range" min={duty.min} max={duty.max} step={duty.step} value={g.duty} onChange={(e) => set({ duty: +e.target.value })} className="w-full accent-accent" />
        </label>
        {levels && (
          <Row label="Drive">
            <Seg size="xs" value={g.drive} options={[{ id: 'FACT', label: 'Factory' }, { id: 'PWM', label: 'PWM' }]} onChange={(drive) => set({ drive })} />
          </Row>
        )}
      </div>
    </Panel>
  );
}

// ZT703S: DAC level profiles and raw codes.
function LevelPanel({ g, set }: { g: Gen; set: SetGen }) {
  return (
    <Panel title="Level">
      <div className="space-y-3">
        <Seg size="xs" className="w-full" value={g.prof} options={[{ id: 'DED', label: 'Dedicated' }, { id: 'LOW', label: 'Low' }, { id: 'HIGH', label: 'High' }, { id: 'CUST', label: 'Custom' }]} onChange={(prof) => set({ prof })} />
        {(['low', 'high'] as const).map((k) => (
          <label key={k} className="block text-xs">
            <div className="mb-1 flex justify-between"><span className="text-muted">{k === 'low' ? 'Low code' : 'High code'}</span><span className="font-mono">{g[k]}</span></div>
            <input type="range" min={0} max={4095} value={g[k]} onChange={(e) => set({ [k]: +e.target.value, prof: 'CUST' })} className="w-full accent-accent" />
          </label>
        ))}
        <p className="flex gap-1.5 text-[11px] text-muted">
          <Info size={13} className="shrink-0" />
          Raw DAC codes 0–4095. The ZT703S generator has no voltage calibration; measure the output with the scope.
        </p>
      </div>
    </Panel>
  );
}

function OutputPanel({ g, model, over, set }: { g: Gen; model: Model; over: boolean; set: SetGen }) {
  return (
    <Panel title="Output">
      <button
        onClick={() => set({ out: !g.out })}
        disabled={over}
        className={clsx(
          'flex w-full items-center justify-center gap-2 rounded-lg border py-4 text-base font-bold transition-all disabled:opacity-40',
          g.out ? 'border-success bg-success/15 text-success shadow-[0_0_24px_rgba(34,197,94,0.25)]' : 'border-border bg-canvas text-muted hover:text-fg',
        )}
      >
        <Power size={18} /> {g.out ? 'ON' : 'OFF'}
      </button>
      <p className="mt-2 text-[11px] text-muted">Output keeps running when you switch to another view.</p>
      {genHalvesScope(model, g) && <p className="mt-2 flex gap-1.5 text-[11px] text-amber"><Info size={13} className="shrink-0" /> {HALVED_NOTE}</p>}
    </Panel>
  );
}

// ZT706S: module amplitude, 0.1 V steps, capped by shape and frequency (ampLimit).
function AmplitudePanel({ g, set }: { g: Gen; set: SetGen }) {
  const cap = ampLimit(g.shape, g.freq);
  return (
    <Panel title="Amplitude">
      <div className="space-y-3">
        <label className="block text-xs">
          <div className="mb-1 flex justify-between"><span className="text-muted">Amplitude</span><span className={clsx('font-mono', g.amp > cap && 'text-danger')}>{g.amp.toFixed(1)} V</span></div>
          <input type="range" min={0} max={cap} step={0.1} value={Math.min(g.amp, cap)} onChange={(e) => set({ amp: +(+e.target.value).toFixed(1) })} className="w-full accent-accent" />
        </label>
        <p className="flex gap-1.5 text-[11px] text-muted">
          <Info size={13} className="shrink-0" />
          Nominal module amplitude, not measured. Up to {cap.toFixed(1)} V for this shape and frequency.
        </p>
      </div>
    </Panel>
  );
}
