import { create } from 'zustand';
import type { DmmFunc, HoldMode, Mode, Model, Profile, Shape, TrigType, TrigWhen } from './device';
import { emptyStats, type DmmStats, type FftSpan, type FftWindow } from './dsp';

export type LinkState = 'disconnected' | 'connecting' | 'connected' | 'switching';

export type Channel = { on: boolean; coup: 'DC' | 'AC'; probe: number; vdivMv: number; offsetDiv: number };
export type Sweep = 'AUTO' | 'NORM' | 'SING';
// slope: also the qualified types' polarity (one firmware field). level: Edge and Pulse; lvLow/lvHigh:
// the Runt and Rise/fall band (volts); tLow/tUpp: time limits (seconds).
export type ScopeTrig = {
  type: TrigType; src: 1 | 2; slope: 'POS' | 'NEG'; level: number; nrej: boolean; pos: number;
  when: TrigWhen; tLow: number; tUpp: number; lvLow: number; lvHigh: number;
};
export type CursorMode = 'OFF' | 'T' | 'V' | 'TV'; // the device's Off / Time / Level / Time+Level
export type FftScale = 'DBV' | 'DBFS' | 'LIN';
export type SaveOff = 'unavailable' | 'full' | 'other-tab' | 'failed'; // why the DMM recording isn't saved
export type Cond = { above: boolean; v: number }; // a logging trigger condition, `v` in the base unit
// The logging trigger (io/dmm.ts). `key`: the function and unit the conditions were entered in.
export type Trig = { key: string; start: Cond | null; stop: Cond | null; repeat: boolean };
export const NO_TRIG: Trig = { key: '', start: null, stop: null, repeat: false };

// Mirrors the device. io.ts writes device state here and turns user edits of the
// `dmm` / `scope` / `gen` settings into SCPI (diff-based, see io.ts sync()).
export type State = {
  link: LinkState;
  error: string | null;
  errors: number;
  idn: { model: string; serial: string; fw: string } | null;
  fwWarn: string | null; // firmware below FW.min or unreadable ('' then): connect waits for answerFw
  model: Model; // detected on connect (SOUR:VOLT? exists on ZT706S only)
  profile: Profile;
  mode: Mode;
  remote: boolean;
  console: boolean;
  consoleLog: string[];
  shot: boolean;
  stats: string;
  // View-only flags: kept out of the dmm/scope slices so toggling them sends no SCPI.
  cursors: CursorMode;
  fft: boolean;
  fftWin: FftWindow;
  fftScale: FftScale;
  fftSrc: 0 | 1;
  fftSpan: FftSpan;
  fftMarkers: boolean;
  logging: boolean;
  armed: boolean; // waiting for `trig.start`; never while logging
  trig: Trig; // app-only: never in the `dmm` slice, which is diffed into SCPI
  update: boolean; // a newer deploy exists (src/pwa.ts); the user decides when to reload

  dmm: { func: DmmFunc; auto: boolean; range: number; hold: boolean; holdMode: HoldMode; rel: boolean; cj: number | null };
  ranges: number[]; // SI maxima from SYST:DMM:RANG:LIST?
  fahrenheit: boolean; // SYST:DMM:TEMP:UNIT?
  reading: { v: number | null; over: boolean; blank: boolean; sec: number | null; seq: number } | null;
  recRev: number; // moves on every change of the recording (io/dmm.ts `dmmRec`, kept out of the store)
  dstats: DmmStats; // of every recorded reading; `n` is the recording's count
  recorded: { func: DmmFunc; fahrenheit: boolean; rangeMax?: number } | null; // what the recording holds
  // A recording found in storage at page load, not restored or discarded yet (io/saved.ts).
  savedOffer: { func: DmmFunc; fahrenheit: boolean; valid: number; last: number; known: boolean } | null;
  saveState: { kind: 'idle' } | { kind: 'saved'; at: number } | { kind: 'off'; why: SaveOff };
  junctionNeeded: boolean; // CONF:TEMP was refused: Type K has no cold junction configured

  scope: {
    sweep: Sweep;
    ch: [Channel, Channel];
    tb: number; // index into TIMEBASES
    hoff: number; // seconds, time at screen centre
    trig: ScopeTrig;
    mdepth: number;
    roll: boolean;
    interleave: 'OFF' | 'ON' | 'AUTO'; // AUTO: the firmware's rule (both boards, measured ZT703S 0.21.9)
  };
  scopeStatus: {
    stat: string; srate: number; lastSweep: 'AUTO' | 'NORM';
    fcnt: [number, number]; // hardware counter per channel (CHANn:FCNT?), NaN when not settled
    qual: string; // counter quality, trigger channel only (MEAS:FCNT:QUAL?)
    interleave: { active: boolean; blockers: number } | null; // ACQ:INT:STAT?
    capture: { active: boolean; seq: number; since: number }; // ACQ:PROG?; since = host time this record started
  };

  gen: { shape: Shape; freq: number; duty: number; prof: 'DED' | 'LOW' | 'HIGH' | 'CUST'; low: number; high: number; drive: 'FACT' | 'PWM'; amp: number; out: boolean; startup: boolean };
  bode: { start: number; stop: number; ppd: number; running: boolean; stopping: boolean; progress: number; at: number | null; points: { f: number; db: number; ph: number }[] };

  set: (p: Partial<State>) => void;
  patch: <K extends 'dmm' | 'scope' | 'gen' | 'bode'>(k: K, p: Partial<State[K]>) => void;
};

