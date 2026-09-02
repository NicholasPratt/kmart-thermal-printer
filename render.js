// render.js — turn text / images into 384-wide monochrome lines for the printer.
import { PRINT_WIDTH, BYTES_PER_LINE } from './printer.js';
import { qrcodegen } from './qrcodegen.js';

// Render a QR code centered on a print-width canvas, with an optional caption.
export function renderQR(text, { ecc = 'M', caption = false } = {}) {
  const Ecc = qrcodegen.QrCode.Ecc;
  const eccMap = { L: Ecc.LOW, M: Ecc.MEDIUM, Q: Ecc.QUARTILE, H: Ecc.HIGH };
  const qr = qrcodegen.QrCode.encodeText(text && text.length ? text : ' ', eccMap[ecc] || Ecc.MEDIUM);

  const quiet = 4;                                   // standard quiet zone (modules)
  const total = qr.size + quiet * 2;
  const scale = Math.max(2, Math.floor((PRINT_WIDTH - 8) / total));  // biggest fit
  const dim = total * scale;                         // QR block size in px
  const x0 = Math.floor((PRINT_WIDTH - dim) / 2);    // center horizontally

  // Lay out an optional caption below the code.
  const capFont = 22, capLine = Math.round(capFont * 1.25), capPad = 10;
  let capLines = [];
  if (caption && text) {
    const m = document.createElement('canvas').getContext('2d');
    m.font = `${capFont}px monospace`;
    for (const word of text.split(/\s+/)) {
      const last = capLines[capLines.length - 1];
      const test = last ? `${last} ${word}` : word;
      if (last && m.measureText(test).width > PRINT_WIDTH - 16) capLines.push(word);
      else if (last) capLines[capLines.length - 1] = test;
      else capLines.push(word);
    }
  }
  const capH = capLines.length ? capLines.length * capLine + capPad : 0;

  const canvas = document.createElement('canvas');
  canvas.width = PRINT_WIDTH;
  canvas.height = dim + capH + 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) {
        ctx.fillRect(x0 + (x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  }

  if (capLines.length) {
    ctx.font = `${capFont}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    capLines.forEach((l, i) => ctx.fillText(l, PRINT_WIDTH / 2, dim + capPad + i * capLine));
  }
  return canvas;
}

// Render multiline text onto a canvas sized to the print width.
export function renderText(text, { fontSize = 28, font = 'monospace', align = 'left', pad = 8 } = {}) {
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `${fontSize}px ${font}`;
  const lineHeight = Math.round(fontSize * 1.3);

  // Word-wrap to the print width.
  const maxW = PRINT_WIDTH - pad * 2;
  const wrapped = [];
  for (const raw of text.split('\n')) {
    if (raw === '') { wrapped.push(''); continue; }
    let line = '';
    for (const word of raw.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (measure.measureText(test).width > maxW && line) { wrapped.push(line); line = word; }
      else line = test;
    }
    wrapped.push(line);
  }

  const canvas = document.createElement('canvas');
  canvas.width = PRINT_WIDTH;
  canvas.height = Math.max(lineHeight, wrapped.length * lineHeight + pad * 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  ctx.font = `${fontSize}px ${font}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  const x = align === 'center' ? PRINT_WIDTH / 2 : align === 'right' ? PRINT_WIDTH - pad : pad;
  wrapped.forEach((l, i) => ctx.fillText(l, x, pad + i * lineHeight));
  return canvas;
}

// Draw an image source (<img>, <canvas>, or <video>) scaled to the print width.
export function renderImage(source) {
  const sw = source.naturalWidth || source.videoWidth || source.width;
  const sh = source.naturalHeight || source.videoHeight || source.height;
  const scale = PRINT_WIDTH / sw;
  const canvas = document.createElement('canvas');
  canvas.width = PRINT_WIDTH;
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Floyd–Steinberg dither a canvas to 1-bit. Mutates the returned canvas in place
// so the preview shows exactly what will print. brightness: -1..1, contrast: 0..2.
export function dither(srcCanvas, { brightness = 0, contrast = 1, mode = 'dither', threshold = 0.5 } = {}) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const ctx = srcCanvas.getContext('2d');
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;

  // Grayscale + brightness/contrast into a float buffer (0..1, 1 = white).
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    let v = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    v = (v - 0.5) * contrast + 0.5 + brightness;
    gray[i] = Math.min(1, Math.max(0, v));
  }

  const out = new Uint8Array(w * h); // 1 = black
  if (mode === 'threshold') {
    for (let i = 0; i < w * h; i++) out[i] = gray[i] < threshold ? 1 : 0;
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = gray[i];
        const nv = old < 0.5 ? 0 : 1;         // 0 black, 1 white
        out[i] = nv === 0 ? 1 : 0;
        const err = old - nv;
        if (x + 1 < w) gray[i + 1] += err * 7 / 16;
        if (y + 1 < h) {
          if (x > 0) gray[i + w - 1] += err * 3 / 16;
          gray[i + w] += err * 5 / 16;
          if (x + 1 < w) gray[i + w + 1] += err * 1 / 16;
        }
      }
    }
  }

  // Paint the result back for the on-screen preview.
  for (let i = 0; i < w * h; i++) {
    const v = out[i] ? 0 : 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return out; // Uint8Array, 1 = black, row-major w*h
}

// Pack a 1-bit array (1 = black) into 48-byte lines.
// ESC/POS raster order: MSB (0x80) = leftmost dot.
export function packLines(bits, w, h) {
  const lines = [];
  for (let y = 0; y < h; y++) {
    const line = new Uint8Array(BYTES_PER_LINE);
    for (let x = 0; x < w && x < PRINT_WIDTH; x++) {
      if (bits[y * w + x]) line[x >> 3] |= (0x80 >> (x & 7));
    }
    lines.push(line);
  }
  return lines;
}
