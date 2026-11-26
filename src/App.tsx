import { clsx } from 'clsx';
import {
  Activity, AudioWaveform, Camera, ChartSpline, Download, Gauge, Info, Loader2, Lock, LockOpen, LogOut,
  MoreVertical, RefreshCw, RotateCcw, ShieldAlert, SquareTerminal, TriangleAlert, Usb, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { fmtHz, SHAPES, SWITCH_MS, type Mode } from './device';
import * as io from './io';
import { unsavedData, useDev } from './store';
import { Btn } from './ui';
import version from '../VERSION?raw';
import { Dmm } from './views/Dmm';
import { Scope } from './views/Scope';
import { Generator } from './views/Generator';
import { Bode } from './views/Bode';

const TABS: { id: Mode; label: string; icon: React.ReactNode }[] = [
  { id: 'dmm', label: 'Multimeter', icon: <Gauge size={15} /> },
  { id: 'scope', label: 'Oscilloscope', icon: <Activity size={15} /> },
  { id: 'gen', label: 'Generator', icon: <AudioWaveform size={15} /> },
  { id: 'bode', label: 'Bode', icon: <ChartSpline size={15} /> },
];

export function App() {
  const link = useDev((s) => s.link);
  const mode = useDev((s) => s.mode);
  const shot = useDev((s) => s.shot);
  const consoleOpen = useDev((s) => s.console);

  if (link === 'disconnected' || link === 'connecting') return <><ConnectScreen /><ErrorToast /><UpdateToast /></>;

  return (
    <div className="flex h-dvh flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1 overflow-auto p-4">
          {mode === 'dmm' && <Dmm />}
          {mode === 'scope' && <Scope />}
          {mode === 'gen' && <Generator />}
          {mode === 'bode' && <Bode />}
          {link === 'switching' && <SwitchingOverlay />}
        </main>
        {consoleOpen && <Console />}
      </div>
      <StatusBar />
      {shot && <ScreenshotDialog />}
      <ErrorToast />
      <UpdateToast />
    </div>
  );
}

function Header() {
  const { mode, remote, set, link, profile, idn, model, console: con } = useDev(useShallow((s) => ({
    mode: s.mode, remote: s.remote, set: s.set, link: s.link, profile: s.profile, idn: s.idn, model: s.model, console: s.console,
  })));
  const gen = useDev((s) => s.gen);
  const [menu, setMenu] = useState(false);
  const item = (f: () => void) => () => { setMenu(false); f(); };

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-panel px-4 py-2">
      <div className="flex items-center gap-2 font-semibold">
        <Activity size={18} className="text-accent" />
        <span>OpenOSC Panel</span>
      </div>

      <nav className="flex rounded-lg border border-border bg-canvas p-0.5" aria-label="Instrument">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => void io.setMode(t.id)}
            aria-current={mode === t.id}
            aria-label={t.label}
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              mode === t.id ? 'bg-accent text-white' : 'text-muted hover:text-fg',
            )}
          >
            {t.icon}
            <span className="max-sm:hidden">{t.label}</span>
          </button>
        ))}
      </nav>

      <RecButton />

      {gen.out && mode !== 'gen' && (
        <button onClick={() => void io.setMode('gen')} className="flex items-center gap-1.5 rounded border border-success/40 px-2 py-0.5 font-mono text-xs text-success" title="Generator output is on">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
          GEN {SHAPES.find((s) => s.id === gen.shape)!.label} {fmtHz(gen.freq, true)}
        </button>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded border border-amber/40 px-2 py-0.5 text-xs font-medium text-amber" title="USB ground is tied to probe ground. Never measure mains while tethered.">
          <ShieldAlert size={13} /> <span className="whitespace-nowrap max-sm:hidden">Not isolated</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className={clsx('h-2 w-2 rounded-full', link === 'connected' ? 'bg-success' : 'animate-pulse bg-amber')} />
          <span className={link === 'connected' ? 'text-success' : 'text-amber'}>{link === 'connected' ? 'Connected' : 'Re-enumerating…'}</span>
          <span className="text-muted max-md:hidden" title={idn ? `Serial ${idn.serial}` : undefined}>{model} · OpenOSC {idn?.fw ?? '?'} · {profile}</span>
        </span>
        <Btn active={remote} tone={remote ? 'amber' : 'neutral'} onClick={() => void io.setRemote(!remote)} title="SYST:REM — lock the device keys">
          {remote ? <Lock size={13} /> : <LockOpen size={13} />} {remote ? 'Remote' : 'Local'}
        </Btn>
        <Btn onClick={() => set({ shot: true })} title="Device screenshot (DISP:DATA?)"><Camera size={14} /></Btn>
        <Btn active={con} onClick={() => set({ console: !con })} title="SCPI console"><SquareTerminal size={14} /></Btn>
        <div className="relative">
          <Btn onClick={() => setMenu(!menu)} title="More"><MoreVertical size={14} /></Btn>
          {menu && (
            <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-md border border-border bg-panel p-1 text-sm shadow-xl" onMouseLeave={() => setMenu(false)}>
              <MenuItem icon={<Info size={14} />} label="Device info & diagnostics" onClick={item(() => void io.deviceInfo())} />
              <MenuItem icon={<RotateCcw size={14} />} label="Reboot to Recovery (files)" onClick={item(() => void io.rebootToRecovery())} />
              <MenuItem icon={<LogOut size={14} />} label="Disconnect" danger onClick={item(() => void io.disconnect())} />
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// A DMM log goes on in the generator view: say so outside the multimeter, and lead back to it.
function RecButton() {
  const show = useDev((s) => s.logging && s.mode !== 'dmm');
  if (!show) return null;
  return (
    <button onClick={() => void io.setMode('dmm')} className="flex items-center gap-1.5 rounded border border-danger/50 px-2 py-0.5 font-mono text-xs text-danger" title="The multimeter is logging">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" />
      REC
    </button>
  );
}

function MenuItem({ icon, label, danger, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} className={clsx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface', danger ? 'text-danger' : 'text-fg')}>
      {icon} {label}
    </button>
  );
}

function SwitchingOverlay() {
  const profile = useDev((s) => s.profile);
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-canvas/70 backdrop-blur-sm">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-panel px-5 py-4 text-sm">
        <Loader2 size={18} className="animate-spin text-accent" />
        <div>
          <div className="font-semibold">Switching instrument profile…</div>
          <div className="text-xs text-muted">{profile} → {profile === 'DS1052' ? 'XDM1041' : 'DS1052'} · USB re-enumerates, ~{(SWITCH_MS / 1000).toFixed(1)} s</div>
        </div>
      </div>
    </div>
  );
}

function StatusBar() {
  const stats = useDev((s) => s.stats);
  const idn = useDev((s) => s.idn);
  const model = useDev((s) => s.model);
  return (
    <footer className="flex items-center justify-between border-t border-border bg-panel px-4 py-1 font-mono text-[11px] text-muted">
      <span>{stats || 'CDC'}</span>
      <span className="max-sm:hidden">{idn ? `${model} ${idn.serial.slice(-8)}` : ''} · panel v{version.trim()}</span>
    </footer>
  );
}

function ErrorToast() {
  const error = useDev((s) => s.error);
  if (!error) return null;
  return (
    <div className="fixed bottom-8 left-1/2 z-40 flex max-w-xl -translate-x-1/2 items-start gap-2 rounded-md border border-danger/50 bg-panel px-3 py-2 text-xs text-fg shadow-xl">
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-danger" />
      <span className="break-words">{error}</span>
      <button aria-label="Dismiss" onClick={() => useDev.getState().set({ error: null })} className="text-muted hover:text-fg"><X size={13} /></button>
    </div>
  );
}

// Never reloads on its own: an open session may hold an unexported DMM log or Bode result.
function UpdateToast() {
  const update = useDev((s) => s.update);
  const unsaved = useDev(unsavedData);
  if (!update) return null;
  return (
    <div role="status" className="fixed right-4 bottom-8 z-40 flex max-w-sm items-start gap-2 rounded-md border border-accent/50 bg-panel px-3 py-2 text-xs text-fg shadow-xl">
      <RefreshCw size={14} className="mt-0.5 shrink-0 text-accent" />
      <div className="space-y-2">
        <p>
          A new version is available. Updating reloads the panel and drops the USB connection.
          {unsaved && <span className="text-amber"> Export your DMM log / Bode result first, it will be lost.</span>}
        </p>
        <div className="flex gap-2">
          <Btn tone="accent" onClick={() => location.reload()}>Update</Btn>
          <Btn onClick={() => useDev.getState().set({ update: false })}>Later</Btn>
        </div>
      </div>
    </div>
  );
}

function ConnectScreen() {
  const link = useDev((s) => s.link);
  const supported = 'serial' in navigator;
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-4">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Activity size={22} className="text-accent" /> OpenOSC Panel
        </div>
        <div className="rounded-lg border border-border bg-panel p-5">
          <h1 className="text-xl font-semibold">Connect your ZT703S or ZT706S</h1>
          <p className="mt-1 text-sm text-muted">Multimeter, oscilloscope, generator and Bode analysis in the browser, over USB. No drivers.</p>
          <ul className="mt-4 space-y-2 text-sm">
            <li className="flex gap-2"><span className="text-success">✓</span> OpenOSC firmware 0.21 or newer</li>
            <li className="flex gap-2"><span className="text-success">✓</span> USB enabled: <span className="text-muted">Settings → Files &amp; USB</span></li>
            <li className="flex gap-2"><span className="text-success">✓</span> Performance profile 200/100 (USB is off in faster profiles)</li>
          </ul>
          <div className="mt-4 flex gap-3 rounded-md border border-amber/40 bg-amber/10 p-3 text-sm text-amber">
            <ShieldAlert size={18} className="shrink-0" />
            <span>The USB port is <b>not isolated</b>. Probe ground is tied to your computer's ground. Never measure mains while the cable is connected.</span>
          </div>
          <Btn tone="accent" className="mt-5 w-full py-2.5 text-sm" onClick={() => void io.connect()} disabled={link === 'connecting' || !supported}>
            {link === 'connecting' ? <><Loader2 size={15} className="animate-spin" /> Connecting…</> : <><Usb size={15} /> Connect device</>}
          </Btn>
          {!supported && <p className="mt-2 text-xs text-danger">Web Serial is unavailable in this browser. Use Chrome, Edge, Opera or Firefox 151+ on desktop.</p>}
        </div>
      </div>
    </div>
  );
}

function Console() {
  const log = useDev((s) => s.consoleLog);
  const [cmd, setCmd] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView(); }, [log]);
  const send = () => {
    if (!cmd.trim()) return;
    void io.consoleSend(cmd.trim());
    setCmd('');
  };
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-panel max-md:hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm font-semibold">
        SCPI console
        <button aria-label="Close console" onClick={() => useDev.getState().set({ console: false })} className="text-muted hover:text-fg"><X size={15} /></button>
      </div>
      <div className="flex-1 overflow-auto p-3 font-mono text-xs leading-5">
        {log.map((l, i) => <div key={i} className={clsx('break-all', l.startsWith('>') ? 'text-accent' : 'text-fg')}>{l}</div>)}
        <div ref={end} />
      </div>
      <input
        aria-label="SCPI command"
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="SYST:ERR?"
        className="border-t border-border bg-canvas px-3 py-2 font-mono text-xs outline-none"
      />
    </aside>
  );
}

