// Self-check for src/link.ts and the DMM loop against a fake one-command-at-a-time device.
// Run: `npm run check`. Covers reply framing, the late-reply resync, tx atomicity, and a poll
// loop surviving a timeout (each of these broke or was missing before 0.5.0).
import assert from 'node:assert/strict';
import { Link, sleep } from '../src/link.ts';
import { link, runLoop, stopLoop } from '../src/io/core.ts';
import { dmmLogCsv, dmmLoop, flushDmm } from '../src/io/dmm.ts';
import { scopeData, scopeLoop, scopeRun } from '../src/io/scope.ts';
import { useDev } from '../src/store.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const IDN = 'OpenOSC,DS1052,TEST0001,0.21.7';
type Answer = string | Uint8Array | { after: number; reply: string } | null;

// Answers each line in order and only after the previous answer, like the firmware.
function fakePort(answer: (cmd: string) => Answer) {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let busy = Promise.resolve();
  let pending = '';
  const written: string[] = [];
  const emit = (b: Uint8Array) => { try { out.enqueue(b); } catch { /* port closed */ } };
  const port = {
    readable: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        pending += dec.decode(chunk);
        for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) {
          const cmd = pending.slice(0, i);
          pending = pending.slice(i + 1);
          written.push(cmd);
          busy = busy.then(async () => {
            await sleep(0); // a real port's reads are tasks: a loop that never sleeps must not starve timers
            const a = answer(cmd);
            if (a === null) return;
            if (a instanceof Uint8Array) emit(a);
            else if (typeof a === 'string') emit(enc.encode(a + '\n'));
            else { await sleep(a.after); emit(enc.encode(a.reply + '\n')); }
          });
        }
      },
    }),
    open: async () => {},
    close: async () => {},
    getInfo: () => ({}),
  };
  return { port: port as unknown as SerialPort, written };
}

let checks = 0;

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
    'FUNC?': '"VOLT"', 'SYST:DMM:RANG:LIST?': '3,2.5,25,250', 'AUTO?': '1', 'SYST:DMM:HOLD?': '0',
    'SYST:DMM:REL?': '0', 'SYST:DMM:HOLD:MODE?': 'MAN', '*IDN?': IDN, 'SYST:ERR?': '0,"No error"',
    'SYST:DMM:TEMP:CJUN?': '22.5',
  };
  const dev = fakePort((c) => {
    if (c === 'FUNC2 FREQ') func2 = true;
    return c === 'SYST:DMM:RES?' ? (seq === 2 ? { after: 3500, reply: res() } : res()) : cfg[c] ?? null;
  });
  useDev.setState({ logging: true });
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
  assert.match(csv[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z,DC Voltage,1\.234,V$/);
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
      'SYST:DMM:HOLD:MODE?': 'MAN', 'SYST:DMM:TEMP:CJUN?': 'NAN', 'SYST:ERR?': err, '*IDN?': IDN,
    };
    return cfg[c] ?? null;
  });
  await link.open(dev.port);
  const v = { ...useDev.getState().dmm, func: 'VDC' as const, cj: null };
  await flushDmm({ ...v, cj: 21 }, { ...v, func: 'TEMP', cj: 21 });
  assert.equal(useDev.getState().junctionNeeded, false, 'with a manual junction stored, -221 is not about the junction');
  useDev.setState({ hist: { t: [1, 2], v: [1.5, 1.6] } });
  await flushDmm(v, { ...v, func: 'TEMP' });
  assert.equal(useDev.getState().junctionNeeded, true, 'refused CONF:TEMP asks for a junction');
  assert.equal(useDev.getState().hist.v.length, 2, 'a refused CONF keeps the current trend');
  func = '"RES"'; // the user turns the meter's own keys
  await flushDmm(v, { ...v, func: 'RES' });
  assert.equal(useDev.getState().junctionNeeded, false, 'any other function change clears it');
  await link.close();
  checks += 4;
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
  const dev = fakePort((c) => {
    const [cmd, arg] = c.split(' ');
    setting[cmd]?.(arg);
    return wave[c]?.() ?? cfg[c] ?? (c.includes('?') ? 'NAN' : null);
  });
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
  assert.ok(s.dev.written.join('|').includes('WAV:SOUR CHAN1|WAV:STAR 22769|WAV:STOP 42768|WAV:POIN 0|WAV:DATA?|WAV:SEQ?'), 'one batch, no preamble');
  checks += 7;
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

console.log(`check-link: ${checks} checks passed`);
