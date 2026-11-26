// Device facts for ZT703S / ZT706S on OpenOSC 0.21.x, from the SCPI reference + measurements on a
// real ZT703S. Pickers use these lists
// because the firmware rejects off-step V/div (-222) — never offer free entry for them.

export type Mode = 'dmm' | 'scope' | 'gen' | 'bode';
export type Profile = 'DS1052' | 'XDM1041';

// Generator keeps whatever profile is active (no re-enumeration); Bode needs scope capture.
export const PROFILE_OF: Record<Mode, Profile | null> = {
  dmm: 'XDM1041',
  scope: 'DS1052',
  gen: null,
  bode: 'DS1052',
};

export const SWITCH_MS = 760; // measured scope⇄DMM SYST:MODE → *IDN? answered

export const TIMEBASES = [
  10e-9, 25e-9, 50e-9, 100e-9, 250e-9, 500e-9,
  1e-6, 2e-6, 5e-6, 10e-6, 20e-6, 50e-6, 100e-6, 200e-6, 500e-6,
  1e-3, 2e-3, 5e-3, 10e-3, 20e-3, 50e-3, 100e-3, 200e-3, 500e-3,
  1, 2, 5, 10, 20,
];

// mV/div at the input, before probe ratio.
export const VDIV_MV = [20, 40, 50, 100, 200, 500, 1000, 2000, 2500, 5000, 10000];
export const PROBES = [1, 10, 50, 100, 500, 1000, 10000];
export const MEM_DEPTHS = [65536, 131072, 262144, 524288];

export type Shape = 'SIN' | 'SQU' | 'TRI' | 'HALF' | 'POS' | 'RAMP';
export const SHAPES: { id: Shape; label: string }[] = [
  { id: 'SIN', label: 'Sine' },
  { id: 'SQU', label: 'Square' },
  { id: 'TRI', label: 'Triangle' },
  { id: 'HALF', label: 'Half sine' },
  { id: 'POS', label: 'Positive sine' },
  { id: 'RAMP', label: 'Ramp' },
];

// Per-model limits, from OpenOSC 0.21.7 source (generator/waveform.hpp, generator/capabilities.hpp,
// module_wave.cpp, acquisition/interleave.hpp) and the wiki's Supported Devices / Signal Generator.
// Both boards share scope timebases, V/div steps, DMM functions and the SCPI dialects; DMM ranges
// and resolution come from the device itself. ZT706S values are the firmware's nominal ones:
// upstream marks that board "not yet run on hardware".
export type Model = 'ZT703S' | 'ZT706S';
export const MODELS: Record<Model, {
  maxHz: Record<Shape, number>;
  minHz: number;
  duty: { min: number; max: number; step: number };
  levels: boolean; // ZT703S: DAC level profiles / codes / square drive
  amplitude: boolean; // ZT706S: SOUR:VOLT, 0.1 V steps
  counts: number;
}> = {
  ZT703S: {
    // Sine at exactly 344 kHz is rejected on hardware, so the UI ceiling sits just below.
    maxHz: { SIN: 343_999, SQU: 1_000_000, TRI: 100_000, HALF: 129_000, POS: 294_000, RAMP: 100_000 },
    minHz: 0.001,
    duty: { min: 0, max: 100, step: 0.5 },
    levels: true, amplitude: false, counts: 25000,
  },
  ZT706S: {
    maxHz: { SIN: 10_000_000, SQU: 2_000_000, TRI: 2_000_000, HALF: 2_000_000, POS: 2_000_000, RAMP: 200_000 },
    minHz: 1,
    duty: { min: 1, max: 100, step: 0.1 },
    levels: false, amplitude: true, counts: 66000,
  },
};

// "0.21.9" ≥ "0.21.8"; an unknown version counts as old.
export function fwAtLeast(fw: string | undefined, min: string): boolean {
  const a = (fw ?? '').match(/\d+/g)?.map(Number) ?? [], b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] ?? -1) !== b[i]) return (a[i] ?? -1) > b[i];
  return true;
}
// WAV:FRAM?, WAV:POIN:MODE PEAK, WAV:MEAS?, MMEM (firmware docs/SCPI_DESKTOP.md).
export const DESKTOP_FW = '0.21.9';

