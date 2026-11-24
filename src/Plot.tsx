import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

// Thin uPlot host: rebuilds on `opts` identity change, pushes `data` without rebuilding.
export function Plot({ opts, data, className }: { opts: Omit<uPlot.Options, 'width' | 'height'>; data: uPlot.AlignedData; className?: string }) {
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

  return <div ref={box} className={className} />;
}

export const AXIS = { stroke: '#8b949e', grid: { stroke: '#30363d', width: 1 }, ticks: { stroke: '#30363d', width: 1 }, font: '11px "Geist Mono Variable", monospace' };