function ScreenshotDialog() {
  const [url, setUrl] = useState<string | null>(null);
  const [ms, setMs] = useState(0);
  const [size, setSize] = useState('');
  const img = useRef<HTMLImageElement>(null);
  const take = async () => {
    const t = performance.now();
    const blob = await io.screenshot();
    setMs(Math.round(performance.now() - t));
    setUrl(blob ? URL.createObjectURL(blob) : null);
  };
  useEffect(() => { void take(); }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]); // the BMP leaves with the dialog
  const close = () => useDev.getState().set({ shot: false });
  const model = useDev((s) => s.model);
  const save = () => {
    const im = img.current!, c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    c.getContext('2d')!.drawImage(im, 0, 0);
    c.toBlob((b) => b && io.download(`${model.toLowerCase()}-${Date.now()}.png`, b), 'image/png');
  };
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" onClick={close}>
      <div className="rounded-lg border border-border bg-panel p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Device screenshot <span className="font-normal text-muted">{size}{ms ? ` · ${ms} ms` : ''}</span></h2>
          <button aria-label="Close" onClick={close} className="text-muted hover:text-fg"><X size={16} /></button>
        </div>
        <div className="flex aspect-[4/3] w-[640px] max-w-full items-center justify-center rounded border border-border bg-black">
          {url ? <img ref={img} src={url} alt="Device screen" onLoad={(e) => setSize(`· ${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)} className="h-full w-full object-contain [image-rendering:pixelated]" /> : <Loader2 className="animate-spin text-muted" />}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Btn onClick={() => void take()}><RotateCcw size={13} /> Retake</Btn>
          <Btn tone="accent" onClick={save} disabled={!url}><Download size={13} /> Save PNG</Btn>
        </div>
      </div>
    </div>
  );
}
