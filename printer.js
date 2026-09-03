// printer.js — Web Bluetooth driver for the Kmart JLR-79430 (YHK) thermal printer.
//
// This unit is an ESC/POS printer behind an ISSC/Microchip "Transparent UART"
// BLE bridge (service 49535343-…). We stream a raw ESC/POS byte job over the
// write characteristic; the bridge pipes it to the printer's serial port.
// Flow control: ~180-byte writes with ~40 ms pauses (≈5 KB/s), per the
// reverse-engineering notes for these ISSC bridges.

const SERVICE_UUID = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const TX_UUID = '49535343-8841-43f4-a8d4-ecbe34729bb3';        // write (host -> printer)
const RX_UUID = '49535343-1e4d-4bd9-ba61-23c647249616';        // notify (printer -> host)
const OPTIONAL_SERVICES = [SERVICE_UUID, 0xae30, 0xaf30, 0xff00, 0x18f0, 0x180a, 0x180f];
const NAME_PREFIXES = ['YHK', 'GB0', 'GT0', 'MX0', 'MX1', 'PD0', 'YT0', 'SC0', '_ZZ', 'Anko'];

const PRINT_WIDTH = 384;      // dots per line
const BYTES_PER_LINE = 48;    // 384 / 8

// ESC/POS opcodes
const ESC = 0x1b, GS = 0x1d, DLE = 0x10, EOT = 0x04;

