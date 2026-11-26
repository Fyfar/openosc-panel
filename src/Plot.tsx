import { useEffect, useRef, type RefObject } from 'react';
import uPlot from 'uplot';

// Thin uPlot host: rebuilds on `opts` identity change, pushes `data` without rebuilding.
// `x` pins the x window via setScale (pair it with `scales.x.auto: false`): uPlot then finds the
// visible slice and fits auto-ranged y to it, so callers pass whole arrays, never a slice.
export function Plot({ opts, data, x, className }: { opts: Omit<uPlot.Options, 'width' | 'height'>; data: uPlot.AlignedData; x?: readonly [number, number]; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = box.current!;
    const u = new uPlot({ ...opts, width: el.clientWidth, height: el.clientHeight }, data, el);
    plot.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => { ro.disconnect(); u.destroy(); plot.current = null; };
  }, [opts]);

  useEffect(() => { plot.current?.setData(data); }, [data]);

  const [x0, x1] = x ?? [];
  useEffect(() => { if (x0 !== undefined && x1 !== undefined) plot.current?.setScale('x', { min: x0, max: x1 }); }, [x0, x1, opts]);

  return <div ref={box} className={className} />;
}

// uPlot's live legend (the values under the cursor), mounted outside the plot, e.g. in a panel header
// with the `head-legend` class. A value is '—' while the cursor is off the data.
export const legendIn = (box: RefObject<HTMLElement | null>): uPlot.Legend => ({ live: true, mount: (_u, el) => box.current?.replaceChildren(el) });
export const legendValue = (fmt: (v: number) => string) => (_u: uPlot, v: number | null) => (v == null ? '—' : fmt(v));

export const AXIS = { stroke: '#8b949e', grid: { stroke: '#30363d', width: 1 }, ticks: { stroke: '#30363d', width: 1 }, font: '11px "Geist Mono Variable", monospace' };