// ZT703S from 0.21.8: on the 200 MHz profile (the only one with USB) a DAC update takes ≥ 32 timer
// ticks, so a DAC shape plays at most 200 MHz / 32 / 28 points = 223.2 kHz (waveform.hpp
// SlowProfileTimerTicks, maximumMillihertz). Older firmware keeps the measured 0.21.4/0.21.5 limits.
const ZT703S_DAC_MAX = 223_214;
export function genMaxHz(model: Model, fw: string | undefined): Record<Shape, number> {
  const m = MODELS[model].maxHz;
  if (model !== 'ZT703S' || !fwAtLeast(fw, '0.21.8')) return m;
  return { ...m, SIN: Math.min(m.SIN, ZT703S_DAC_MAX), POS: Math.min(m.POS, ZT703S_DAC_MAX) };
}

// ACQ:INT:STAT? blocker bits: why a requested interleave is not in force.
// Names follow InterleaveConditions::Blocker (acquisition/interleave.hpp).
const INTERLEAVE_BLOCKERS: [number, string][] = [
  [1, 'board'], [2, 'performance profile'], [4, 'timebase'], [8, 'not CH1 alone'], [16, 'Roll'],
  [32, 'internal capture'], [64, 'generator DAC'], [128, 'option off'],
];
export const interleaveBlockers = (bits: number) => INTERLEAVE_BLOCKERS.filter(([b]) => bits & b).map(([, name]) => name);

// ZT706S module: highest amplitude (V) for a shape at a frequency (module_wave.cpp limitMillivolts).
export function ampLimit(shape: Shape, hz: number): number {
  if (shape === 'SIN') return hz < 1e6 ? 5 : hz < 7e6 ? 4 : hz < 10e6 ? 3.5 : 3;
  if (shape === 'TRI' || shape === 'HALF' || shape === 'POS') return hz < 1e6 ? 5 : 4;
  return shape === 'RAMP' ? 4 : 5;
}

// ZT706S: the highest sine the module plays at an amplitude (capabilities.hpp sineMaximumMillihertz).
const sineMaxAt = (volts: number) => (volts <= 3 ? 10e6 : volts <= 3.5 ? 9.52e6 : volts <= 4 ? 6.9e6 : 995e3);

// ZT703S: the generator's DAC stream shares the bus with the capture, so the scope's maximum sample
// rate is halved while it runs (firmware bus_load.cpp). A Dedicated square on PWM (drive PWM, or from
// 1 kHz: waveform.hpp Levels::pwm) and the ZT706S module (UART) don't load the bus.
export function genHalvesScope(model: Model, g: { out: boolean; shape: Shape; prof: string; drive: string; freq: number }): boolean {
  const pwm = g.shape === 'SQU' && g.prof === 'DED' && (g.drive === 'PWM' || g.freq >= 1000);
  return model === 'ZT703S' && g.out && !pwm;
}
export const HALVED_NOTE = 'Generator on: scope max sample rate is halved while it runs (the DAC shares the bus with the capture).';

// Top of a Bode sweep: the sine limit, on the ZT706S also capped by the amplitude set.
export const bodeMaxHz = (model: Model, volts: number, fw: string | undefined) =>
  Math.min(genMaxHz(model, fw).SIN, MODELS[model].amplitude ? sineMaxAt(volts) : Infinity);

// A Bode point's timebase: at least 4 periods on the 10 divisions.
export const bodeTimebase = (f: number) => TIMEBASES.find((t) => t * 10 >= 4 / f) ?? TIMEBASES.at(-1)!;

// Estimated sweep time (s), fitted on a ZT703S (0.21.14): per point the settle plus 3 records
// (r = 10 × the timebase at 32 768 per channel), each arriving every 2r below 1 s and r + ~1.2 s above,
// at least ~0.5 s of commands and transfer; the ZT706S module adds ~0.6 s per command.
export const bodeEta = (plan: number[], model: Model) => plan.reduce((s, f) => {
  const r = 10 * bodeTimebase(f);
  return s + Math.max(0.5, Math.max(0.08, 5 / f) + 3 * (r + Math.min(r, 1.2))) + (model === 'ZT706S' ? 0.6 : 0);
}, 0);

