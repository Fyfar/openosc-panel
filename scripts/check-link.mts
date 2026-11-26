// Self-check for src/link.ts and the DMM loop against a fake one-command-at-a-time device.
// Run: `npm run check`. Covers reply framing, the late-reply resync, tx atomicity, and a poll
// loop surviving a timeout (each of these broke or was missing before 0.5.0).
import assert from 'node:assert/strict';
import { Link, sleep } from '../src/link.ts';
import { ctl, link, remote, runLoop, stopLoop } from '../src/io/core.ts';
import { setMode } from '../src/io/index.ts'; // also: the store → SCPI subscription (drag coalescing)
import { clearDmmData, dmmLogCsv, dmmLoop, flushDmm, logMatches, startDmmLog, stopDmmLog } from '../src/io/dmm.ts';
import { scopeData, scopeLoop, scopeRun } from '../src/io/scope.ts';
import { bodeStop, bodeSweep } from '../src/io/bode.ts';
import { useDev } from '../src/store.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const IDN = 'OpenOSC,DS1052,TEST0001,0.21.7';
type Answer = string | Uint8Array | { after: number; reply: string } | null;

// Answers each line in order and only after the previous answer, like the firmware. `ahead`: the most
// lines ever received past the last answered query (the firmware parser holds 4).
function fakePort(answer: (cmd: string) => Answer) {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let busy = Promise.resolve();
  let pending = '', answered = -1;
  const written: string[] = [];
  const seen = { ahead: 0 };
  const emit = (b: Uint8Array) => { try { out.enqueue(b); } catch { /* port closed */ } };
  const port = {
    readable: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        pending += dec.decode(chunk);
        for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) {
          const cmd = pending.slice(0, i), at = written.length;
          pending = pending.slice(i + 1);
          written.push(cmd);
          seen.ahead = Math.max(seen.ahead, at - answered);
          busy = busy.then(async () => {
            await sleep(0); // a real port's reads are tasks: a loop that never sleeps must not starve timers
            const a = answer(cmd);
            if (a === null) return;
            if (a instanceof Uint8Array) emit(a);
            else if (typeof a === 'string') emit(enc.encode(a + '\n'));
            else { await sleep(a.after); emit(enc.encode(a.reply + '\n')); }
            if (cmd.includes('?')) answered = at;
          });
        }
      },
    }),
    open: async () => {},
    close: async () => {},
    getInfo: () => ({}),
  };
  return { port: port as unknown as SerialPort, written, seen };
}

let checks = 0;

// Recorded data outlives a loop and a link: each DMM section starts from none.
const freshDmm = async () => { stopDmmLog(); await clearDmmData(); };

// --- framing: a binary block is cut by its length, not by the 0x0a bytes inside it --------
{
  const l = new Link();
  const got: unknown[] = [];
  for (const part of ['a\r\n#', '2', '05', [1, 10], [35, 10, 2], '\n', 'next\n']) {
    l.push(typeof part === 'string' ? enc.encode(part) : Uint8Array.from(part));
    for (let r = l.take(); r; r = l.take()) got.push(r.text ?? [...r.bin!]);
  }
  assert.deepEqual(got, ['a', [1, 10, 35, 10, 2], 'next']);
  checks++;
}

// --- run: one reply per query, none for set-commands -------------------------------------
{
  const dev = fakePort((c) => ({ 'A?': 'a', 'B?': 'b' })[c] ?? null);
  const l = new Link();
  await l.open(dev.port);
  assert.deepEqual((await l.run(['X 1', 'A?', 'Y 2', 'B?'])).map((r) => r.text), ['a', 'b']);
  checks++;

  // tx holds the chain: a run queued meanwhile goes after both of the tx's batches.
  const t = l.tx(async (run) => { await run(['A?']); await sleep(50); await run(['B?']); });
  const r = l.run(['A?']);
  await Promise.all([t, r]);
  assert.deepEqual(dev.written.slice(-3), ['A?', 'B?', 'A?']);
  checks++;
  await l.close();
}

