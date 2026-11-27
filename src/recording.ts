// The multimeter's recording as fixed-size typed columns: appending never copies, and the chart and
// the saved copy read it in O(window) / O(new chunks), whatever its length.

export const REC_MAX = 1_800_000; // valid readings: ~7 days at 3/s, ~29 MB
const SHIFT = 10, CHUNK = 1 << SHIFT;
// Per-block min/max lets a wide chart column skip the block's readings.
const BSHIFT = 6, BLOCK = 1 << BSHIFT;

type Chunk = {
  t: Float64Array; v: Float64Array; // v NaN = gap (OL, blank or pause)
  // Per block. Its first and last time live here too: reading them from `t` costs a cache miss each.
  t0: Float64Array; t1: Float64Array; lo: Float64Array; tlo: Float64Array; hi: Float64Array; thi: Float64Array; gap: Uint8Array;
};
export type SavedChunk = { t: Float64Array; v: Float64Array };

const newChunk = (): Chunk => {
  const b = CHUNK / BLOCK;
  return {
    t: new Float64Array(CHUNK), v: new Float64Array(CHUNK), t0: new Float64Array(b), t1: new Float64Array(b),
    lo: new Float64Array(b).fill(Infinity), tlo: new Float64Array(b), hi: new Float64Array(b).fill(-Infinity), thi: new Float64Array(b), gap: new Uint8Array(b),
  };
};

export class Recording {
  chunks: Chunk[] = [];
  length = 0;
  valid = 0;
  gen = 0; // moves when the contents are replaced (clear, load), not when they grow

  t(i: number) { return this.chunks[i >> SHIFT].t[i & (CHUNK - 1)]; }
  v(i: number) { return this.chunks[i >> SHIFT].v[i & (CHUNK - 1)]; }
  get chunkCount() { return this.chunks.length; }

  // Ties keep the earlier minimum and the later maximum, as `decimate` scans.
  push(time: number, v: number) {
    const i = this.length, slot = i & (CHUNK - 1);
    if (!slot) this.chunks.push(newChunk());
    const c = this.chunks[i >> SHIFT], b = slot >> BSHIFT;
    const t = i ? Math.max(time, this.t(i - 1)) : time; // sorted through a clock step: windows binary-search
    c.t[slot] = t;
    c.v[slot] = v;
    if (!(slot & (BLOCK - 1))) c.t0[b] = t;
    c.t1[b] = t;
    this.length++;
    if (Number.isNaN(v)) { c.gap[b] = 1; return; }
    this.valid++;
    if (v < c.lo[b]) { c.lo[b] = v; c.tlo[b] = t; }
    if (v >= c.hi[b]) { c.hi[b] = v; c.thi[b] = t; }
  }

  // A break after the last value; false when there is none to break.
  gap(t: number) {
    if (!this.length || Number.isNaN(this.v(this.length - 1))) return false;
    this.push(t, NaN);
    return true;
  }

  clear() {
    this.chunks = [];
    this.length = this.valid = 0;
    this.gen++;
  }

  chunk(k: number): SavedChunk {
    const n = Math.min(CHUNK, this.length - k * CHUNK), c = this.chunks[k];
    return { t: c.t.slice(0, n), v: c.v.slice(0, n) };
  }

  load(saved: SavedChunk[]) {
    this.clear();
    for (const s of saved) for (let j = 0; j < s.t.length; j++) this.push(s.t[j], s.v[j]);
  }

  // The CSV in one string per chunk: a 1.8 M-row log never becomes one string.
  csvParts(label: string, unit: string) {
    const parts = ['time,function,value,unit\n'];
    for (let k = 0; k < this.chunks.length; k++) {
      const { t, v } = this.chunk(k);
      let s = '';
      for (let j = 0; j < t.length; j++) if (!Number.isNaN(v[j])) s += `${new Date(t[j] * 1000).toISOString()},${label},${v[j]},${unit}\n`;
      parts.push(s);
    }
    return parts;
  }
}