// Real-time status bits, as this unit actually answers them (see README).
// DLE EOT 1 — printer: bit3 = offline
// DLE EOT 2 — offline: bit2 = cover open, bit5 = stopped on paper end, bit6 = error
// DLE EOT 4 — paper:   bits 2,3 = roll near end, bits 5,6 = roll end
const ST_OFFLINE = 0x08, ST_COVER = 0x04, ST_PAPER_END = 0x20, ST_ERROR = 0x40;
const ST_ROLL_LOW = 0x0c, ST_ROLL_END = 0x60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CatPrinter {
  constructor(log = () => {}) {
    this.log = log;
    this.device = null;
    this.tx = null;   // write characteristic
    this.rx = null;   // notify characteristic
    this._pending = null;        // in-flight status query awaiting its reply
    this._lastQueryAt = 0;       // when the last query went out
    this._lastPacketAt = 0;      // when the last packet came back
    this._needsSettle = false;   // a query timed out; wait for quiet before asking again
    this._observedLatency = 0;   // slowest reply we've actually seen, ms
    this.statusSupported = null; // null until we've asked once
    this.busy = false;           // a job is in flight
  }

  get connected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available. Use Chrome/Edge over https or localhost.');
    this.log('Requesting device…');
    this.device = await navigator.bluetooth.requestDevice({
      filters: NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
      optionalServices: OPTIONAL_SERVICES,
    });
    this.device.addEventListener('gattserverdisconnected', () => this.log('⚠️ Disconnected.'));
    this.log(`Connecting to ${this.device.name || '(unnamed)'}…`);
    const server = await this.device.gatt.connect();

    // Bind the write + notify characteristics, with a fallback scan.
    let tx = null, rx = null;
    try {
      const svc = await server.getPrimaryService(SERVICE_UUID);
      tx = await svc.getCharacteristic(TX_UUID);
      try { rx = await svc.getCharacteristic(RX_UUID); } catch { /* optional */ }
    } catch {
      this.log('Primary service not found — scanning all services…');
      for (const svc of await server.getPrimaryServices()) {
        for (const ch of await svc.getCharacteristics()) {
          if (!tx && (ch.properties.write || ch.properties.writeWithoutResponse)) tx = ch;
          if (!rx && ch.properties.notify) rx = ch;
        }
      }
    }
    if (!tx) throw new Error('No writable characteristic found on this device.');
    this.tx = tx;
    this.rx = rx;

    if (rx) {
      try {
        await rx.startNotifications();
        rx.addEventListener('characteristicvaluechanged',
          (e) => this._onNotify(new Uint8Array(e.target.value.buffer)));
      } catch { /* notifications optional */ }
    }
    this.log(`✅ Connected. write=${tx.uuid.slice(4, 8)} notify=${rx ? rx.uuid.slice(4, 8) : 'none'}`);

    // Ask once, up front, so we know whether paper-out is detectable at all.
    // The bridge needs a moment after connecting before replies start flowing.
    await sleep(800);
    const st = await this.status({ timeout: 1200 });
    this.log(st.supported
      ? `Status: ${st.summary}${this._observedLatency > 800 ? ` (replies take ~${Math.round(this._observedLatency)} ms)` : ''}`
      : 'ℹ️ No status reply yet — paper-out can\'t be detected. Will re-check if one turns up.');
    return this.device.name;
  }

  async disconnect() {
    if (this.connected) this.device.gatt.disconnect();
  }

  // Route an inbound packet to whoever asked for it, else log it.
  _onNotify(packet) {
    const now = performance.now();
    this._lastPacketAt = now;
    const hex = [...packet].map((b) => b.toString(16).padStart(2, '0')).join(' ');

    // On time or not, a reply tells us how slow this printer is. Windows are
    // sized from this, so one slow answer teaches every query that follows.
    const since = this._lastQueryAt ? now - this._lastQueryAt : 0;
    if (since && since < 15000) this._observedLatency = Math.max(this._observedLatency, since);

    if (this._pending) {
      const p = this._pending;
      this._pending = null;
      clearTimeout(p.timer);
      p.resolve(packet);
      return;
    }

    // Nothing was waiting: this is a straggler from a query that already gave
    // up. It must never be treated as an answer — 0x16 (printer status) read as
    // an offline byte would mean "cover open", and we'd refuse to print.
    this.log(`« ${hex}${since ? ` (late by ${Math.round(since)} ms — discarded)` : ''}`);
    if (packet.length === 1 && this.statusSupported === false) {
      this.statusSupported = null;
      this.log('ℹ️ It does answer, just slowly — will re-check before the next print.');
    }
  }

  // After a timeout, wait for the line to go quiet before asking anything else.
  // Whatever is still in flight lands here, teaching us the real latency, so it
  // can't overlap the next query. No fixed delay is safe: the whole problem is
  // that we don't yet know how slow this printer is.
  async _settle({ quiet = 2000, max = 8000 } = {}) {
    const start = performance.now();
    for (;;) {
      const mark = this._lastPacketAt;
      await sleep(Math.max(quiet, this._observedLatency));
      if (this._lastPacketAt === mark) return;          // nothing arrived — quiet
      if (performance.now() - start > max) return;      // give up waiting for quiet
    }
  }

  // One unpaced write. Everything else goes through _write.
  async _writeRaw(buf) {
    if (this.tx.properties.writeWithoutResponse) await this.tx.writeValueWithoutResponse(buf);
    else await this.tx.writeValue(buf);
  }

  // Stream a raw byte job in BLE-friendly chunks with pacing so the UART bridge
  // (and the printer's line buffer) don't overflow. `watch` is polled between
  // chunks and aborts the job if it reports a fault.
  async _write(bytes, { chunk = 180, delay = 40, watch = null, watchEvery = 3000 } = {}) {
    let nextWatch = performance.now() + watchEvery;
    for (let i = 0; i < bytes.length; i += chunk) {
      await this._writeRaw(bytes.subarray(i, i + chunk));
      if (delay) await sleep(delay);
      if (i % (chunk * 20) === 0) this.log(`  …${Math.min(i + chunk, bytes.length)}/${bytes.length} bytes`);
      if (watch && performance.now() >= nextWatch) {
        nextWatch = performance.now() + watchEvery;
        const fault = await watch();
        if (fault) throw new Error(fault);
      }
    }
  }

  // --- real-time status ------------------------------------------------------
  // DLE EOT is answered out of band — this unit replies even mid-raster — so a
  // job can be watched while it streams. Replies took up to ~500 ms in testing.

  // Ask one question. Resolves to the reply byte, or null if nothing comes back.
  // The window grows to fit the slowest reply we've seen.
  async _query(bytes, timeout = 600, { adaptive = true } = {}) {
    if (!this.rx || !this.connected) return null;
    if (this._needsSettle) { this._needsSettle = false; await this._settle(); }
    const window = adaptive
      ? Math.min(6000, Math.max(timeout, this._observedLatency * 1.5 + 300))
      : timeout;
    const reply = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending = null;
        this._needsSettle = true;
        resolve(null);
      }, window);
      this._pending = { resolve, timer };
    });
    this._lastQueryAt = performance.now();
    await this._writeRaw(Uint8Array.from(bytes));
    const packet = await reply;
    return packet && packet.length ? packet[0] : null;
  }

  /**
   * Read printer, offline and paper status.
   * Every field is `null` when the firmware didn't answer that query — callers
   * must read null as "unknown", never as "fine" and never as "faulty".
   * @returns {Promise<object>} { supported, online, coverOpen, paperOut, paperLow, error, summary, raw }
   */
  async status({ timeout = 600, retry = true } = {}) {
    let st = await this._statusOnce(timeout);
    // Silence plus a straggler means it answers, just slower than we allowed.
    // Retry once, now that _observedLatency knows how long to wait. A printer
    // that truly says nothing has taught us nothing, so we don't bother.
    if (!st.supported && retry && this._observedLatency > 0) {
      this.log(`Status reply arrived late — retrying with a ${Math.round(this._observedLatency * 1.5 + 300)} ms window…`);
      await sleep(300);
      st = await this._statusOnce(timeout);
    }
    this.statusSupported = st.supported;
    return st;
  }

  async _statusOnce(timeout) {
    const printer = await this._query([DLE, EOT, 0x01], timeout);
    const offline = await this._query([DLE, EOT, 0x02], timeout);
    // Two silences in a row is enough to call it: don't spend a third window.
    const paper = printer === null && offline === null
      ? null
      : await this._query([DLE, EOT, 0x04], timeout);
    const supported = [printer, offline, paper].some((b) => b !== null);
    const bit = (byte, mask) => (byte === null ? null : (byte & mask) !== 0);
    const merge = (...vals) => {
      const known = vals.filter((v) => v !== null);
      return known.length ? known.some(Boolean) : null;
    };
    const st = {
      supported,
      raw: { printer, offline, paper },
      online: printer === null ? null : !(printer & ST_OFFLINE),
      coverOpen: bit(offline, ST_COVER),
      paperOut: merge(bit(offline, ST_PAPER_END), bit(paper, ST_ROLL_END)),
      paperLow: bit(paper, ST_ROLL_LOW),
      error: bit(offline, ST_ERROR),
    };

    const parts = [];
    if (st.online === false) parts.push('offline');
    else if (st.online) parts.push('online');
    if (st.paperOut) parts.push('OUT OF PAPER');
    else if (st.paperLow) parts.push('paper low');
    else if (st.paperOut === false) parts.push('paper OK');
    if (st.coverOpen) parts.push('cover open');
    if (st.error) parts.push('error bit set');
    st.summary = parts.length ? parts.join(' · ') : 'no usable status';
    return st;
  }

  /**
   * Block until the printer has actually finished, not merely received the job.
   *
   * `GS r 1` is a *buffered* query: unlike DLE EOT (which is answered in real
   * time, even mid-raster) it is answered only when the parser reaches it, so
   * sending it after a job turns it into an end-of-job sentinel — the reply
   * means everything queued ahead of it has been consumed. If this firmware
   * answers early, or not at all, the settle window still keeps a caller from
   * re-entering while the platen is moving.
   */
  async _awaitCompletion(rows, { settle = 800 } = {}) {
    if (!this.rx) { await sleep(settle); return { confirmed: false, ms: settle }; }
    const t0 = performance.now();
    const reply = await this._query([GS, 0x72, 0x01], Math.min(20000, 3000 + rows * 3));
    const ms = Math.round(performance.now() - t0);
    if (reply === null) {
      this.log(`⚠️ No end-of-job reply after ${ms} ms — assuming finished.`);
      await sleep(settle);
      return { confirmed: false, ms };
    }
    if (ms < settle) await sleep(settle - ms);        // let the platen stop
    this.log(`✅ Printer finished, ${ms} ms after the last byte.`);
    return { confirmed: true, ms };
  }

  // One cheap question mid-job. Silence means "unknown", so we keep printing
  // rather than abandoning a good job because a reply was slow.
  async _faultCheck() {
    const b = await this._query([DLE, EOT, 0x02], 400, { adaptive: false });
    if (b === null) return null;
    if (b & ST_PAPER_END) return 'Out of paper — printing stopped partway.';
    if (b & ST_COVER) return 'Cover opened — printing stopped partway.';
    if (b & ST_ERROR) return 'Printer reported a fault — printing stopped partway.';
    return null;
  }

  /**
   * Print an array of 48-byte lines (each bit = one dot, MSB = leftmost, 1 = black).
   * @param {Uint8Array[]} lines
   * @param {object} opts { energy: 0..1 darkness, feed: eject dots }
   */
  async print(lines, opts = {}) {
    if (!this.connected) throw new Error('Not connected.');
    // One job at a time: a second stream would interleave with this one's bytes
    // and print garbage, so refuse rather than queue.
    if (this.busy) throw new Error('Still printing — wait for the job to finish.');
    this.busy = true;
    try {
      return await this._print(lines, opts);
    } finally {
      this.busy = false;
    }
  }

  async _print(lines, opts = {}) {

    // Pre-flight: don't stream a job into a printer that can't take it.
    if (opts.preflight !== false && this.statusSupported !== false) {
      const st = await this.status();
      if (!st.supported) {
        this.log('ℹ️ No status support — printing blind.');
      } else {
        this.log(`Status: ${st.summary}`);
        if (st.paperOut) throw new Error('Out of paper — load a roll and print again.');
        if (st.coverOpen) throw new Error('Cover is open — close it and print again.');
        if (st.online === false) throw new Error('Printer reports it is offline.');
        if (st.error) throw new Error('Printer reports a fault — power-cycle it and try again.');
        if (st.paperLow) this.log('⚠️ Roll is near its end.');
      }
    } else if (this.statusSupported === false) {
      this.log('ℹ️ No status support — printing blind.');   // asked once, at connect
    }

    const heat = Math.round(40 + (opts.energy ?? 0.6) * 180);   // ESC 7 heating time, ~40..220
    const feed = Math.max(0, opts.feed ?? 200);                 // dots of blank paper to clear the tear bar
    const H = lines.length;

    this.log(`Printing ${H} lines (darkness ${Math.round((opts.energy ?? 0.6) * 100)}%, heat ${heat})…`);

    const job = [];
    job.push(ESC, 0x40);                 // ESC @  — initialize
    job.push(ESC, 0x37, 7, heat, 2);     // ESC 7  — heating: maxDots=7, time=heat, interval=2
    job.push(GS, 0x21, 0x00);            // GS !   — normal character size (harmless)

    // GS v 0 raster bit image, in horizontal bands to respect the line buffer.
    const BAND = 128;
    for (let y0 = 0; y0 < H; y0 += BAND) {
      const rows = Math.min(BAND, H - y0);
      job.push(GS, 0x76, 0x30, 0x00,               // GS v 0, mode 0
        BYTES_PER_LINE & 0xff, (BYTES_PER_LINE >> 8) & 0xff,  // xL xH = width in bytes
        rows & 0xff, (rows >> 8) & 0xff);          // yL yH = height in dots
      for (let y = y0; y < y0 + rows; y++) for (const b of lines[y]) job.push(b);
    }

    // Feed to clear the tear bar. This printer ignores ESC J after a raster block,
    // so we advance the paper by printing blank raster rows (all-zero = white),
    // which reliably moves the platen.
    for (let left = feed; left > 0; left -= BAND) {
      const rows = Math.min(BAND, left);
      job.push(GS, 0x76, 0x30, 0x00,
        BYTES_PER_LINE & 0xff, (BYTES_PER_LINE >> 8) & 0xff,
        rows & 0xff, (rows >> 8) & 0xff);
      for (let i = 0; i < rows * BYTES_PER_LINE; i++) job.push(0x00);
    }
    // Long jobs get watched as they stream, so a mid-print paper-out is caught
    // in a few seconds instead of after the whole zine has been pushed out.
    // Watching costs a round trip every few seconds, so it's only worth it on a
    // printer that answers promptly — otherwise the poll would stall the job.
    const watch = this.statusSupported && H > 400 && this._observedLatency < 1000
      ? () => this._faultCheck()
      : null;
    if (watch) this.log('Watching for paper-out while printing…');
    else if (this.statusSupported && H > 400) this.log('Not watching mid-print — this printer replies too slowly.');
    try {
      await this._write(Uint8Array.from(job), { watch });
    } catch (e) {
      try { await this._writeRaw(Uint8Array.from([ESC, 0x40])); } catch { /* already gone */ }
      throw e;
    }
    this.log('Sent — waiting for the printer to finish…');
    return this._awaitCompletion(H + feed);
  }

  // Phase 0 helper: dump all GATT services + characteristics.
  async inspect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not available.');
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: OPTIONAL_SERVICES,
    });
    const server = await device.gatt.connect();
    const lines = [`Device: ${device.name || '(unnamed)'} id=${device.id}`];
    for (const svc of await server.getPrimaryServices()) {
      lines.push(`Service ${svc.uuid}`);
      for (const ch of await svc.getCharacteristics()) {
        const p = Object.entries(ch.properties).filter(([, v]) => v).map(([k]) => k).join(',');
        lines.push(`  char ${ch.uuid}  [${p}]`);
      }
    }
    device.gatt.disconnect();
    return lines.join('\n');
  }
}

export { PRINT_WIDTH, BYTES_PER_LINE };
