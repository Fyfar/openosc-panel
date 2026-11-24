// Signal generator: settings diff (order matters, see genDiff) and readback.
import { MODELS, SHAPES, type Model } from '../device';
import type { State } from '../store';
import { ctl, finite, get, link, on, remote } from './core';

type Gen = State['gen'];
const PROF = { DED: 'DEDicated', LOW: 'LOW', HIGH: 'HIGH', CUST: 'CUSTom' } as const;
export const SHAPE_CMD = { SIN: 'SINusoid', SQU: 'SQUare', TRI: 'TRIangle', HALF: 'HALF', POS: 'POSitive', RAMP: 'RAMP' } as const;

// Sent in this order when the field changed. `levels`: ZT703S DAC level commands (-241 on ZT706S).
const GEN_SETTERS: [keyof Gen, (g: Gen) => string, 'levels'?][] = [
  ['duty', (g) => `SOUR:PULS:DCYC ${g.duty}`],
  ['prof', (g) => `SOUR:LEV:PROF ${PROF[g.prof]}`, 'levels'],
  ['low', (g) => `SOUR:LEV:LOW ${g.low}`, 'levels'],
  ['high', (g) => `SOUR:LEV:HIGH ${g.high}`, 'levels'],
  ['drive', (g) => `SOUR:SQU:DRIV ${g.drive === 'FACT' ? 'FACTory' : 'PWM'}`, 'levels'],
  ['out', (g) => `OUTP ${g.out ? 'ON' : 'OFF'}`],
  ['startup', (g) => `OUTP:STAR ${g.startup ? 'RESTore' : 'OFF'}`],
];

function shapeAndFreq(a: Gen, b: Gen): string[] {
  const freq = a.freq !== b.freq ? [`SOUR:FREQ ${b.freq}`] : [];
  if (a.shape === b.shape) return freq;
  const func = `SOUR:FUNC ${SHAPE_CMD[b.shape]}`;
  // SOUR:FUNC is refused (-221) while the frequency is above the new shape's limit: lower first.
  return b.freq < a.freq ? [...freq, func] : [func, ...freq];
}

export function genDiff(a: Gen, b: Gen, model: Model): string[] {
  const { levels, amplitude } = MODELS[model];
  // ZT706S: the amplitude cap depends on shape and frequency, so a lower amplitude goes first
  // and a higher one last (the firmware refuses a combination over the cap with -221/-222).
  const amp = amplitude && a.amp !== b.amp ? [`SOUR:VOLT ${b.amp.toFixed(1)}`] : [];
  const rest = GEN_SETTERS.filter(([k, , only]) => a[k] !== b[k] && (!only || levels)).map(([, cmd]) => cmd(b));
  return [...(b.amp < a.amp ? amp : []), ...shapeAndFreq(a, b), ...(b.amp > a.amp ? amp : []), ...rest];
}

export async function flushGen(a: Gen, b: Gen) {
  const c = genDiff(a, b, get().model);
  if (c.length) { await ctl(c); await readGen(true); }
}

const profOf = (s: string) => (['DED', 'LOW', 'HIGH', 'CUST'] as const).find((p) => s.toUpperCase().startsWith(p.slice(0, 3)));

// ZT703S: SOUR:LEV:PROF? answers the full name ("Dedicated"), SOUR:SQU:DRIV? "FACT" or "PWM".
function parseLevels([prof, low, high, drive]: string[], g: Gen): Partial<Gen> {
  return { prof: profOf(prof) ?? g.prof, low: finite(low, g.low), high: finite(high, g.high), drive: drive.toUpperCase().startsWith('PWM') ? 'PWM' : 'FACT' };
}

// Never throws: a failed read leaves the store as it is.
export async function readGen(force = false) {
  const { levels } = MODELS[get().model];
  const extra = levels ? ['SOUR:LEV:PROF?', 'SOUR:LEV:LOW?', 'SOUR:LEV:HIGH?', 'SOUR:SQU:DRIV?'] : ['SOUR:VOLT?'];
  const r = await link.texts(['SOUR:FUNC?', 'SOUR:FREQ?', 'SOUR:PULS:DCYC?', 'OUTP?', 'OUTP:STAR?', ...extra]).catch(() => null);
  if (!r) return;
  const [func, freq, duty, out, star] = r, g = get().gen;
  const shape = SHAPES.find((s) => func.toUpperCase().startsWith(s.id))?.id ?? g.shape;
  const model = levels ? parseLevels(r.slice(5), g) : { amp: finite(r[5], g.amp) };
  remote('gen', { shape, freq: finite(freq, g.freq), duty: finite(duty, g.duty), out: on(out), startup: star.toUpperCase().startsWith('REST'), ...model }, force);
}