// Last index with t <= x, -1 when none.
function find(r: Recording, x: number) {
  let lo = 0, hi = r.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (r.t(m) <= x) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

// `gaps`: the first gap's time in each column, for the chart's markers (a short gap is narrower than a
// pixel on a wide window).
export type Trace = { t: number[]; v: (number | null)[]; gaps: number[] };
type Point = [t: number, v: number | null];

// One chart column: its min and max reading, and its first and last gap (index of the gap entry).
class Column {
  lo = Infinity; tlo = 0; hi = -Infinity; thi = 0; g1 = -1; g2 = -1;
  low(v: number, t: number) { if (v < this.lo) { this.lo = v; this.tlo = t; } }
  high(v: number, t: number) { if (v >= this.hi) { this.hi = v; this.thi = t; } }

  // Its min and max in time order (one point when they are the same reading).
  values(put: (t: number, v: number) => void) {
    if (this.lo > this.hi) return;
    const lowFirst = this.tlo <= this.thi;
    put(lowFirst ? this.tlo : this.thi, lowFirst ? this.lo : this.hi);
    if (this.thi !== this.tlo || this.hi !== this.lo) put(lowFirst ? this.thi : this.tlo, lowFirst ? this.hi : this.lo);
  }

  // Into `out` in time order. A gap draws the held value to its time, then breaks the line.
  emit(r: Recording, out: Trace) {
    if (this.g1 < 0) return this.values((t, v) => { out.t.push(t); out.v.push(v); }); // the common case, no sort
    out.gaps.push(r.t(this.g1));
    const pts: Point[] = [];
    this.values((t, v) => pts.push([t, v]));
    for (const g of this.g2 === this.g1 ? [this.g1] : [this.g1, this.g2]) {
      if (g < 0) continue;
      if (g > 0 && !Number.isNaN(r.v(g - 1))) pts.push([r.t(g), r.v(g - 1)]);
      pts.push([r.t(g), null]);
    }
    for (const [t, v] of pts.sort((p, q) => p[0] - q[0])) { out.t.push(t); out.v.push(v); }
  }
}

// What the trend draws for [x0, x1] in `cols` columns, plus the reading held into it from before x0:
// every reading in a sparse column, the real min and max of a full one (a transient is never smoothed
// away). A block wholly inside one column is read from its summary: ~3 ms for 1.8 M readings, 4x
// faster than reading them all. The ~77 k readings at column edges are still scanned; a summary tree
// would cut that, not worth it at 3 calls/s.
export function decimate(r: Recording, x0: number, x1: number, cols = 1200): Trace {
  const out: Trace = { t: [], v: [], gaps: [] }, end = find(r, x1);
  const w = x1 > x0 ? (x1 - x0) / cols : 1;
  let cur = NaN, c = new Column();
  for (let i = Math.max(0, find(r, x0)); i <= end;) {
    const ch = r.chunks[i >> SHIFT], slot = i & (CHUNK - 1), b = slot >> BSHIFT, start = !(slot & (BLOCK - 1));
    const t = start ? ch.t0[b] : ch.t[slot], k = Math.floor((t - x0) / w);
    if (k !== cur) { c.emit(r, out); c = new Column(); cur = k; } // an empty column emits nothing
    if (start && i + BLOCK - 1 <= end && !ch.gap[b] && Math.floor((ch.t1[b] - x0) / w) === k) {
      c.low(ch.lo[b], ch.tlo[b]);
      c.high(ch.hi[b], ch.thi[b]);
      i += BLOCK;
      continue;
    }
    const v = ch.v[slot];
    if (Number.isNaN(v)) { if (c.g1 < 0) c.g1 = i; c.g2 = i; }
    else { c.low(v, t); c.high(v, t); }
    i++;
  }
  c.emit(r, out);
  return out;
}

type Mark = { gen: number; length: number };
export type FlushPlan = { clear: boolean; from: number | null }; // from: first chunk to write, null = none

// What one flush writes, given what storage holds (`saved`, length 0 = nothing) and the recording now.
export function flushPlan(saved: Mark, rec: Mark & { valid: number }): FlushPlan | null {
  if (!rec.valid) return saved.length ? { clear: true, from: null } : null;
  if (rec.gen !== saved.gen) return { clear: true, from: 0 }; // replaced: old chunks past the new end must go
  if (rec.length === saved.length) return null;
  return { clear: false, from: saved.length >> SHIFT }; // the chunk holding the first unsaved entry
}
