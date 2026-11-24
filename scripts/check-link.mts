// Self-check for src/link.ts and the DMM loop against a fake one-command-at-a-time device.
// Run: `npm run check`. Covers reply framing, the late-reply resync, tx atomicity, and a poll
// loop surviving a timeout (each of these broke or was missing before 0.5.0).
import assert from 'node:assert/strict';
import { Link, sleep } from '../src/link.ts';
import { link, runLoop, stopLoop } from '../src/io/core.ts';
import { dmmLogCsv, dmmLoop } from '../src/io/dmm.ts';
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

// --- the DMM loop keeps polling after a query times out (it used to die silently) --------
{
  let seq = 0;
  const res = () => `1,1.234,0,0,0,1,1,0,0,${++seq},0`;
  const cfg: Record<string, string> = {
    'FUNC?': '"VOLT"', 'SYST:DMM:RANG:LIST?': '3,2.5,25,250', 'AUTO?': '1', 'SYST:DMM:HOLD?': '0',
    'SYST:DMM:REL?': '0', 'SYST:DMM:HOLD:MODE?': 'MAN', '*IDN?': IDN,
  };
  const dev = fakePort((c) => (c === 'SYST:DMM:RES?' ? (seq === 2 ? { after: 3500, reply: res() } : res()) : cfg[c] ?? null));
  useDev.setState({ logging: true });
  await link.open(dev.port);
  runLoop('dmm', dmmLoop);
  for (const end = performance.now() + 9000; (useDev.getState().reading?.seq ?? 0) < 6 && performance.now() < end;) await sleep(100);
  await stopLoop();
  await link.close();
  assert.ok((useDev.getState().reading?.seq ?? 0) >= 6, `loop stopped at seq ${useDev.getState().reading?.seq}`);
  checks++;

  const csv = dmmLogCsv().trim().split('\n');
  assert.equal(csv[0], 'time,function,value,unit');
  assert.match(csv[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z,DC Voltage,1\.234,V$/);
  checks++;
}

console.log(`check-link: ${checks} checks passed`);
