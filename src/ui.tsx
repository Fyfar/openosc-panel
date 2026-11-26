import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Children, type ReactNode } from 'react';

export const CH_COLOR = ['#facc15', '#22d3ee'];

// The division grid of the scope trace and the FFT: strokes the current path dotted.
export function strokeGrid(g: CanvasRenderingContext2D, dpr: number) {
  g.strokeStyle = '#465263';
  g.lineWidth = 1;
  g.setLineDash([2 * dpr, 3 * dpr]);
  g.stroke();
  g.setLineDash([]);
}

// Readouts in columns of three, after a label column. In each column the labels are as wide as
// its longest label and every value has a fixed 10ch slot, so a changing value never moves the
// next column. Scrolls sideways rather than wrapping, so every value keeps its place.
export function Columns({ head, children, className }: { head: ReactNode; children: ReactNode; className?: string }) {
  const cells = Children.toArray(children);
  const cols = Array.from({ length: Math.ceil(cells.length / 3) }, (_, i) => cells.slice(3 * i, 3 * i + 3));
  return (
    <div className={clsx('flex gap-x-5 overflow-x-auto', className)}>
      <div className="flex w-10 shrink-0 flex-col gap-y-1">{head}</div>
      <div className="flex gap-x-12">
        {cols.map((col, i) => <div key={i} className="grid shrink-0 grid-cols-[auto_10ch] content-start gap-x-2 gap-y-1">{col}</div>)}
      </div>
    </div>
  );
}

// One label + value pair: two cells of its column's grid.
export function M({ l, v, hint }: { l: string; v: string; hint?: string }) {
  return (
    <>
      <span title={hint} className="text-muted whitespace-nowrap">{l}</span>
      <span title={hint} className="tabular-nums whitespace-nowrap text-fg">{v}</span>
    </>
  );
}

export function Panel({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-lg border border-border bg-panel p-4', className)}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, size = 'sm', className }: {
  value: T;
  options: { id: T; label: ReactNode; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'xs';
  className?: string;
}) {
  return (
    <div className={clsx('inline-flex rounded-md border border-border bg-canvas p-0.5', className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.id)}
          role="radio"
          aria-checked={o.id === value}
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          className={clsx(
            'flex-1 rounded-[5px] font-medium whitespace-nowrap transition-colors disabled:opacity-35',
            size === 'sm' ? 'px-3 py-1 text-xs' : 'px-2 py-0.5 text-[11px]',
            o.id === value ? 'bg-accent text-white' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={clsx('flex items-center justify-between gap-3 text-xs', disabled && 'opacity-40')}>
      <span className="text-muted">{label}</span>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-surface border border-border')}
      >
        <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', on ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  );
}

// Steps through a fixed list — the firmware accepts only listed values (V/div, timebase, probe).
export function Stepper({ label, value, display, count, onChange, color }: {
  label: string; value: number; display: string; count: number; onChange: (i: number) => void; color?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <div className="flex items-center rounded-md border border-border bg-canvas">
        <button aria-label={`${label} down`} disabled={value <= 0} onClick={() => onChange(value - 1)} className="px-1.5 py-1 text-muted hover:text-fg disabled:opacity-30">
          <ChevronLeft size={13} />
        </button>
        <span className="min-w-[78px] text-center font-mono font-semibold tabular-nums" style={{ color }}>{display}</span>
        <button aria-label={`${label} up`} disabled={value >= count - 1} onClick={() => onChange(value + 1)} className="px-1.5 py-1 text-muted hover:text-fg disabled:opacity-30">
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted">{label}</span>
      {children}
    </div>
  );
}

export function Select<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <select
      aria-label={label}
      value={String(value)}
      onChange={(e) => onChange(options.find((o) => String(o.id) === e.target.value)!.id)}
      className="rounded-md border border-border bg-canvas px-2 py-1 font-mono text-xs text-fg"
    >
      {options.map((o) => <option key={String(o.id)} value={String(o.id)}>{o.label}</option>)}
    </select>
  );
}

export function Btn({ children, onClick, tone = 'neutral', active, className, title, disabled }: {
  children: ReactNode; onClick?: () => void; tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'amber';
  active?: boolean; className?: string; title?: string; disabled?: boolean;
}) {
  const tones = {
    neutral: active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-border bg-surface text-fg hover:border-muted',
    accent: 'border-accent bg-accent text-white hover:brightness-110',
    success: active ? 'border-success bg-success text-black' : 'border-success/40 bg-success/10 text-success hover:bg-success/20',
    danger: active ? 'border-danger bg-danger text-white' : 'border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
    amber: active ? 'border-amber bg-amber text-black' : 'border-amber/40 bg-amber/10 text-amber hover:bg-amber/20',
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx('inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40', tones[tone], className)}
    >
      {children}
    </button>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-canvas px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('font-mono text-sm font-semibold tabular-nums', tone ?? 'text-fg')}>{value}</div>
    </div>
  );
}
