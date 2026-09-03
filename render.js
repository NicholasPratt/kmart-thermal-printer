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

// --- zine layout ------------------------------------------------------------
const DOTS_PER_MM = 8;    // 203 dpi head
const PAGE_NUM_H = 22;    // band reserved at the foot of a page for its number
const SEP_H = 16;         // gutter between pages that holds the cut line
const IMG_GAP = 8;        // breathing room above/below a placed photo

export { DOTS_PER_MM };

// Word-wrap one paragraph to the print width.
function wrapLine(measure, raw, maxW) {
  if (raw === '') return [''];
  const out = [];
  let line = '';
  for (const word of raw.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (measure.measureText(test).width > maxW && line) { out.push(line); line = word; }
    else line = test;
  }
  out.push(line);
  return out;
}

// Dither a photo to pure black/white at its final size, so it survives the
// page-wide threshold pass that keeps the text crisp.
function renderPhoto(img, w, h, contrast) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  dither(c, { contrast, mode: 'dither' });
  return c;
}

function drawCutLine(ctx, y) {
  ctx.fillStyle = '#000';
  for (let x = 8; x < PRINT_WIDTH - 8; x += 12) ctx.fillRect(x, y, 6, 2);
}

// Lay text and placed photos out as a zine: a stack of fixed-height pages, with
// optional page numbers and a dashed cut line in the gutter between them.
// pageHeight 0 means continuous — one page as tall as the content, i.e. the
// plain text behaviour. Photos come from a Map of id -> { img, width, align };
// a line reading `[img:3]` places one, a line of `---` forces a page break.
// Returns a canvas carrying .zinePages / .zineTruncated.
export function renderZine(text, {
  fontSize = 28, font = 'monospace', align = 'left', pad = 8,
  pageHeight = 0, pageNumbers = false, separator = false,
  photos = new Map(), photoContrast = 1.15, maxHeight = 30000,
} = {}) {
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `${fontSize}px ${font}`;
  const lineHeight = Math.round(fontSize * 1.3);
  const maxW = PRINT_WIDTH - pad * 2;

  // 1. Flatten the source into a list of laid-out items.
  const items = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (/^(-{3,}|={3,})$/.test(trimmed)) { items.push({ type: 'break' }); continue; }
    const token = trimmed.match(/^\[img:(\d+)\]$/i);
    const ph = token && photos.get(+token[1]);
    if (ph && ph.img && ph.img.naturalWidth) {
      const w = Math.max(16, Math.round(maxW * (ph.width ?? 100) / 100));
      const h = Math.max(1, Math.round(ph.img.naturalHeight * w / ph.img.naturalWidth));
      items.push({ type: 'img', ph, w, h });
      continue;                       // an unknown token just prints as text
    }
    for (const line of wrapLine(measure, raw, maxW)) items.push({ type: 'text', text: line });
  }
  const itemH = (it) => (it.type === 'img' ? it.h + IMG_GAP : lineHeight);

  // 2. Break the flow into pages.
  let pages, pageH = pageHeight;
  if (pageHeight) {
    const contentH = Math.max(lineHeight, pageHeight - pad * 2 - (pageNumbers ? PAGE_NUM_H : 0));
    for (const it of items) {         // shrink a photo that could never fit a page
      if (it.type !== 'img' || it.h + IMG_GAP <= contentH) continue;
      const s = (contentH - IMG_GAP) / it.h;
      it.w = Math.max(8, Math.round(it.w * s));
      it.h = Math.max(1, Math.round(it.h * s));
    }
    pages = [[]];
    let y = 0;
    for (const it of items) {
      let page = pages[pages.length - 1];
      if (it.type === 'break') { if (page.length) { pages.push([]); y = 0; } continue; }
      if (!page.length && it.type === 'text' && it.text === '') continue;  // no blank first line
      if (y + itemH(it) > contentH && page.length) { pages.push([]); page = pages[pages.length - 1]; y = 0; }
      it.y = y;
      y += itemH(it);
      page.push(it);
    }
    if (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
  } else {
    let y = 0;
    const flow = items.filter((it) => it.type !== 'break');
    for (const it of flow) { it.y = y; y += itemH(it); }
    pages = [flow];
    pageH = Math.max(lineHeight, y + pad * 2);
  }

  // 3. Draw. Keep the canvas inside the browser's limits.
  const sep = separator && pageHeight ? SEP_H : 0;
  let truncated = false;
  if (pageHeight) {
    const maxPages = Math.max(1, Math.floor((maxHeight + sep) / (pageH + sep)));
    if (pages.length > maxPages) { pages = pages.slice(0, maxPages); truncated = true; }
  }
  const n = pages.length;

  const canvas = document.createElement('canvas');
  canvas.width = PRINT_WIDTH;
  canvas.height = n * pageH + (n - 1) * sep;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = 'top';

  const textX = align === 'center' ? PRINT_WIDTH / 2 : align === 'right' ? PRINT_WIDTH - pad : pad;
  pages.forEach((page, p) => {
    const top = p * (pageH + sep);
    ctx.fillStyle = '#000';
    ctx.font = `${fontSize}px ${font}`;
    ctx.textAlign = align;
    for (const it of page) {
      if (it.type === 'text') { ctx.fillText(it.text, textX, top + pad + it.y); continue; }
      const x = it.ph.align === 'center' ? Math.round((PRINT_WIDTH - it.w) / 2)
        : it.ph.align === 'right' ? PRINT_WIDTH - pad - it.w : pad;
      ctx.drawImage(renderPhoto(it.ph.img, it.w, it.h, photoContrast), x, top + pad + it.y + IMG_GAP / 2);
    }
    if (pageNumbers && pageHeight) {
      ctx.font = `16px ${font}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(p + 1), PRINT_WIDTH / 2, top + pageH - PAGE_NUM_H + 4);
    }
    if (sep && p < n - 1) drawCutLine(ctx, top + pageH + Math.floor(sep / 2));
  });

  canvas.zinePages = n;
  canvas.zineTruncated = truncated;
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