// The Bode view shows a "slow signal" line on these points (they take ~3.5–24 s). Rounded like the
// SOUR:FREQ that pointCmds sends: bodePlan's 10 Hz point is 10.000000000000002.
export const bodeSlow = (f: number) => +f.toPrecision(6) <= 10;

// Log-spaced sweep frequencies, both ends included. Shared by the Bode preview and the sweep.
export function bodePlan(start: number, stop: number, ppd: number): number[] {
  const n = Math.max(2, Math.round(Math.log10(stop / start) * ppd) + 1);
  return Array.from({ length: n }, (_, i) => start * (stop / start) ** (i / (n - 1)));
}

export type DmmFunc =
  | 'VDC' | 'VAC' | 'MVDC' | 'MVAC' | 'ADC' | 'AAC' | 'MADC' | 'MAAC'
  | 'RES' | 'CONT' | 'DIOD' | 'CAP' | 'TEMP';

// Ranges come from the device (SYST:DMM:RANG:LIST?). `dp`: a function it lists none for shows one
// layout, base unit and that many decimals (measured on the ZT703S; diode also OpenOSC dmm/scale.hpp).
export const DMM_FUNCS: { id: DmmFunc; label: string; short: string; base: string; dp?: number }[] = [
  { id: 'VDC', label: 'DC Voltage', short: 'V⎓', base: 'V' },
  { id: 'VAC', label: 'AC Voltage', short: 'V~', base: 'V' },
  { id: 'MVDC', label: 'DC Millivolts', short: 'mV⎓', base: 'V' },
  { id: 'MVAC', label: 'AC Millivolts', short: 'mV~', base: 'V' },
  { id: 'ADC', label: 'DC Current', short: 'A⎓', base: 'A' },
  { id: 'AAC', label: 'AC Current', short: 'A~', base: 'A' },
  { id: 'MADC', label: 'DC Milliamps', short: 'mA⎓', base: 'A' },
  { id: 'MAAC', label: 'AC Milliamps', short: 'mA~', base: 'A' },
  { id: 'RES', label: 'Resistance', short: 'Ω', base: 'Ω' },
  { id: 'CONT', label: 'Continuity', short: '•))', base: 'Ω', dp: 2 },
  { id: 'DIOD', label: 'Diode', short: '→|', base: 'V', dp: 3 },
  { id: 'CAP', label: 'Capacitance', short: '⊣⊢', base: 'F' },
  { id: 'TEMP', label: 'Temperature', short: '°C', base: '°C', dp: 1 },
];

export const HOLD_MODES = ['MAN', 'DEL', 'STAB', 'AUTO'] as const;
export type HoldMode = (typeof HOLD_MODES)[number];

// A channel's volts per division at the probe tip.
export const vdiv = (c: { vdivMv: number; probe: number }) => (c.vdivMv * c.probe) / 1000;

export function fmtTime(s: number): string {
  const a = Math.abs(s);
  if (a === 0) return '0 s';
  if (a < 1e-6) return `${+(s * 1e9).toPrecision(4)} ns`;
  if (a < 1e-3) return `${+(s * 1e6).toPrecision(4)} µs`;
  if (a < 1) return `${+(s * 1e3).toPrecision(4)} ms`;
  return `${+s.toPrecision(4)} s`;
}

export function fmtVolt(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && a < 1) return `${+(v * 1e3).toPrecision(4)} mV`;
  return `${+v.toPrecision(4)} V`;
}

export function fmtHz(f: number, compact = false): string {
  const [v, u] = f >= 1e6 ? [f / 1e6, 'MHz'] : f >= 1e3 ? [f / 1e3, 'kHz'] : [f, 'Hz'];
  return `${compact ? +v.toPrecision(3) : v.toPrecision(5)} ${u}`;
}

