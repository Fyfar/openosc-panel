// Device I/O entry point for the views: connection + profile-switch state machine, the store →
// SCPI sync subscription, and system commands. Instruments live in ./dmm ./scope ./gen ./bode,
// shared plumbing (link, ctl, remote, loop control) in ./core. Timings measured on a real ZT703S
// are cited inline.
import { PROFILE_OF, type Mode, type Profile } from '../device';
import { matches, sleep, VID } from '../link';
import { useDev, type State } from '../store';
import { applying, ctl, current, errText, fail, get, type Key, lastSent, link, localAt, now, on, runLoop, set, stopLoop } from './core';
import { dmmLoop, flushDmm, stopDmmLog } from './dmm';
import { flushGen, readGen } from './gen';
import { flushScope, forgetWav, scopeLoop } from './scope';

export { download } from './core';
export { atLimit, clearDmmData, dmmRec, exportDmmLog, liveTrig, logMatches, setTrig, startDmmLog, stopDmmLog } from './dmm';
export { discardSaved, restoreSaved } from './saved';
export { exportScopeCsv, scopeAuto, scopeData, scopeForce, scopeRun, scopeSingle, scopeStop } from './scope';
export { bodeStop, bodeSweep } from './bode';

// ---------------------------------------------------------------- sync: store edits → SCPI
const timers: Partial<Record<Key, ReturnType<typeof setTimeout>>> = {};
const FLUSH: { [K in Key]: (a: State[K], b: State[K]) => Promise<void> } = { scope: flushScope, dmm: flushDmm, gen: flushGen };

useDev.subscribe((s, prev) => {
  if (applying || s.link !== 'connected') return;
  for (const k of ['scope', 'dmm', 'gen'] as const) {
    if (s[k] === prev[k]) continue;
    localAt[k] = now();
    timers[k] ??= setTimeout(() => void flush(k), 60); // coalesce slider drags
  }
});

// Diffs against what was last sent (read at flush time, so edits within 60 ms collapse). One flush per
// slice at a time: edits made while it waits behind a frame read go out together afterwards, rather than
// one queued batch per 60 ms, each restarting the device's capture.
const flushing: Partial<Record<Key, boolean>> = {};
const again: Partial<Record<Key, boolean>> = {};
async function flush<K extends Key>(k: K) {
  timers[k] = undefined;
  if (flushing[k]) { again[k] = true; return; }
  flushing[k] = true;
  try {
    do {
      again[k] = false;
      const cur = get()[k];
      const prev = (lastSent[k] ?? cur) as State[K];
      lastSent[k] = cur as never;
      await FLUSH[k](prev, cur);
    } while (again[k]);
  } finally {
    flushing[k] = false;
  }
}

// Nothing reads the meter once the link leaves 'connected' (profile switch, disconnect, lost cable):
// a log stops there and keeps its data.
useDev.subscribe((s, prev) => { if (prev.link === 'connected' && s.link !== 'connected') stopDmmLog(); });

// ---------------------------------------------------------------- connection + profile switch
let switching = false;
let expectClose = false;
let skipGranted = false;

async function openPort(port: SerialPort) {
  link.onClose = null;
  await link.open(port);
  const idn = await link.identify();
  if (!idn) { await link.close(); throw new Error('No OpenOSC reply to *IDN?'); }
  link.onClose = onLinkClosed;
  const [, model, serial, fw] = idn.split(',');
  // *IDN? names only the emulated instrument. SOUR:VOLT (module amplitude) exists on the ZT706S
  // only; the ZT703S answers -241 "Hardware missing". Generator commands work in both profiles.
  const [, err] = await link.texts(['*CLS', 'SOUR:VOLT?', 'SYST:ERR?']).catch(() => ['', '-241']); // one reply per query
  set({ idn: { model, serial, fw }, model: err.startsWith('-241') ? 'ZT703S' : 'ZT706S', profile: model === 'XDM1041' ? 'XDM1041' : 'DS1052' });
}

function onLinkClosed() {
  if (switching) return;
  void stopLoop();
  set({ link: 'disconnected' });
  if (!expectClose) fail('Device disconnected (cable, hub or reboot).');
  expectClose = false;
}

// A remembered port that opens but stays silent takes ~15 s to give up on. By then the click's
// user activation (~5 s) is gone and requestPort() would throw, so ask for a second click.
async function pickPort() {
  const granted = skipGranted ? undefined : (await navigator.serial!.getPorts()).find(matches);
  if (granted) {
    try { await openPort(granted); return; } catch (e) {
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        skipGranted = true;
        throw new Error(`the remembered port did not answer (${errText(e)}). Click Connect again to pick a port`, { cause: e });
      }
    }
  }
  await openPort(await navigator.serial!.requestPort({ filters: [{ usbVendorId: VID }] }));
}

