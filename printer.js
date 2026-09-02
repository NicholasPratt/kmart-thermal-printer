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
const ESC = 0x1b, GS = 0x1d;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CatPrinter {
  constructor(log = () => {}) {
    this.log = log;
    this.device = null;
    this.tx = null;   // write characteristic
    this.rx = null;   // notify characteristic
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
        rx.addEventListener('characteristicvaluechanged', (e) => {
          const v = e.target.value;
          const hex = [...new Uint8Array(v.buffer)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
          this.log(`« ${hex}`);
        });
      } catch { /* notifications optional */ }
    }
    this.log(`✅ Connected. write=${tx.uuid.slice(4, 8)} notify=${rx ? rx.uuid.slice(4, 8) : 'none'}`);
    return this.device.name;
  }

  async disconnect() {
    if (this.connected) this.device.gatt.disconnect();
  }

  // Stream a raw byte job in BLE-friendly chunks with pacing so the UART bridge
  // (and the printer's line buffer) don't overflow.
  async _write(bytes, { chunk = 180, delay = 40 } = {}) {
    const withoutResp = this.tx.properties.writeWithoutResponse;
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, i + chunk);
      if (withoutResp) await this.tx.writeValueWithoutResponse(slice);
      else await this.tx.writeValue(slice);
      if (delay) await sleep(delay);
      if (i % (chunk * 20) === 0) this.log(`  …${Math.min(i + chunk, bytes.length)}/${bytes.length} bytes`);
    }
  }

  /**
   * Print an array of 48-byte lines (each bit = one dot, MSB = leftmost, 1 = black).
   * @param {Uint8Array[]} lines
   * @param {object} opts { energy: 0..1 darkness, feed: eject dots }
   */
  async print(lines, opts = {}) {
    if (!this.connected) throw new Error('Not connected.');
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
    await this._write(Uint8Array.from(job));
    this.log('✅ Sent.');
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