// --- queries go out without waiting for each reply, but never more than the parser's 4 lines past the
// last answer: behind a blocking query (a ZT706S generator setting, FRAM? waiting for a record) a line
// left half-received for 3 s resets the firmware parser (-102)
{
  const dev = fakePort((c) => (c === 'SLOW?' ? { after: 200, reply: 'slow' } : c.includes('?') ? c.slice(0, -1).toLowerCase() : null));
  const l = new Link();
  await l.open(dev.port);
  const lines = ['SLOW?', 'A?', 'X 1', 'B?', 'C?', 'Y 2', 'D?', 'E?', 'F?', 'G?'];
  assert.deepEqual((await l.run(lines)).map((r) => r.text), ['slow', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.ok(dev.seen.ahead >= 3, `queries pipelined: at most ${dev.seen.ahead} line(s) ahead of an answer`);
  assert.ok(dev.seen.ahead <= 4, `${dev.seen.ahead} lines ahead of the last answer: more than the parser holds`);
  checks += 3;
  await l.close();
}

// --- a reply that lands after its timeout must not answer the next query -----------------
{
  const dev = fakePort((c) => (c === 'SLOW?' ? { after: 1000, reply: 'slow' } : c === '*IDN?' ? IDN : c === 'A?' ? 'a' : null));
  const l = new Link();
  await l.open(dev.port);
  await assert.rejects(l.run(['SLOW?'], 300), /timeout/);
  assert.equal(await l.q('A?'), 'a', 'late "slow" reply shifted the next answer');
  checks++;
  await l.close();
}

// --- identify skips a stale reply from a previous session ---------------------------------
{
  const dev = fakePort((c) => (c === '*IDN?' ? enc.encode(`1.234\n${IDN}\n`) : null));
  const l = new Link();
  await l.open(dev.port);
  assert.equal(await l.identify(), IDN);
  checks++;
  await l.close();
}

// --- the DMM loop keeps polling after a query times out (it used to die silently), and turns
// on the secondary reading: the firmware reports it only after FUNC2 FREQ (session flag, off at boot)
{
  let seq = 0, func2 = false;
  const res = () => `1,1.234,0,${func2 ? '50.02' : 'NAN'},${func2 ? 4 : 0},1,1,0,0,${++seq},0`;
  const cfg: Record<string, string> = {
    'FUNC?': '"VOLT AC"', 'SYST:DMM:RANG:LIST?': '3,2.5,25,250', 'AUTO?': '1', 'SYST:DMM:HOLD?': '0',
    'SYST:DMM:REL?': '0', 'SYST:DMM:HOLD:MODE?': 'MAN', '*IDN?': IDN, 'SYST:ERR?': '0,"No error"',
    'SYST:DMM:TEMP:CJUN?': '22.5', 'SYST:DMM:TEMP:UNIT?': 'C', 'SYST:REM?': '0',
  };
  const dev = fakePort((c) => {
    if (c === 'FUNC2 FREQ') func2 = true;
    return c === 'SYST:DMM:RES?' ? (seq === 2 ? { after: 3500, reply: res() } : res()) : cfg[c] ?? null;
  });
  startDmmLog();
  await link.open(dev.port);
  runLoop('dmm', dmmLoop);
  for (const end = performance.now() + 9000; (useDev.getState().reading?.seq ?? 0) < 6 && performance.now() < end;) await sleep(100);
  await stopLoop();
  await link.close();
  assert.ok((useDev.getState().reading?.seq ?? 0) >= 6, `loop stopped at seq ${useDev.getState().reading?.seq}`);
  assert.equal(useDev.getState().reading?.sec, 50.02, 'secondary (AC frequency) reaches the reading');
  assert.equal(useDev.getState().dmm.cj, 22.5, 'stored manual junction is read back');
  checks += 3;

  const csv = dmmLogCsv().trim().split('\n');
  assert.equal(csv[0], 'time,function,value,unit');
  assert.match(csv[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z,AC Voltage,1\.234,V$/);
  checks++;
}

// --- Type K hint: set only by a refused CONF:TEMP (no cold junction), cleared by a function change
{
  let func = '"VOLT"', err = '0,"No error"';
  const dev = fakePort((c) => {
    if (c === 'CONF:TEMP') err = '-221,"Settings conflict"';
    if (c === '*CLS') err = '0,"No error"';
    const cfg: Record<string, string> = {
      'FUNC?': func, 'SYST:DMM:RANG:LIST?': '3,2.5,25,250', 'AUTO?': '1', 'SYST:DMM:HOLD?': '0', 'SYST:DMM:REL?': '0',
      'SYST:DMM:HOLD:MODE?': 'MAN', 'SYST:DMM:TEMP:CJUN?': 'NAN', 'SYST:DMM:TEMP:UNIT?': 'C', 'SYST:ERR?': err, '*IDN?': IDN, 'SYST:REM?': '0',
    };
    return cfg[c] ?? null;
  });
  await link.open(dev.port);
  const v = { ...useDev.getState().dmm, func: 'VDC' as const, cj: null };
  await flushDmm({ ...v, cj: 21 }, { ...v, func: 'TEMP', cj: 21 });
  assert.equal(useDev.getState().junctionNeeded, false, 'with a manual junction stored, -221 is not about the junction');
  useDev.setState({ hist: { t: [1, 2], v: [1.5, 1.6] }, logging: true });
  await flushDmm(v, { ...v, func: 'TEMP' });
  assert.equal(useDev.getState().junctionNeeded, true, 'refused CONF:TEMP asks for a junction');
  assert.equal(useDev.getState().hist.v.length, 2, 'a refused CONF keeps the current trend');
  assert.equal(useDev.getState().logging, true, 'and keeps logging');
  func = '"RES"'; // the user turns the meter's own keys
  await flushDmm(v, { ...v, func: 'RES' });
  assert.equal(useDev.getState().junctionNeeded, false, 'any other function change clears it');
  await link.close();
  await freshDmm();
  checks += 5;
}

// --- an overload reading: SYST:DMM:RES? sends NAN with status 6 (not MEAS?'s 1E+9) --------
{
  let seq = 100;
  const cfg: Record<string, string> = {
    'FUNC?': '"RES"', 'SYST:DMM:RANG:LIST?': '2,250,2500', 'AUTO?': '1', 'SYST:DMM:HOLD?': '0', 'SYST:DMM:REL?': '0',
    'SYST:DMM:HOLD:MODE?': 'MAN', 'SYST:DMM:TEMP:CJUN?': 'NAN', 'SYST:DMM:TEMP:UNIT?': 'C', 'SYST:ERR?': '0,"No error"', '*IDN?': IDN, 'SYST:REM?': '0',
  };
  const dev = fakePort((c) => (c === 'SYST:DMM:RES?' ? `2,NAN,6,NAN,0,2,1,0,0,${++seq},0` : cfg[c] ?? null));
  useDev.setState({ reading: null });
  await link.open(dev.port);
  runLoop('dmm', dmmLoop);
  for (const end = performance.now() + 3000; !useDev.getState().reading && performance.now() < end;) await sleep(50);
  await stopLoop();
  await link.close();
  const r = useDev.getState().reading;
  assert.deepEqual([r?.over, r?.blank, r?.v], [true, false, null], 'overload shows OL, not ----');
  checks++;
}

// --- °F: RES? stays in °C (the meter converts only its screen), so the panel converts, without the
// +32 under REL; a unit change on the meter stops logging and the data stays in °F
{
  let seq = 200, unit = 'F', rel = 0, value = 25;
  const dev = fakePort((c) => {
    const cfg: Record<string, string> = {
      'FUNC?': '"TEMP"', 'SYST:DMM:RANG:LIST?': '0', 'AUTO?': '0', 'SYST:DMM:HOLD?': '0', 'SYST:DMM:REL?': String(rel),
      'SYST:DMM:HOLD:MODE?': 'MAN', 'SYST:DMM:TEMP:CJUN?': '22.5', 'SYST:DMM:TEMP:UNIT?': unit,
      'SYST:ERR?': '0,"No error"', '*IDN?': IDN, 'SYST:REM?': '0',
    };
    return c === 'SYST:DMM:RES?' ? `12,${value},0,NAN,0,0,-1,0,${rel},${++seq},0` : cfg[c] ?? null;
  });
  const shows = async (v: number, what: string) => {
    for (const end = performance.now() + 4000; useDev.getState().reading?.v !== v && performance.now() < end;) await sleep(50);
    assert.equal(useDev.getState().reading?.v, v, what);
  };
  useDev.setState({ reading: null });
  await freshDmm();
  startDmmLog();
  await link.open(dev.port);
  runLoop('dmm', dmmLoop);
  await shows(77, '25 °C shows as 77 °F');
  assert.equal(useDev.getState().dstats.min, 77, 'statistics are in °F too');
  assert.match(dmmLogCsv().trim().split('\n').at(-1)!, /,Temperature,77,°F$/);
  rel = 1; value = 10;
  await shows(18, 'a REL difference converts without +32');
  rel = 0; value = 25; unit = 'C';
  await shows(25, 'back to °C after the unit changes on the meter');
  assert.equal(useDev.getState().logging, false, 'a unit change stops logging');
  assert.ok(useDev.getState().hist.v.every((v) => v === null || v === 77 || v === 18) && useDev.getState().dstats.max === 77, 'no °C in the °F data');
  assert.ok(dmmLogCsv().trim().split('\n').slice(1).every((row) => row.endsWith(',°F')));
  assert.equal(logMatches(useDev.getState().recorded, 'TEMP', false), false, '°C does not match °F data');
  await stopLoop();
  await link.close();
  await freshDmm();
  checks += 9;
}

// A fake meter the test turns: function, ranges and reading. `seq` stands still while `held`.
function fakeMeter() {
  const m = { id: 0, func: 'VOLT', ranges: '3,2.5,25,250', value: '1.5', status: 0, seq: 1000, held: false };
  const dev = fakePort((c) => {
    if (c === 'SYST:DMM:RES?') return `${m.id},${m.value},${m.status},NAN,0,1,1,0,0,${m.held ? m.seq : ++m.seq},0`;
    const cfg: Record<string, string> = {
      'FUNC?': `"${m.func}"`, 'SYST:DMM:RANG:LIST?': m.ranges, 'AUTO?': '1', 'SYST:DMM:HOLD?': '0', 'SYST:DMM:REL?': '0',
      'SYST:DMM:HOLD:MODE?': 'MAN', 'SYST:DMM:TEMP:CJUN?': 'NAN', 'SYST:DMM:TEMP:UNIT?': 'C', 'SYST:ERR?': '0,"No error"', '*IDN?': IDN, 'SYST:REM?': '0',
    };
    return cfg[c] ?? (c.includes('?') ? 'NAN' : null);
  });
  const VDC = { id: 0, func: 'VOLT', ranges: '3,2.5,25,250', value: '1.5', status: 0 };
  const RES = { id: 2, func: 'RES', ranges: '2,250,2500', value: '100', status: 0 };
  return { m, dev, VDC, RES };
}
const dmmState = () => useDev.getState();
const nulls = () => dmmState().hist.v.filter((v) => v === null).length;

// --- recording: only while logging; stop pauses; a function change stops it; Clear is the only reset
{
  const { m, dev, VDC, RES } = fakeMeter();
  // Three more readings have been through the loop.
  const polled = async () => { const to = m.seq + 3; await until(() => (dmmState().reading?.seq ?? 0) >= to, 'readings keep coming'); };
  const recorded = () => [dmmState().logged, dmmState().dstats.n, dmmState().hist.v.length];
  const rows = () => dmmLogCsv().trim().split('\n').slice(1);
  useDev.setState({ reading: null });
  await link.open(dev.port);
  await freshDmm();
  runLoop('dmm', dmmLoop);
  await polled();
  assert.deepEqual(recorded(), [0, 0, 0], 'nothing is recorded before logging starts');
  assert.equal(dmmState().reading?.v, 1.5, 'the readout is live without logging');

  startDmmLog();
  await until(() => dmmState().logged >= 3, 'logging records');
  assert.equal(dmmState().dstats.n, dmmState().logged, 'statistics and CSV hold the same readings');
  assert.deepEqual(dmmState().recorded, { func: 'VDC', fahrenheit: false, rangeMax: 2.5 }, 'what the data is');

  Object.assign(m, { value: 'NAN', status: 6 });
  await until(() => dmmState().reading?.over === true, 'OL');
  let n = dmmState().logged;
  await polled();
  assert.deepEqual([dmmState().logged, dmmState().dstats.n, dmmState().hist.v.at(-1)], [n, n, null], 'OL breaks the line and is not counted');
  Object.assign(m, VDC);
  await until(() => dmmState().hist.v.at(-1) === 1.5, 'recording again after OL');

  stopDmmLog();
  const [rows0, , points] = recorded();
  assert.deepEqual([dmmState().logging, dmmState().hist.v.at(-1)], [false, null], 'stop breaks the line');
  await polled();
  assert.deepEqual([dmmState().logged, dmmState().hist.t.length], [rows0, points], 'stopped: nothing is added');
  startDmmLog();
  await until(() => dmmState().logged > rows0, 'starting again adds to the data');
  assert.equal(dmmState().hist.v[points - 1], null, 'the break stays between the two runs');

  m.id = 13; // dmm::Function::Unknown
  await polled();
  n = dmmState().logged;
  await polled();
  assert.deepEqual([dmmState().logging, dmmState().logged], [true, n], 'an unknown function is neither recorded nor a change');
  m.id = 0;
  await until(() => dmmState().logged > n, 'recording goes on');

  Object.assign(m, RES);
  await until(() => !dmmState().logging, 'a function change stops logging');
  await until(() => dmmState().dmm.func === 'RES', 'the panel follows');
  n = dmmState().logged;
  await polled();
  assert.equal(dmmState().logged, n);
  assert.ok(rows().every((r) => r.includes(',DC Voltage,')) && !dmmState().hist.v.includes(100), 'no reading of the new function in the data');
  assert.equal(logMatches(dmmState().recorded, dmmState().dmm.func, false), false, 'resistance does not match volt data');
  Object.assign(m, VDC);
  await until(() => dmmState().dmm.func === 'VDC', 'switched back');
  assert.equal(logMatches(dmmState().recorded, 'VDC', false), true);

  startDmmLog();
  await until(() => dmmState().logged > n, 'resumed on the same function');
  Object.assign(m, { id: 8, ranges: '2,0.025,0.25', value: '0.0012' }); // FUNC? still says VOLT
  await until(() => !dmmState().logging && dmmState().dmm.func === 'MVDC', 'V → mV on the meter keys stops logging and is followed');
  assert.ok(!dmmState().hist.v.includes(0.0012));

  await clearDmmData();
  assert.deepEqual([...recorded(), dmmState().recorded, rows().filter(Boolean).length], [0, 0, 0, null, 0], 'Clear data empties everything');
  assert.equal(dmmState().logging, false);
  assert.ok(dev.written.includes('SYST:DMM:STAT:RES'), 'and resets the meter statistics');

  Object.assign(m, VDC);
  await until(() => dmmState().dmm.func === 'VDC', 'back on V');
  startDmmLog();
  await until(() => dmmState().logged >= 3, 'logging');
  n = dmmState().logged;
  const cleared = clearDmmData();
  assert.equal(dmmState().logged, 0);
  await cleared;
  await until(() => dmmState().logged >= 1, 'Clear while logging keeps logging');
  assert.deepEqual([dmmState().logging, dmmState().dstats.n], [true, dmmState().logged]);

  await freshDmm();
  Object.assign(m, RES, { value: 'NAN', status: 6 });
  await until(() => dmmState().dmm.func === 'RES' && dmmState().reading?.over === true, 'open probes');
  startDmmLog();
  await polled();
  Object.assign(m, { id: 5, func: 'CAP', ranges: '1,0.000001' });
  await until(() => !dmmState().logging, 'a change stops logging with nothing recorded yet');
  startDmmLog();
  await polled();
  assert.deepEqual([dmmState().logging, dmmState().logged], [true, 0], 'with no data, any function can be logged');

  // The meter goes away: a profile switch or a lost link.
  for (const gone of ['switching', 'disconnected'] as const) {
    await freshDmm();
    Object.assign(m, VDC);
    await until(() => dmmState().dmm.func === 'VDC' && dmmState().reading?.v === 1.5, 'back on V');
    useDev.setState({ link: 'connected' });
    startDmmLog();
    await until(() => dmmState().logged >= 1, 'logging');
    useDev.setState({ link: gone });
    assert.deepEqual([dmmState().logging, dmmState().logged > 0, dmmState().hist.v.at(-1)], [false, true, null], `link ${gone}: logging stops, data kept`);
  }

  await stopLoop();
  await link.close();
  checks += 22;
}

// --- the generator view keeps the meter profile: logging goes on there, each reading once, no break
{
  const { m, dev } = fakeMeter();
  const sent = () => dev.written.filter((c) => c === 'SYST:DMM:RES?').length;
  await link.open(dev.port);
  await freshDmm();
  useDev.setState({ link: 'connected', profile: 'XDM1041', mode: 'dmm', reading: null });
  await setMode('dmm');
  startDmmLog();
  await until(() => dmmState().logged >= 2, 'logging in the multimeter view');
  m.held = true; // no new reading across the view change
  await sleep(300);
  const n = dmmState().logged, breaks = nulls();
  await setMode('gen');
  await sleep(400);
  assert.equal(dmmState().logged, n, 'a view change records no reading twice');
  m.held = false;
  await until(() => dmmState().logged > n + 2, 'the generator view keeps recording');
  await setMode('dmm');
  await until(() => dmmState().logged > n + 4, 'and back');
  assert.deepEqual([dmmState().logging, nulls()], [true, breaks], 'no break from switching views');
  stopDmmLog();
  await setMode('gen');
  const polls = sent();
  await sleep(400);
  assert.equal(sent(), polls, 'no meter polling in the generator view without logging');
  await stopLoop();
  await link.close();
  useDev.setState({ link: 'disconnected', mode: 'scope', profile: 'DS1052' });
  await freshDmm();
  checks += 3;
}

// A fake from three tables: set-commands change state, `wave` queries are computed, `cfg` are fixed.
function tableDevice(setting: Record<string, (arg: string) => void>, wave: Record<string, () => Answer>, cfg: Record<string, string>) {
  return fakePort((c) => {
    const [cmd, arg] = c.split(' ');
    setting[cmd]?.(arg);
    return wave[c]?.() ?? cfg[c] ?? (c.includes('?') ? 'NAN' : null);
  });
}

// --- scope loop: 0.21.9 reads both channels with one WAV:FRAM? (PEAK when decimated) plus the device's readouts; 0.21.7 never gets a command it doesn't know (-113)
function fakeScope(samples = 65536) { // samples < ACQ:MDEP?: a Roll record still filling
  const w = { star: 1, stop: 0, poin: 0, peak: false, seq: 0, src: 'CHAN1' };
  // Full-window reads (WAV:DATA? with WAV:POIN 0): each is logged; the knobs spoil its reply.
  const reads: { at: number; src: string; star: number; stop: number }[] = [];
  const knob = { seqSkew: 0, short: 0, rail: 128 };
  const trig = 32768; // 100 MSa/s → 1e-8 s; 20 µs/div → 20 000-sample window
  const cfg: Record<string, string> = {
    '*IDN?': IDN, 'TIM:SCAL?': '2e-5', 'ACQ:SRAT?': '1e8', 'ACQ:MDEP?': String(Math.max(samples, 65536)), 'TRIG:POS?': '50',
    'CHAN1:DISP?': '1', 'CHAN2:DISP?': '1', 'CHAN1:PROB?': '1', 'CHAN2:PROB?': '1', 'CHAN1:SCAL?': '1', 'CHAN2:SCAL?': '1',
    'CHAN1:OFFS?': '0', 'CHAN2:OFFS?': '0', 'TRIG:STAT?': 'TD', 'TRIG:SWE?': 'AUTO', 'TRIG:EDGE:SOUR?': 'CHAN1',
    'CHAN1:FCNT?': '1000.5', 'CHAN2:FCNT?': 'NAN', 'ACQ:INT:STAT?': '0,12', 'ACQ:PROG?': '0,7,0,0',
    'WAV:PRE?': `0,0,${samples},1,1e-8,${samples < 65536 ? 0 : -1e-8 * trig},0,0.01,0,128`,
    'WAV:MEAS? SCR': '1000,2,0.7,0.001,0,-1,1,0.7,50,20,NAN,1000.5,2,1,-1,0,EDGE',
  };
  const block = (payload: Uint8Array) => {
    const len = String(payload.length).padStart(9, '0');
    return Uint8Array.from([...enc.encode(`#9${len}`), ...payload, 10]);
  };
  const points = () => {
    const n = (w.stop || samples) - w.star + 1, stride = w.poin && n > w.poin ? Math.ceil(n / w.poin) : 1;
    return { n: Math.ceil(n / stride), stride, peak: w.peak && w.poin > 0 };
  };
  const data = () => {
    const p = points(), bytes = new Uint8Array(p.n * (p.peak ? 2 : 1) - (w.poin ? 0 : knob.short)).fill(128);
    if (!w.poin) { bytes[7] = knob.rail; reads.push({ at: performance.now(), src: w.src, star: w.star, stop: w.stop }); }
    return block(bytes);
  };
  const frame = () => {
    const p = points(), pre = `0,${p.peak ? 1 : 0},${p.n},1,${1e-8 * p.stride},${1e-8 * (w.star - 1 - trig)},0,0.01,0,128`;
    const shown = [1, 2].filter((n) => cfg[`CHAN${n}:DISP?`] === '1');
    if (cfg['TRIG:STAT?'] !== 'STOP') w.seq++; // a held record keeps its sequence
    const head = enc.encode(`${w.seq},${shown.length}\n${shown.map((n) => `CHAN${n},${pre}\n`).join('')}`);
    return block(Uint8Array.from([...head, ...new Uint8Array(shown.length * p.n * (p.peak ? 2 : 1)).fill(128)]));
  };
  const setting: Record<string, (arg: string) => void> = {
    'WAV:SOUR': (a) => (w.src = a), 'WAV:STAR': (a) => (w.star = +a), 'WAV:STOP': (a) => (w.stop = +a),
    'WAV:POIN': (a) => (w.poin = +a), 'WAV:POIN:MODE': (a) => (w.peak = a === 'PEAK'),
  };
  const wave: Record<string, () => Answer> = {
    'WAV:SEQ?': () => String(w.seq + (w.poin ? 0 : knob.seqSkew)), 'WAV:DATA?': data, 'WAV:FRAM?': frame,
  };
  const dev = tableDevice(setting, wave, cfg);
  return { dev, cfg, reads, knob };
}

// The firmware rule a second WAV:PRE? on a channel breaks: it releases that channel's record and
// waits only 1 s for a newer one, so with slow records the data read after it never comes.
function repeatedPre(sent: string[]): number {
  let src = 'CHAN1', bad = 0;
  const pending = new Set<string>();
  for (const c of sent) {
    if (c.startsWith('WAV:SOUR ')) src = c.slice(9);
    else if (c === 'WAV:PRE?') { if (pending.has(src)) bad++; pending.add(src); }
    else if (c === 'WAV:DATA?' || c === 'WAV:FRAM?') pending.clear();
  }
  return bad;
}

async function runScope(fw: string, fft: boolean, samples?: number) {
  const { dev } = fakeScope(samples);
  useDev.setState({ idn: { model: 'DS1052', serial: 'T', fw }, fft });
  await link.open(dev.port);
  runLoop('scope', scopeLoop);
  for (const end = performance.now() + 4000; scopeData.version < 4 && performance.now() < end;) await sleep(50);
  await stopLoop();
  await link.close();
  return dev.written;
}
{
  const sent = await runScope('0.21.9', false);
  const f = scopeData.frames;
  assert.equal(f.length, 2, 'both channels from WAV:FRAM?');
  assert.ok(sent.lastIndexOf('WAV:DATA?') < sent.indexOf('WAV:FRAM?'), 'one per-channel pass for the geometry, then WAV:FRAM? only');
  assert.equal(repeatedPre(sent), 0, 'no second WAV:PRE? on a channel before its data');
  assert.ok(sent.includes('WAV:POIN:MODE PEAK') && f[0].lo && f[1].hi, 'decimated window comes as PEAK pairs');
  assert.ok(sent.includes(`WAV:STAR ${32768 - 10000 + 1}`) && sent.includes(`WAV:STOP ${32768 + 10000}`), 'window cut around the trigger');
  assert.equal(scopeData.meas[0]?.freq, 1000, "device readouts (WAV:MEAS?) reach scopeData");
  assert.deepEqual(useDev.getState().scopeStatus.fcnt.map(String), ['1000.5', 'NaN'], 'counter per channel');
  assert.deepEqual(useDev.getState().scopeStatus.interleave, { active: false, blockers: 12 });
  assert.equal(sent.at(-1), 'WAV:SNAP', 'held frame released on stop');
  checks += 9;

  const scale = { yinc: 0.01, zero: 0, yref: 128 }, win = { first: 22768, end: 42768, interval: 1e-8 };
  assert.deepEqual(scopeData.frames.map((x) => [x.win, x.scale]), [[win, scale], [win, scale]], 'WAV:FRAM? frames say where they sit and how they scale');

  const fftSent = await runScope('0.21.9', true);
  assert.ok(fftSent.includes('WAV:POIN 1024') && fftSent.includes('WAV:POIN:MODE PEAK') && !fftSent.includes('WAV:POIN 2048'), 'FFT leaves the trace decimation alone');
  assert.ok(scopeData.frames[0].lo && scopeData.frames[1].hi, 'trace frames keep their envelope with FFT on');
  checks += 3;

  const filling = await runScope('0.21.9', false, 788);
  assert.ok(!filling.includes('WAV:FRAM?') && filling.includes('WAV:DATA?'), 'a record short of ACQ:MDEP? never sets the WAV:FRAM? geometry');
  assert.equal(repeatedPre(filling), 0, 'no second WAV:PRE? on a channel before its data (filling record)');
  checks += 2;

  const old = await runScope('0.21.7', false);
  assert.ok(scopeData.frames.length === 2 && old.includes('WAV:DATA?'), '0.21.7: per-channel reads');
  assert.ok(!old.some((c) => /FRAM|POIN:MODE|MEAS\?/.test(c)), '0.21.7 never gets 0.21.9 commands');
  assert.equal(scopeData.meas[0], null, '0.21.7: readouts computed in the browser');
  assert.deepEqual(scopeData.frames[0].win, { first: 22768, end: 42768, interval: 1e-8 }, 'per-channel frames say where they sit');
  assert.deepEqual(scopeData.frames[0].scale, { yinc: 0.01, zero: 0, yref: 128 });
  checks += 5;

  // WAV:STAR/STOP/POIN/POIN:MODE are session variables, each a device pass while capture is paused:
  // stated once per channel on the geometry pass, then FRAM? alone while the window holds.
  const frames = sent.filter((c) => c === 'WAV:FRAM?').length, poin = sent.filter((c) => c === 'WAV:POIN 1024').length;
  assert.ok(frames >= 3 && poin <= 2, `${frames} WAV:FRAM?, ${poin} WAV:POIN 1024`);
  checks++;
}

// --- settings follow the device keys: every 500 ms while they work; under SYST:REM (keys locked) only
// the status is polled, until Remote ends on the device (MENU hold) and the settings are caught up at once
async function scopeReads(cfg: Record<string, string>, ms: number, change?: (c: Record<string, string>) => void) {
  const s = fakeScope();
  Object.assign(s.cfg, cfg);
  useDev.setState({ idn: { model: 'DS1052', serial: 'T', fw: '0.21.9' }, fft: false, remote: false });
  await link.open(s.dev.port);
  runLoop('scope', scopeLoop);
  await sleep(ms);
  const count = (q: string) => s.dev.written.filter((c) => c === q).length;
  const before = { settings: count('CHAN1:SCAL?'), status: count('TRIG:STAT?') };
  change?.(s.cfg);
  return { before, stop: async () => { await stopLoop(); await link.close(); } };
}
{
  const open = await scopeReads({ 'SYST:REM?': '0' }, 2200, (c) => (c['CHAN1:SCAL?'] = '2'));
  assert.ok(open.before.settings >= 3, `keys working: ${open.before.settings} settings reads in 2.2 s`);
  await until(() => useDev.getState().scope.ch[0].vdivMv === 2000, 'a V/div turned on the device keys reaches the app', 1500);
  await open.stop();

  const locked = await scopeReads({ 'SYST:REM?': '1' }, 2200, (c) => { c['SYST:REM?'] = '0'; c['CHAN1:SCAL?'] = '0.5'; });
  assert.equal(useDev.getState().remote, true, 'Remote seen in the status poll');
  assert.equal(locked.before.settings, 1, `locked: ${locked.before.settings} settings reads in 2.2 s, want only the first`);
  assert.ok(locked.before.status >= 3, `locked: status still polled (${locked.before.status})`);
  await until(() => useDev.getState().scope.ch[0].vdivMv === 500 && !useDev.getState().remote, 'Remote ended on the device: settings caught up', 1500);
  await locked.stop();
  checks += 4;
}

// --- FFT data: every sample of the screen window, a second read at most every 500 ms ---------
type Fake = ReturnType<typeof fakeScope>;
type Setup = { fft: boolean; fw?: string; samples?: number; cfg?: Record<string, string> };
async function withScope({ fft, fw = '0.21.9', samples, cfg }: Setup, body: (s: Fake) => Promise<void>) {
  const s = fakeScope(samples);
  Object.assign(s.cfg, cfg);
  useDev.setState({ idn: { model: 'DS1052', serial: 'T', fw }, fft, fftSrc: 0 });
  await link.open(s.dev.port);
  runLoop('scope', scopeLoop);
  try {
    await body(s);
  } finally {
    await stopLoop();
    await link.close();
  }
  assert.equal(repeatedPre(s.dev.written), 0, 'no second WAV:PRE? on a channel before its data (FFT runs)');
  checks++;
}
async function until(cond: () => boolean, what: string, ms = 2000) {
  for (const end = performance.now() + ms; !cond() && performance.now() < end;) await sleep(10);
  assert.ok(cond(), what);
  checks++;
}
const minGap = (reads: Fake['reads']) => Math.min(...reads.slice(1).map((r, i) => r.at - reads[i].at));
const MIN_GAP = 450; // 500 ms, less the fake port's jitter on a loaded CI runner (without the limit: ~15 ms)

await withScope({ fft: false }, async (s) => {
  await sleep(1600);
  assert.deepEqual([s.reads.length, scopeData.fft], [0, null], 'FFT off: no full-window read');
  checks++;
});

scopeData.fft = { ch: 0, seq: 1, xinc: 1, xorig: 0, volts: new Float32Array(1) };
await withScope({ fft: true }, async (s) => {
  assert.equal(scopeData.fft, null, 'a new loop forgets the previous spectrum data');
  await sleep(1600);
  const f = scopeData.fft!;
  assert.ok(f, 'spectrum data arrives');
  assert.ok(s.reads.length >= 3 && minGap(s.reads) >= MIN_GAP, `${s.reads.length} reads, closest ${minGap(s.reads)} ms apart`);
  assert.ok(scopeData.version > 2 * s.reads.length, 'trace frames keep coming between the reads');
  assert.deepEqual([f.ch, f.volts.length, f.screen, f.xinc, f.clipped, f.lo, f.volts[0]], [0, 20000, 20000, 1e-8, false, undefined, 0]);
  assert.ok(Math.abs(f.xorig + 1e-4) < 1e-12, `window starts 10 000 samples before the trigger: ${f.xorig}`);
  assert.ok(s.dev.written.join('|').includes('WAV:POIN 0|WAV:DATA?|WAV:SEQ?'), 'one batch, no preamble');
  let full = false, stale = 0;
  for (const c of s.dev.written) {
    if (c === 'WAV:POIN 0') full = true;
    if (c === 'WAV:POIN 1024') full = false;
    if (c === 'WAV:FRAM?' && full) stale++;
  }
  assert.equal(stale, 0, 'a trace frame after a full-window read states its WAV:POIN again');
  checks += 8;
});

await withScope({ fft: true }, async (s) => {
  await until(() => !!scopeData.fft, 'first read');
  const good = scopeData.fft;
  s.knob.seqSkew = 1; // another record answered
  await sleep(600);
  s.knob.seqSkew = 0;
  s.knob.short = 1; // another length
  await sleep(600);
  assert.equal(scopeData.fft, good, 'a wrong sequence or length is discarded');
  assert.ok(s.reads.length >= 3 && minGap(s.reads) >= MIN_GAP, `discarded reads are not retried early: ${minGap(s.reads)} ms`);
  checks += 2;
  s.knob.short = 0;
  const n = s.reads.length;
  await until(() => s.reads.length > n, 'the next regular read');
  useDev.setState({ fftSrc: 1 });
  await until(() => scopeData.fft?.ch === 1, 'a source change reads at once', 300);
  assert.equal(s.reads.at(-1)!.src, 'CHAN2');
  checks++;
  useDev.setState({ fft: false });
  await until(() => scopeData.fft === null, 'FFT off drops the data');
});

await withScope({ fft: true, cfg: { 'TRIG:STAT?': 'STOP' } }, async (s) => {
  await sleep(1600);
  assert.equal(s.reads.length, 1, 'stopped and unchanged: not read again');
  checks++;
  s.cfg['TIM:SCAL?'] = '1e-5';
  await until(() => scopeData.fft?.volts.length === 10_000, 'stopped, but the window changed: read again');
});

await withScope({ fft: true, samples: 524_288, cfg: { 'TIM:SCAL?': '1e-3' } }, async (s) => {
  await until(() => !!scopeData.fft, 'long window read');
  assert.deepEqual([s.reads[0].star, s.reads[0].stop], [229_377, 294_912], 'the middle 65 536 samples');
  assert.deepEqual([scopeData.fft!.volts.length, scopeData.fft!.screen], [65_536, 524_288]);
  checks += 2;
});

for (const rail of [0, 255]) {
  await withScope({ fft: true }, async (s) => {
    s.knob.rail = rail;
    await until(() => scopeData.fft?.clipped === true, `a byte at ${rail} marks the window clipped`);
  });
}

await withScope({ fft: true, cfg: { 'CHAN1:DISP?': '0' } }, async () => {
  await until(() => scopeData.fft?.ch === 1, 'source off: the other channel');
});

await withScope({ fft: true, fw: '0.21.7' }, async (s) => {
  await until(() => scopeData.fft?.volts.length === 20_000, '0.21.7 reads the full window too');
  assert.ok(!s.dev.written.some((c) => /FRAM|POIN:MODE|MEAS\?/.test(c)), '0.21.7 never gets 0.21.9 commands, FFT on');
  checks++;
});

// --- Single, then waiting for a trigger (no frames, so no full settings read): the loop still
// learns the device is in Single, and Run restores Auto first instead of re-arming another single
{
  let swe = 'AUTO'; // the device's sweep: Single is pressed once the loop is running
  const dev = fakePort((c) => ({ '*IDN?': IDN, 'TRIG:STAT?': 'WAIT', 'TRIG:SWE?': swe, 'ACQ:PROG?': '1,9,100,0', 'CHAN1:DISP?': '1', 'SYST:ERR?': '0,"No error"' })[c] ?? (c.includes('?') ? 'NAN' : null));
  useDev.setState({ idn: { model: 'DS1052', serial: 'T', fw: '0.21.9' }, fft: false });
  useDev.getState().patch('scope', { sweep: 'AUTO' });
  useDev.setState({ scopeStatus: { ...useDev.getState().scopeStatus, lastSweep: 'AUTO' } });
  await link.open(dev.port);
  runLoop('scope', scopeLoop);
  await sleep(1500); // past the loop's first full settings read
  swe = 'SING';
  for (const end = performance.now() + 5000; useDev.getState().scope.sweep !== 'SING' && performance.now() < end;) await sleep(50);
  await stopLoop();
  assert.equal(useDev.getState().scope.sweep, 'SING', 'sweep read while waiting');
  assert.equal(useDev.getState().scopeStatus.stat, 'WAIT');
  const from = dev.written.length;
  await scopeRun();
  await link.close();
  const sent = dev.written.slice(from);
  assert.ok(sent.indexOf('TRIG:SWE AUTO') >= 0 && sent.indexOf('TRIG:SWE AUTO') < sent.indexOf('RUN'), `Run after Single: ${sent.join(' | ')}`);
  checks += 3;
}

// --- a slider drag while each batch waits (behind a frame read): one batch in flight, the last value
// sent last, instead of one queued batch per 60 ms, each restarting the device's capture
{
  const dev = fakePort((c) => (c === 'SYST:ERR?' ? { after: 300, reply: '0,"No error"' } : c.includes('?') ? 'NAN' : null));
  useDev.setState({ idn: { model: 'DS1052', serial: 'T', fw: '0.21.9' }, model: 'ZT703S' });
  await link.open(dev.port);
  remote('scope', {}, true); // what the device has: the diff base
  useDev.setState({ link: 'connected' });
  for (let k = 1; k <= 30; k++) {
    useDev.getState().patch('scope', { trig: { ...useDev.getState().scope.trig, level: k / 100 } });
    await sleep(20);
  }
  await sleep(1200);
  const lev = dev.written.filter((c) => c.startsWith('TRIG:EDGE:LEV'));
  assert.ok(lev.length <= 4, `${lev.length} level batches for a 0.6 s drag`);
  assert.equal(lev.at(-1), 'TRIG:EDGE:LEV 0.3', 'the final value is sent');
  checks += 2;

  const s0 = useDev.getState().scope;
  remote('scope', { ...s0, trig: { ...s0.trig } }, true);
  assert.equal(useDev.getState().scope, s0, 'an unchanged readback keeps the slice (no re-render)');
  checks++;
  useDev.setState({ link: 'disconnected' });

  // *OPC? waits for the ZT706S module's acknowledge; the ZT703S's own DAC needs no extra round trip.
  for (const model of ['ZT706S', 'ZT703S'] as const) {
    useDev.setState({ model });
    const from = dev.written.length;
    await ctl(['SOUR:FREQ 100']);
    assert.equal(dev.written.slice(from).includes('*OPC?'), model === 'ZT706S', `${model}: *OPC? after a generator command`);
  }
  checks += 2;
  await link.close();
}

// --- Bode sweep: whole records from a fresh acquisition, slow records waited for, generator stop ---
// The generator plays 0.1 % above the request; CH2 = CH1 at −6 dB, −45°. Each CH1 WAV:PRE? is a newer
// record (the firmware's repeated PRE?), CH2's reads the same one. `nanAt`: the first two PRE? after that
// frequency set answer NAN; `stuckAt`: all of them; `outOffAt`: that OUTP? query reads 0; `amp`: volts
// peak per channel; `saved`: the V/div CHAN1:SCAL? reports before the sweep.
function fakeBode() {
  const st = { freq: 1000, tb: 1e-3, vd: [1, 1], amp: [1, 0.5], saved: '1', src: 1, seq: 0, nan: 0, nanAt: 0, stuckAt: 0, outOffAt: 0, outQ: 0, freqSets: 0, star: [] as string[] };
  const xinc = () => (20 * st.tb) / 65536;
  const cfg: Record<string, string> = {
    '*IDN?': 'OpenOSC,DS1052,T,0.21.14', '*OPC?': '1', 'SYST:ERR?': '0,"No error"', 'TIM:SCAL?': '0.001', 'TIM:OFFS?': '0',
    'TRIG:SWE?': 'AUTO', 'TRIG:STAT?': 'TD', 'TRIG:EDGE:SOUR?': 'CHAN1', 'CHAN1:DISP?': '1', 'CHAN2:DISP?': '0',
    'CHAN2:SCAL?': '2', 'CHAN1:OFFS?': '0', 'CHAN2:OFFS?': '0', 'CHAN1:PROB?': '1', 'CHAN2:PROB?': '1',
    'CHAN1:COUP?': 'DC', 'CHAN2:COUP?': 'DC', 'ACQ:ROLL?': '1', 'ACQ:MDEP?': '2.58048e+5',
  };
  const data = () => {
    const f = st.freq * 1.001, ch = st.src, yinc = st.vd[ch - 1] / 25, amp = st.amp[ch - 1], ph = ch === 1 ? 0 : -Math.PI / 4;
    const b = Uint8Array.from({ length: 65536 }, (_, i) => Math.max(0, Math.min(255, 128 + Math.round((amp * Math.cos(2 * Math.PI * f * i * xinc() + ph)) / yinc))));
    return Uint8Array.from([...enc.encode('#565536'), ...b, 10]);
  };
  const setting: Record<string, (arg: string) => void> = {
    'SOUR:FREQ': (a) => { st.freq = +a; if (++st.freqSets === st.nanAt) st.nan = 2; },
    'TIM:SCAL': (a) => (st.tb = +a), 'CHAN1:SCAL': (a) => (st.vd[0] = +a), 'CHAN2:SCAL': (a) => (st.vd[1] = +a),
    'WAV:SOUR': (a) => (st.src = +a.slice(4)), 'WAV:STAR': (a) => st.star.push(a),
  };
  const pre = () => {
    if (st.freqSets === st.stuckAt || st.nan-- > 0) return 'NAN';
    if (st.src === 1) st.seq++;
    return `0,0,65536,1,${xinc()},0,0,${st.vd[st.src - 1] / 25},0,128`;
  };
  const wave: Record<string, () => Answer> = {
    'CHAN1:SCAL?': () => st.saved, 'WAV:PRE?': pre, 'WAV:SEQ?': () => String(st.seq), 'WAV:DATA?': data, 'OUTP?': () => (++st.outQ === st.outOffAt ? '0' : '1'),
  };
  const dev = tableDevice(setting, wave, cfg);
  return { dev, st };
}
const near = (got: number, want: number, tol: number, what: string) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} ± ${tol}`);
async function runBode(setup: (st: ReturnType<typeof fakeBode>['st']) => void, storeTb = 15) {
  const { dev, st } = fakeBode();
  setup(st);
  useDev.setState({ idn: { model: 'DS1052', serial: 'T', fw: '0.21.14' }, model: 'ZT703S', profile: 'DS1052', error: null });
  useDev.getState().patch('scope', { tb: storeTb });
  useDev.getState().patch('bode', { start: 1000, stop: 10_000, ppd: 2 }); // 1 k, 3.16 k, 10 k
  const ats: (number | null)[] = []; // every frequency the view was told is being measured
  const unsub = useDev.subscribe((s, prev) => void (s.bode.at !== prev.bode.at && ats.push(s.bode.at)));
  await link.open(dev.port);
  await bodeSweep();
  await link.close();
  unsub();
  return { sent: dev.written, st, ats, points: useDev.getState().bode.points, error: useDev.getState().error };
}
{
  const r = await runBode((st) => (st.nanAt = 2)); // the 2nd point's first two PRE? answer NAN
  assert.equal(r.points.length, 3, `points: ${JSON.stringify(r.points)} ${r.error}`);
  for (const p of r.points) {
    near(p.db, -6.02, 0.1, 'Bode gain');
    near(p.ph, -45, 0.5, 'Bode phase');
  }
  [1000, 10 ** 3.5, 10_000].forEach((f, i) => near(r.points[i].f, f * 1.001, f * 1e-4, 'Bode point at the played frequency'));
  assert.ok(r.st.star.every((a) => a === '1'), `whole records only: WAV:STAR ${r.st.star.join(',')}`);
  assert.ok(r.sent.includes('CHAN2:SCAL 0.5'), 'CH2 (0.5 V on 1 V/div after starting from CH1\'s V/div) ranged down');
  const tail = r.sent.slice(r.sent.lastIndexOf('WAV:DATA?'));
  for (const c of ['ACQ:ROLL ON', 'ACQ:MDEP 262144', 'CHAN1:COUP DC', 'CHAN2:DISP OFF', 'CHAN2:SCAL 2']) assert.ok(tail.includes(c), `restored ${c}`);
  const sweep = r.sent.slice(0, r.sent.lastIndexOf('WAV:SNAP')); // before the restore
  assert.equal(sweep.filter((c) => c === 'TIM:OFFS 0').length, 1, 'TIM:OFFS once, at setup');
  assert.ok(!sweep.includes('*OPC?'), 'ZT703S: no *OPC? per point');
  assert.equal(r.ats.at(-1), null, 'no point being measured after the sweep');
  [1000, 10 ** 3.5, 10_000].forEach((f, i) => near(r.ats[i] ?? NaN, f, 1e-6, 'point being measured, in plan order'));
  checks += 7;

  const fast = await runBode((st) => (st.nanAt = 2), 6); // Scope screen last at 1 µs/div
  assert.deepEqual(fast.points, r.points, 'the Scope screen\'s timebase changes nothing');
  checks++;
}
{
  const r = await runBode((st) => (st.stuckAt = 3)); // SOUR:FREQ #1 is the setup, #3 the 2nd point
  assert.equal(r.points.length, 2, 'a point with no record before its deadline is skipped');
  assert.match(r.error ?? '', /1 point\(s\) skipped/);
  assert.equal(useDev.getState().bode.running, false);
  checks += 3;
}
{
  const r = await runBode((st) => (st.outOffAt = 3));
  assert.equal(r.points.length, 2, 'the point measured with the output off is dropped, earlier ones stay');
  assert.match(r.error ?? '', /generator output turned off/);
  assert.ok(r.sent.lastIndexOf('ACQ:MDEP 262144') > r.sent.lastIndexOf('WAV:DATA?'), 'restore still sent');
  assert.equal(r.ats.at(-1), null, 'generator stop: no point being measured');
  near(r.ats.at(-2) ?? NaN, 10_000, 1e-6, 'generator stop: the point with the output off was the last measured');
  checks += 5;
}

{
  // A silent channel jumps down; clipping climbs one step per record, and the longest climb (20 mV → 10 V,
  // 10 steps + the measurement) must not use up the first point.
  const silent = await runBode((st) => (st.amp[1] = 0.001)); // grounded or deep-stopband CH2: 1 V → 20 mV/div
  assert.equal(silent.points.length, 3, `silent CH2: ${silent.points.length} points, ${silent.error}`);
  const climb = await runBode((st) => { st.saved = '0.02'; st.amp = [30, 15]; }); // Scope left at 20 mV/div, 60 Vpp input
  assert.equal(climb.points.length, 3, `starting at 20 mV/div: ${climb.points.length} points, ${climb.error}`);
  checks += 2;
}

{
  // Stop while a point waits for a record that never comes: the wait ends at once, nothing counts as skipped.
  const t0 = performance.now();
  setTimeout(() => bodeStop(), 300);
  const r = await runBode((st) => (st.stuckAt = 2));
  assert.ok(performance.now() - t0 < 1500, `stop took ${Math.round(performance.now() - t0)} ms`);
  assert.equal(r.error, null, 'a stopped point is not reported as skipped');
  assert.ok(r.sent.includes('ACQ:MDEP 262144'), 'restore sent after stop');
  assert.equal(r.ats.at(-1), null, 'stop: no point being measured');
  checks += 4;
}

console.log(`check-link: ${checks} checks passed`);
