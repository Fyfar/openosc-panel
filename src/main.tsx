import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';
import { App } from './App';
import './pwa';

// A render error would otherwise blank the page while the device keeps running (generator on).
class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <div className="w-full max-w-lg space-y-3 rounded-lg border border-danger/50 bg-panel p-5 text-sm">
          <h1 className="text-lg font-semibold">The panel crashed</h1>
          <p className="text-muted">The device keeps its last settings: a running generator stays on. Reload to reconnect.</p>
          <pre className="overflow-auto rounded bg-canvas p-2 font-mono text-xs text-danger">{error.message}</pre>
          <button onClick={() => location.reload()} className="rounded-md border border-accent bg-accent px-3 py-1.5 text-xs font-semibold text-white">Reload</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Crash>
      <App />
    </Crash>
  </StrictMode>,
);
