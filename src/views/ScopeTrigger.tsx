// The scope trigger panel: Edge and the qualified types (Pulse width, Runt, Rise/fall time, FW.qualTrig).
import { decidesHigh, FW, fmtTime, fmtVolt, fwHas, isBand, parseSI, TRIG_TIME, TRIG_TYPES, vdiv, type TrigType, type TrigWhen } from '../device';
import { extent } from '../dsp';
import * as io from '../io';
import { useDev, type ScopeTrig, type State } from '../store';
import { Btn, CH_COLOR, Row, Seg, SiField, Slider, Toggle } from '../ui';

type Scope = State['scope'];
type SetScope = (p: Partial<Scope>) => void;
const SWEEPS = [{ id: 'AUTO', label: 'Auto' }, { id: 'NORM', label: 'Normal' }, { id: 'SING', label: 'Single' }] as const;
const WHEN_LABEL: Record<TrigWhen, string> = { ANY: 'Any', LESS: '< max', GRE: '> min', INS: 'Inside', OUTS: 'Outside' };

// One line for the top bar, the Trigger section and the PNG: "Runt ↑ CH1 1 V–2 V", "Pulse ↑ <50 µs CH1 2 V".
export function trigText(t: ScopeTrig): string {
  const name = t.type === 'SLOP' ? (t.slope === 'POS' ? 'Rise' : 'Fall') : t.type === 'EDGE' ? '' : TRIG_TYPES.find((x) => x.id === t.type)!.label;
  const arrow = t.type === 'SLOP' ? '' : t.slope === 'POS' ? '↑' : '↓';
  const level = isBand(t.type) ? `${fmtVolt(t.lvLow)}–${fmtVolt(t.lvHigh)}` : fmtVolt(t.level);
  return [name, arrow, t.type === 'EDGE' ? '' : condText(t), `CH${t.src}`, level].filter(Boolean).join(' ');
}

function condText(t: ScopeTrig): string {
  // The firmware orders a window's limits itself (measured 0.21.19), so show them ordered too.
  const lo = fmtTime(Math.min(t.tLow, t.tUpp)), hi = fmtTime(Math.max(t.tLow, t.tUpp));
  return { ANY: '', LESS: `<${fmtTime(t.tUpp)}`, GRE: `>${fmtTime(t.tLow)}`, INS: `in ${lo}–${hi}`, OUTS: `out ${lo}–${hi}` }[t.when];
}

function polarity(type: TrigType) {
  if (type === 'PULS' || type === 'RUNT') return { label: 'Polarity', pos: '⊓ Positive', neg: '⊔ Negative' };
  if (type === 'SLOP') return { label: 'Transition', pos: '↑ Rise', neg: '↓ Fall' };
  return { label: 'Slope', pos: '↑ Rising', neg: '↓ Falling' };
}

export function TriggerBody({ s, set, say }: { s: Scope; set: SetScope; say: (m: string) => void }) {
  const qual = useDev((st) => fwHas(st.idn?.fw, 'qualTrig'));
  const t = s.trig, band = isBand(t.type), pol = polarity(t.type);
  const setT = (p: Partial<ScopeTrig>) => set({ trig: { ...t, ...p } });
  const need = qual ? undefined : `Needs OpenOSC ${FW.qualTrig} or newer`;
  // TIM:OFFS and TRIG:POS set the same firmware value (the trigger position), so both go to centre.
  const center = () => set({ hoff: 0, trig: { ...t, pos: 50 } });
  return (
    <div className="space-y-3">
      <Row label="Type">
        <Seg size="xs" value={t.type} onChange={(type) => setT({ type })}
          options={TRIG_TYPES.map((o) => ({ ...o, disabled: o.id !== 'EDGE' && !qual, title: o.id === 'EDGE' ? undefined : need }))} />
      </Row>
      <Row label={pol.label}>
        <Seg size="xs" value={t.slope} options={[{ id: 'POS', label: pol.pos }, { id: 'NEG', label: pol.neg }]} onChange={(slope) => setT({ slope })} />
      </Row>
      <Row label="Sweep">
        <Seg size="xs" value={s.sweep} options={[...SWEEPS]} onChange={(sweep) => (sweep === 'SING' ? void io.scopeSingle() : set({ sweep }))} />
      </Row>
      {band ? <BandLevels s={s} setT={setT} /> : <LevelSlider s={s} v={t.level} label="Level" onChange={(level) => setT({ level })} />}
      {t.type !== 'EDGE' && <TimeCondition t={t} setT={setT} say={say} />}
      <Slider label="Position" value={t.pos} min={0} max={100} step={0.5} show={`${t.pos.toFixed(1)} %`} onChange={(pos) => setT({ pos })} />
      <Toggle label="Noise reject" on={t.nrej} onChange={(nrej) => setT({ nrej })} />
      <div className="flex gap-2">
        {!band && <Trigger50 s={s} set={set} say={say} />}
        <Btn className="flex-1" title="Trigger mark to the middle of the screen (pretrigger 50 %)" onClick={center}>Center trigger</Btn>
      </div>
    </div>
  );
}

