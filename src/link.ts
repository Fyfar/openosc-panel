// SCPI over Web Serial, ported from openosc-probe (verified on ZT703S / OpenOSC 0.21.4).
// The firmware answers one command at a time from a 256-byte reply buffer, so everything
// goes through one FIFO chain. Replies are text lines or IEEE 488.2 `#<n><len>` blocks.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const VID = 0x0483;
const PID = 0x572a;

export type Reply = { text?: string; bin?: Uint8Array };
export type Run = (lines: string[], timeout?: number) => Promise<Reply[]>;

export class Link {
  port: SerialPort | null = null;
  closed = true;
  private buf = new Uint8Array(1 << 20);
  private head = 0;
  private tail = 0;
  private waiter: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  onClose: (() => void) | null = null;
  private pumpDone: Promise<void> = Promise.resolve();

  async open(port: SerialPort) {
    this.port = port;
    // Baud is ignored by the device. Never touch DTR: a DTR change resets the SCPI session.
    await port.open({ baudRate: 115200, bufferSize: 65536 });
    this.writer = port.writable!.getWriter();
    this.head = this.tail = 0;
    this.closed = false;
    this.pumpDone = this.pump();
  }

  private async pump() {
    const r = (this.reader = this.port!.readable!.getReader());
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        this.push(value);
      }
    } catch {
      /* device lost (mode switch, unplug): handled by onClose */
    } finally {
      this.closed = true;
      try { r.releaseLock(); } catch { /* already released */ }
      this.waiter?.();
      this.onClose?.();
    }
  }

  push(chunk: Uint8Array) {
    if (this.tail + chunk.length > this.buf.length) {
      this.buf.copyWithin(0, this.head, this.tail);
      this.tail -= this.head;
      this.head = 0;
      if (this.tail + chunk.length > this.buf.length) {
        const b = new Uint8Array(Math.max(this.buf.length * 2, this.tail + chunk.length));
        b.set(this.buf.subarray(0, this.tail));
        this.buf = b;
      }
    }
    this.buf.set(chunk, this.tail);
    this.tail += chunk.length;
    this.waiter?.();
  }

  take(): Reply | null {
    const b = this.buf, h = this.head, n = this.tail - h;
    if (n <= 0) return null;
    if (b[h] === 0x23) {
      if (n < 2) return null;
      const d = b[h + 1] - 48;
      if (n < 2 + d) return null;
      const len = +dec.decode(b.subarray(h + 2, h + 2 + d)), end = h + 2 + d + len;
      if (this.tail < end + 1) return null;
      this.head = end + 1;
      return { bin: b.slice(h + 2 + d, end) };
    }
    const i = b.subarray(h, this.tail).indexOf(0x0a);
    if (i < 0) return null;
    this.head = h + i + 1;
    return { text: dec.decode(b.subarray(h, h + i)).replace(/\r$/, '') };
  }

  private next(timeout: number) {
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('timeout')); }, timeout);
      this.waiter = () => {
        const r = this.take();
        if (r) { clearTimeout(timer); this.waiter = null; resolve(r); }
        else if (this.closed) { clearTimeout(timer); this.waiter = null; reject(new Error('disconnected')); }
      };
      this.waiter();
    });
  }

  private send(lines: string[]) {
    return this.writer!.write(enc.encode(lines.map((l) => l + '\n').join('')));
  }

  // Holds the FIFO chain for the whole of `fn`, so a multi-batch exchange (preamble, then data)
  // can't be interleaved by another caller. Inside `fn` use the `run` it is given: calling
  // link.run/q/texts there would wait for `fn` itself and deadlock.
  tx<T>(fn: (run: Run) => Promise<T>): Promise<T> {
    const job = this.chain.then(() => {
      if (this.closed) throw new Error('not connected');
      return fn((lines, timeout) => this.batch(lines, timeout));
    });
    this.chain = job.catch(() => {});
    return job;
  }

  // Every line containing '?' gets one reply, in order.
  run(lines: string[], timeout = 3000): Promise<Reply[]> {
    return this.tx((run) => run(lines, timeout));
  }

  private async batch(lines: string[], timeout = 3000): Promise<Reply[]> {
    const out: Reply[] = [];
    try {
      for (const l of lines) {
        await this.send([l]);
        if (l.includes('?')) out.push(await this.next(timeout));
      }
    } catch (e) {
      if (!this.closed) await this.sync(3);
      throw e;
    }
    return out;
  }

  // A reply that arrives after its query timed out would answer the next query, and every later
  // one, shifted by one. So: ask *IDN? and skip whatever comes first until the OpenOSC answer.
  // Returns that answer, or null when it never came.
  private async sync(tries: number): Promise<string | null> {
    for (let i = 0; i < tries && !this.closed; i++) {
      try {
        await this.send(['*IDN?']);
        for (const end = performance.now() + 1000; ;) {
          const r = await this.next(Math.max(1, end - performance.now()));
          if (r.text?.startsWith('OpenOSC')) return r.text;
        }
      } catch {
        await sleep(400); // let a late reply land, then drop it and any half-received block
        this.head = this.tail = 0;
      }
    }
    return null;
  }

  // Handshake after open: the first query after enumeration may be lost, and after a page reload
  // the device can still be answering the previous session.
  identify(tries = 10) {
    return this.tx(() => this.sync(tries));
  }

  async q(cmd: string, timeout?: number) {
    const [r] = await this.run([cmd], timeout);
    return r.text ?? '';
  }

  async texts(lines: string[], timeout?: number) {
    return (await this.run(lines, timeout)).map((r) => r.text ?? '');
  }

  async close() {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* gone */ }
    await this.pumpDone; // port.close() fails while the read loop still holds the stream lock
    try { this.writer?.releaseLock(); } catch { /* gone */ }
    try { await this.port?.close(); } catch (e) { console.warn('[openosc] port.close failed', e); }
  }
}

export const matches = (p: SerialPort) => {
  const i = p.getInfo();
  return i.usbVendorId === VID && i.usbProductId === PID;
};