// What a reload or close would lose: the DMM log and Bode results exist only in memory.
export const unsavedData = (s: State) => s.dstats.n > 0 || s.bode.running || s.bode.points.length > 0;

export const useDev = create<State>((set) => ({
  link: 'disconnected',
  error: null,
  errors: 0,
  idn: null,
  fwWarn: null,
  model: 'ZT703S',
  profile: 'DS1052',
  mode: 'scope',
  remote: false,
  console: false,
  consoleLog: [],
  shot: false,
  update: false,
  stats: '',
  cursors: 'OFF',
  fft: false,
  fftWin: 'HANN',
  fftScale: 'DBV',
  fftSrc: 0,
  fftSpan: 'AUTO',
  fftMarkers: false,
  logging: false,
  armed: false,
  trig: NO_TRIG,

  dmm: { func: 'VDC', auto: true, range: 0, hold: false, holdMode: 'MAN', rel: false, cj: null },
  ranges: [],
  fahrenheit: false,
  reading: null,
  recRev: 0,
  dstats: emptyStats(),
  recorded: null,
  junctionNeeded: false,
  savedOffer: null,
  saveState: { kind: 'idle' },

  scope: {
    sweep: 'AUTO',
    ch: [
      { on: true, coup: 'DC', probe: 1, vdivMv: 1000, offsetDiv: 0 },
      { on: false, coup: 'DC', probe: 1, vdivMv: 1000, offsetDiv: 0 },
    ],
    tb: 15,
    hoff: 0,
    trig: { type: 'EDGE', src: 1, slope: 'POS', level: 0, nrej: false, pos: 50, when: 'GRE', tLow: 1e-6, tUpp: 1e-5, lvLow: 0, lvHigh: 0 },
    mdepth: 131072,
    roll: false,
    interleave: 'OFF',
  },
  scopeStatus: { stat: '—', srate: NaN, lastSweep: 'AUTO', fcnt: [NaN, NaN], qual: '', interleave: null, capture: { active: false, seq: NaN, since: 0 } },

  gen: { shape: 'SIN', freq: 1000, duty: 50, prof: 'DED', low: 0, high: 4095, drive: 'FACT', amp: 3, out: false, startup: false },
  bode: { start: 10, stop: 100_000, ppd: 10, running: false, stopping: false, progress: 0, at: null, points: [] },

  set: (p) => set(p),
  patch: (k, p) => set((s) => ({ [k]: { ...s[k], ...p } }) as Partial<State>),
}));