export async function connect() {
  if (!navigator.serial) return fail('Web Serial is not available in this browser. Use Chrome, Edge or Firefox 151+.');
  set({ link: 'connecting', error: null });
  try {
    await pickPort();
    skipGranted = false;
    const remoteOn = on(await link.q('SYST:REM?').catch(() => '0'));
    const { profile, mode } = get();
    const fits = PROFILE_OF[mode] === null || PROFILE_OF[mode] === profile;
    set({ remote: remoteOn, link: 'connected', mode: fits ? mode : profile === 'XDM1041' ? 'dmm' : 'scope' });
    await readGen(true);
    startLoop();
  } catch (e) {
    set({ link: 'disconnected' });
    const m = errText(e);
    if (/No port selected/i.test(m)) return;
    fail(skipGranted ? `Connect failed: ${m}.` : `Connect failed: ${m}. On Linux add yourself to the dialout group; check Settings → Files & USB on the device.`);
  }
}

export async function disconnect() {
  await stopLoop();
  expectClose = true;
  await link.close();
  set({ link: 'disconnected' });
}

async function switchProfile(want: Profile) {
  switching = true;
  set({ link: 'switching' });
  const old = link.port;
  try {
    // The reply is lost: the port drops ~0.12 s later and returns as a new SerialPort ~0.6 s after.
    await link.run([`SYST:MODE ${want === 'DS1052' ? 'SCOPe' : 'DMM'}`]);
    for (const end = now() + 5000; !link.closed && now() < end;) await sleep(10);
    await link.close();
    let p: SerialPort | undefined;
    for (const end = now() + 10000; !p && now() < end;) {
      p = (await navigator.serial!.getPorts()).find((x) => x !== old && matches(x));
      if (!p) await sleep(30);
    }
    if (!p) throw new Error('device did not come back after the mode switch');
    for (const end = now() + 10000; ;) {
      try { await openPort(p); break; } catch (e) { if (now() > end) throw e; await sleep(50); }
    }
    set({ link: 'connected' });
  } catch (e) {
    set({ link: 'disconnected' });
    fail(`Mode switch failed: ${errText(e)}. Reconnect.`);
  } finally {
    switching = false;
  }
}

export async function setMode(m: Mode) {
  if (get().link === 'switching' || get().bode.running) return;
  set({ mode: m });
  const id = await stopLoop(); // the scope loop releases its held frame on exit
  if (get().link !== 'connected' || !current(id)) return;
  const want = PROFILE_OF[m];
  if (want && want !== get().profile) await switchProfile(want);
  if (current(id) && get().link === 'connected') {
    if (m === 'gen') await readGen(true);
    startLoop();
  }
}

// One loop at a time, chosen by mode + profile; the generator view runs one only for a DMM log or an
// armed trigger (it keeps the meter profile if opened from it), the Bode view none.
function startLoop() {
  const { mode, profile, logging, armed } = get();
  if ((mode === 'dmm' || (mode === 'gen' && (logging || armed))) && profile === 'XDM1041') runLoop('dmm', dmmLoop);
  else if (mode === 'scope' && profile === 'DS1052') runLoop('scope', scopeLoop);
  else set({ stats: `CDC · ${profile} profile · idle` });
}

// ---------------------------------------------------------------- system
export async function setRemote(v: boolean) {
  if (!(await ctl([`SYST:REM ${v ? 'ON' : 'OFF'}`]))) return;
  const r = await link.q('SYST:REM?').catch(() => null);
  if (r !== null) set({ remote: on(r) });
}

export async function screenshot(): Promise<Blob | null> {
  try {
    const [r] = await link.run(['DISP:DATA?'], 10000);
    if (!r.bin) { fail(`Screenshot: ${r.text}`); return null; }
    return new Blob([r.bin as BlobPart], { type: 'image/bmp' });
  } catch (e) {
    fail(`Screenshot failed: ${errText(e)}`);
    return null;
  }
}

const clog = (...l: string[]) => set({ consoleLog: [...get().consoleLog, ...l].slice(-500) });

export async function consoleSend(cmd: string) {
  clog(`> ${cmd}`);
  // It may move WAV:SOUR/STAR/STOP/POIN under the frame reads: forgotten before the next batch runs.
  const run = (lines: string[], timeout?: number) => link.tx(async (r) => {
    try { return await r(lines, timeout); } finally { forgetWav(); }
  });
  try {
    if (cmd.includes('?')) {
      const [r] = await run([cmd], 10000);
      clog(r.text ?? `<${r.bin!.length}-byte block>`);
    } else {
      const [e] = await run([cmd, 'SYST:ERR?']);
      if (!e.text?.startsWith('0,')) clog(e.text ?? '');
    }
  } catch (e) {
    clog(`<${errText(e)}>`);
  }
}

export async function deviceInfo() {
  set({ console: true });
  for (const c of ['*IDN?', 'SYST:MODE?', 'SYST:REM?', 'SYST:CLOC:MODE?', 'SYST:PERF?', 'SYST:MEM?', 'SYST:CAL:FACT?', 'SYST:ERR?']) await consoleSend(c);
}

export async function rebootToRecovery() {
  if (!confirm('Reboot the device into Recovery (USB drive for files and firmware)? The connection will close.')) return;
  await stopLoop();
  expectClose = true;
  await link.run(['SYST:REC']).catch(() => {});
}