const SI_PREFIX = ['p', 'n', 'µ', 'm', '', 'k', 'M', 'G']; // 10^-12 … 10^9

// A live readout that doesn't jump: `digits` significant digits with trailing zeros kept, and a
// sticky prefix that changes only when the value leaves [0.95, 1000) of the current one, so a
// reading hovering at an edge (999.8 Hz ↔ 1.0002 kHz) keeps its unit. Pass `exp` back next time.
export function fmtStable(v: number, unit: string, digits: number, prev?: number): { text: string; exp: number } {
  if (!Number.isFinite(v)) return { text: '—', exp: prev ?? 0 };
  const a = Math.abs(v), r = prev === undefined ? NaN : a / 10 ** prev;
  const natural = a ? Math.floor(Math.log10(a) / 3) * 3 : (prev ?? 0);
  const exp = Math.min(9, Math.max(-12, (r >= 0.95 && r < 1000) || a === 0 ? (prev ?? natural) : natural));
  const x = v / 10 ** exp;
  const dp = x ? Math.min(digits - 1, Math.max(0, digits - 1 - Math.floor(Math.log10(Math.abs(x))))) : digits - 1;
  const s = x.toFixed(dp);
  if (Math.abs(+s) >= 1000 && exp < 9) return fmtStable(v, unit, digits, exp + 3); // 999.996 rounds to 1000.0
  return { text: `${s} ${SI_PREFIX[(exp + 12) / 3]}${unit}`, exp };
}

// Typed frequency: "10k", "10 kHz", "2.5MHz", "1e3", "500 mHz". k/K is kilo; m is milli and
// M is mega (case matters only there). Null when it isn't a positive number.
export function parseHz(text: string): number | null {
  const m = text.trim().match(/^(\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+)\s*([mkKM]?)\s*(?:hz)?$/i);
  if (!m) return null;
  const f = parseFloat(m[1]) * ({ m: 1e-3, k: 1e3, K: 1e3, M: 1e6 }[m[2]] ?? 1);
  return f > 0 ? f : null;
}

const PREFIX: [number, string][] = [[1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
// 5 digits: matches the firmware's range decimals on both models (dmm/ranges.cpp: ZT703S 2.5 V → 4
// decimals, 25000 counts; ZT706S 6.6 V → 4 decimals, 66000 counts).
const DIGITS = 5;
// Ranges the meter shows with one decimal where the digit rule gives two (OpenOSC dmm/ranges.cpp):
// 750 V AC and the ZT703S's 250 MΩ.
const ONE_DECIMAL = [750, 250e6];

// A function's base unit; temperature follows the meter's °C/°F setting.
export const dmmBase = (func: DmmFunc, fahrenheit: boolean) => (fahrenheit && func === 'TEMP' ? '°F' : DMM_FUNCS.find((x) => x.id === func)!.base);

// A reading's unit and decimals: the function's fixed layout, else its active range's.
export function dmmScale(func: DmmFunc, rangeMax?: number, fahrenheit = false) {
  const base = dmmBase(func, fahrenheit), { dp } = DMM_FUNCS.find((x) => x.id === func)!;
  return dp === undefined ? scaleFor(rangeMax ?? 1, base) : { div: 1, unit: base, dp, lsd: 10 ** -dp };
}

// DMM display prefix and decimals from a range's maximum.
export function scaleFor(ref: number, base: string) {
  const r = Math.abs(ref) || 1;
  // The meter's 1000 V range is in V; its 999.9 nF and µF ranges stay in nF and µF (just under one).
  const [div, p] = PREFIX.find(([d]) => r / d >= 1 && !(r === 1000 && d > 1)) ?? PREFIX.at(-1)!;
  const digits = base === 'F' ? 4 : DIGITS; // capacitance ranges are 4-digit (9.999 nF … 99.99 mF) on both models
  const dp = ONE_DECIMAL.includes(r) ? 1 : Math.max(0, digits - 1 - Math.floor(Math.log10(r / div) + 1e-9));
  return { div, unit: p + base, dp, lsd: div * 10 ** -dp };
}