// The device's hold-F3 / "Trigger 50%": level to the signal midpoint, pretrigger 50 %.
function Trigger50({ s, set, say }: { s: Scope; set: SetScope; say: (m: string) => void }) {
  const go = () => {
    const f = io.scopeData.frames.find((fr) => fr.ch === s.trig.src - 1);
    if (!f) return say('No frame from the trigger channel yet');
    const lo = extent(f.lo ?? f.volts).mn, hi = extent(f.hi ?? f.volts).mx;
    set({ hoff: 0, trig: { ...s.trig, level: +((lo + hi) / 2).toPrecision(4), pos: 50 } });
  };
  return <Btn className="flex-1" title="Level to the signal midpoint, pretrigger 50 %" onClick={go}>Trigger 50 %</Btn>;
}

// A trigger level: the meter accepts the trigger channel's screen, ±4 div around its offset (8-bit codes).
function LevelSlider({ s, v, label, onChange }: { s: Scope; v: number; label: string; onChange: (v: number) => void }) {
  const src = s.ch[s.trig.src - 1], vd = vdiv(src);
  return (
    <Slider label={label} value={v} min={(-4 - src.offsetDiv) * vd} max={(4 - src.offsetDiv) * vd} step={vd / 25}
      show={fmtVolt(v)} color={CH_COLOR[s.trig.src - 1]} onChange={onChange} />
  );
}

// Runt and Rise/fall: low stays one slider step below high (the meter takes equal levels; its docs say
// keep them distinct). The deciding level is named.
function BandLevels({ s, setT }: { s: Scope; setT: (p: Partial<ScopeTrig>) => void }) {
  const t = s.trig, gap = vdiv(s.ch[t.src - 1]) / 25, high = decidesHigh(t);
  return (
    <>
      <LevelSlider s={s} v={t.lvHigh} label={high ? 'High level (trigger)' : 'High level'} onChange={(v) => setT({ lvHigh: Math.max(v, t.lvLow + gap) })} />
      <LevelSlider s={s} v={t.lvLow} label={high ? 'Low level' : 'Low level (trigger)'} onChange={(v) => setT({ lvLow: Math.min(v, t.lvHigh - gap) })} />
    </>
  );
}

function TimeCondition({ t, setT, say }: { t: ScopeTrig; setT: (p: Partial<ScopeTrig>) => void; say: (m: string) => void }) {
  const srate = useDev((st) => st.scopeStatus.srate);
  // Any is the Runt's; shown for another type only when the meter reports it (it accepts it for Pulse).
  const whens = (Object.keys(WHEN_LABEL) as TrigWhen[]).filter((w) => w !== 'ANY' || t.type === 'RUNT' || t.when === 'ANY');
  const lower = t.when === 'GRE' || t.when === 'INS' || t.when === 'OUTS';
  const upper = t.when === 'LESS' || t.when === 'INS' || t.when === 'OUTS';
  const commit = (key: 'tLow' | 'tUpp') => (text: string) => {
    const v = parseSI(text, 's');
    if (v === null || v < TRIG_TIME.min || v > TRIG_TIME.max) say(`"${text.trim()}" is not a time from 1 ns to 1 s: try 50us, 1.2 ms or 2e-6.`);
    else setT({ [key]: v });
  };
  return (
    <div className="space-y-2">
      <Row label="Condition">
        <Seg size="xs" value={t.when} options={whens.map((id) => ({ id, label: WHEN_LABEL[id] }))} onChange={(when) => setT({ when })} />
      </Row>
      {lower && <TimeField label={t.when === 'GRE' ? 'Longer than' : 'Min'} v={t.tLow} onCommit={commit('tLow')} />}
      {upper && <TimeField label={t.when === 'LESS' ? 'Shorter than' : 'Max'} v={t.tUpp} onCommit={commit('tUpp')} />}
      {(lower || upper) && Number.isFinite(srate) && srate > 0 && (
        <p className="text-[11px] text-muted">Resolution ≈ {fmtTime(1 / srate)} (one sample at the current rate)</p>
      )}
    </div>
  );
}

function TimeField({ label, v, onCommit }: { label: string; v: number; onCommit: (text: string) => void }) {
  return (
    <Row label={label}>
      <SiField label={label} value={v} fmt={fmtTime} onCommit={onCommit}
        className="w-28 rounded-md border border-border bg-canvas px-2 py-1 text-right font-mono text-xs tabular-nums outline-none focus:border-accent" />
    </Row>
  );
}
