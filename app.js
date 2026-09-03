// app.js — UI glue.
import { CatPrinter } from './printer.js';
import { PRINT_WIDTH } from './printer.js';
import { renderZine, renderImage, renderQR, dither, packLines, DOTS_PER_MM } from './render.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
function log(msg) {
  logEl.textContent += `\n${msg}`;
  logEl.scrollTop = logEl.scrollHeight;
}

const printer = new CatPrinter(log);
let currentImg = null;       // loaded <img> for the image tab
let capturedCanvas = null;   // frozen frame for the photobooth tab
let camStream = null;        // active webcam MediaStream
let camFacing = 'user';      // 'user' (front) or 'environment' (rear)
let activeTab = 'text';

// --- connection -------------------------------------------------------------
function setConnected(on) {
  $('dot').classList.toggle('on', on);
  $('status').textContent = on ? (printer.device?.name || 'connected') : 'not connected';
  $('disconnect').disabled = !on;
  $('print').disabled = !on;
  $('connect').textContent = on ? 'Reconnect' : 'Connect printer';
}

$('connect').onclick = async () => {
  try { await printer.connect(); setConnected(true); }
  catch (e) { log(`❌ ${e.message}`); }
};
$('disconnect').onclick = async () => { await printer.disconnect(); setConnected(false); };
$('inspect').onclick = async () => {
  try { log('--- BLE inspect ---'); log(await printer.inspect()); }
  catch (e) { log(`❌ ${e.message}`); }
};

// --- tabs -------------------------------------------------------------------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.onclick = () => {
    if (activeTab === 'photobooth' && btn.dataset.tab !== 'photobooth') stopCamera();
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    ['text', 'zine', 'image', 'qr', 'photobooth'].forEach((t) => $(`pane-${t}`).classList.toggle('active', activeTab === t));
    updatePreview();
  };
});

// --- photobooth -------------------------------------------------------------
function stopCamera() {
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  const cam = $('cam');
  cam.srcObject = null;
  cam.style.display = 'none';
  $('camShot').disabled = true;
  $('camSwitch').disabled = true;
}

async function startCamera(facing = camFacing) {
  stopCamera();
  // exact: forces the requested lens on phones; fall back for laptops with one cam.
  const tryGet = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
  try {
    camStream = await tryGet({ facingMode: { exact: facing }, width: { ideal: 1280 } });
  } catch {
    camStream = await tryGet({ facingMode: facing, width: { ideal: 1280 } });
  }
  camFacing = facing;
  const cam = $('cam');
  cam.srcObject = camStream;
  cam.style.display = 'inline-block';
  await cam.play();
  $('camMirror').checked = facing === 'user';   // rear shots shouldn't be mirrored
  applyMirror();
  applyCrop();
  $('camShot').disabled = false;
  $('camSwitch').disabled = !(await hasMultipleCameras());
  log(`📷 Camera started (${facing === 'user' ? 'front' : 'rear'}).`);
}

// Only worth offering the flip button when there is more than one lens.
async function hasMultipleCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput').length > 1;
  } catch { return false; }
}

$('camStart').onclick = async () => {
  try { await startCamera(camFacing); }
  catch (e) { log(`❌ Camera: ${e.message}`); }
};

$('camSwitch').onclick = async () => {
  const next = camFacing === 'user' ? 'environment' : 'user';
  try { await startCamera(next); }
  catch (e) { log(`❌ Camera: ${e.message}`); try { await startCamera(camFacing); } catch {} }
};

$('camShot').onclick = () => {
  const cam = $('cam');
  if (!cam.videoWidth) return;
  const vw = cam.videoWidth, vh = cam.videoHeight;
  // Square crop takes the centre of the frame — matches the live object-fit: cover view.
  const square = $('camCrop').value === 'square';
  const sw = square ? Math.min(vw, vh) : vw;
  const sh = square ? sw : vh;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;

  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d');
  if ($('camMirror').checked) { ctx.translate(sw, 0); ctx.scale(-1, 1); }
  ctx.drawImage(cam, sx, sy, sw, sh, 0, 0, sw, sh);
  capturedCanvas = c;
  $('camRetake').disabled = false;
  log(`📸 Captured ${sw}×${sh}${square ? ' (square)' : ''}.`);
  updatePreview();
};

$('camRetake').onclick = () => { capturedCanvas = null; $('camRetake').disabled = true; updatePreview(); };

function applyMirror() { $('cam').style.transform = $('camMirror').checked ? 'scaleX(-1)' : 'none'; }
function applyCrop() { $('cam').classList.toggle('square', $('camCrop').value === 'square'); }
$('camMirror').addEventListener('change', applyMirror);
$('camCrop').addEventListener('change', applyCrop);

// --- image loading ----------------------------------------------------------
$('file').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => { currentImg = img; updatePreview(); };
  img.src = URL.createObjectURL(f);
};

// --- zine: pages, photos, saved documents -----------------------------------
const photos = new Map();     // id -> { id, name, src, img, width, align }
let nextPhotoId = 1;
let ready = false;            // suppresses draft saves until the restore is done

const STORE_KEY = 'thermalp.zines';
const DRAFT_KEY = 'thermalp.zine.draft';

function pageHeightDots() {
  const v = $('pageSize').value;
  if (v === 'continuous') return 0;
  const mm = v === 'custom' ? +$('pageMM').value : +v;
  return mm > 0 ? Math.round(mm * DOTS_PER_MM) : 0;
}

function syncPageControls() {
  $('pageMMWrap').hidden = $('pageSize').value !== 'custom';
  const paged = pageHeightDots() > 0;
  $('pageNums').disabled = !paged;
  $('pageLine').disabled = !paged;
}
$('pageSize').addEventListener('change', syncPageControls);
$('pageMM').addEventListener('input', syncPageControls);

// Paper length is what actually costs you a roll, so show it alongside the count.
function describeZine(canvas) {
  const pages = canvas.zinePages || 1;
  const mm = Math.round(canvas.height / DOTS_PER_MM);
  const body = $('zineText').value;
  const photoCount = [...photos.keys()].filter((id) => body.includes(`[img:${id}]`)).length;
  $('zineInfo').textContent =
    `${pages} page${pages === 1 ? '' : 's'} · ${canvas.height} dots ≈ ${mm} mm of paper` +
    (photoCount ? ` · ${photoCount} photo${photoCount === 1 ? '' : 's'} placed` : '') +
    (canvas.zineTruncated ? ' · ⚠️ too long to render — later pages dropped' : '');
}

// --- photos -----------------------------------------------------------------
// Nothing prints wider than 384 dots, so downscale on import: it keeps saved
// zines inside the localStorage quota and makes the preview cheap to redraw.
function importPhoto(file) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => {
      const w = Math.min(PRINT_WIDTH, probe.naturalWidth);
      const h = Math.max(1, Math.round(probe.naturalHeight * w / probe.naturalWidth));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(probe, 0, 0, w, h);
      URL.revokeObjectURL(probe.src);
      addPhoto({ name: file.name, src: c.toDataURL('image/jpeg', 0.9) }).then(resolve, reject);
    };
    probe.onerror = () => { URL.revokeObjectURL(probe.src); reject(new Error('not a readable image')); };
    probe.src = URL.createObjectURL(file);
  });
}

function addPhoto({ id, name, src, width = 100, align = 'center' }) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const photo = { id: id ?? nextPhotoId++, name: name || 'photo', src, img, width, align };
      nextPhotoId = Math.max(nextPhotoId, photo.id + 1);
      photos.set(photo.id, photo);
      resolve(photo);
    };
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = src;
  });
}

$('zinePhotos').onchange = async (e) => {
  for (const f of [...e.target.files]) {
    try { const p = await importPhoto(f); log(`🖼️ Imported ${p.name} as [img:${p.id}].`); }
    catch (err) { log(`❌ ${f.name}: ${err.message}`); }
  }
  e.target.value = '';
  renderTray();
  updatePreview();
  saveDraft();
};

function insertToken(id) {
  const ta = $('zineText');
  const before = ta.value.slice(0, ta.selectionStart);
  const after = ta.value.slice(ta.selectionEnd);
  const chunk = `${before && !before.endsWith('\n') ? '\n' : ''}[img:${id}]\n`;
  ta.value = before + chunk + after;
  const caret = (before + chunk).length;
  ta.focus();
  ta.setSelectionRange(caret, caret);
  updatePreview();
  saveDraft();
}

function renderTray() {
  const tray = $('photoTray');
  tray.textContent = '';
  if (!photos.size) {
    const hint = document.createElement('div');
    hint.className = 'note';
    hint.textContent = 'No photos yet.';
    tray.append(hint);
    return;
  }
  for (const ph of photos.values()) {
    const row = document.createElement('div');
    row.className = 'photo';

    const thumb = document.createElement('img');
    thumb.src = ph.src;
    thumb.alt = ph.name;

    const mid = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'note';
    title.textContent = `[img:${ph.id}] ${ph.name}`;
    const wLabel = document.createElement('label');
    wLabel.textContent = `Width ${ph.width}%`;
    const controls = document.createElement('div');
    controls.className = 'row';
    const wIn = document.createElement('input');
    wIn.type = 'range'; wIn.min = 20; wIn.max = 100; wIn.step = 5; wIn.value = ph.width;
    wIn.oninput = () => {
      ph.width = +wIn.value;
      wLabel.textContent = `Width ${ph.width}%`;
      updatePreview();
      saveDraft();
    };
    const aIn = document.createElement('select');
    for (const a of ['left', 'center', 'right']) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      aIn.append(o);
    }
    aIn.value = ph.align;
    aIn.onchange = () => { ph.align = aIn.value; updatePreview(); saveDraft(); };
    controls.append(wIn, aIn);
    mid.append(title, wLabel, controls);

    const btns = document.createElement('div');
    btns.className = 'btns';
    const ins = document.createElement('button');
    ins.textContent = 'Insert';
    ins.onclick = () => insertToken(ph.id);
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.onclick = () => { photos.delete(ph.id); renderTray(); updatePreview(); saveDraft(); };
    btns.append(ins, del);

    row.append(thumb, mid, btns);
    tray.append(row);
  }
}

// --- saving -----------------------------------------------------------------
function docFromUI() {
  return {
    v: 1,
    text: $('zineText').value,
    fontSize: +$('zineFont').value,
    align: $('zineAlign').value,
    pageSize: $('pageSize').value,
    pageMM: +$('pageMM').value,
    pageNumbers: $('pageNums').checked,
    separator: $('pageLine').checked,
    photos: [...photos.values()].map(({ id, name, src, width, align }) => ({ id, name, src, width, align })),
  };
}

async function applyDoc(doc) {
  $('zineText').value = doc.text ?? '';
  if (doc.fontSize) $('zineFont').value = doc.fontSize;
  if (doc.align) $('zineAlign').value = doc.align;
  if (doc.pageSize) $('pageSize').value = doc.pageSize;
  if (doc.pageMM) $('pageMM').value = doc.pageMM;
  $('pageNums').checked = !!doc.pageNumbers;
  $('pageLine').checked = !!doc.separator;
  photos.clear();
  nextPhotoId = 1;
  for (const p of doc.photos ?? []) {
    try { await addPhoto(p); } catch { log(`⚠️ Dropped unreadable photo ${p.name || p.id}.`); }
  }
  syncPageControls();
  renderTray();
  updatePreview();
}

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

function writeStore(store) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; }
  catch (e) {
    log(`❌ Save failed (${e.name}) — browser storage is full. Export to a file instead.`);
    return false;
  }
}

function refreshZineList(select) {
  const names = Object.keys(readStore()).sort();
  const list = $('zineList');
  list.textContent = '';
  if (!names.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '(no saved zines)';
    list.append(o);
    return;
  }
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    list.append(o);
  }
  if (select && names.includes(select)) list.value = select;
}

let draftTimer = null;
function saveDraft() {
  if (!ready) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(docFromUI())); }
    catch { /* quota — the explicit Save button reports it */ }
  }, 500);
}

$('zineSave').onclick = () => {
  const name = $('zineName').value.trim() || $('zineList').value;
  if (!name) { log('Name the zine before saving.'); return; }
  const store = readStore();
  if (store[name] && !confirm(`Overwrite "${name}"?`)) return;
  store[name] = docFromUI();
  if (!writeStore(store)) return;
  $('zineName').value = name;
  refreshZineList(name);
  log(`💾 Saved "${name}".`);
};

$('zineLoad').onclick = async () => {
  const name = $('zineList').value;
  const doc = readStore()[name];
  if (!doc) { log('Nothing to load.'); return; }
  await applyDoc(doc);
  $('zineName').value = name;
  saveDraft();
  log(`📂 Loaded "${name}".`);
};

$('zineDelete').onclick = () => {
  const name = $('zineList').value;
  if (!name || !confirm(`Delete "${name}"?`)) return;
  const store = readStore();
  delete store[name];
  writeStore(store);
  refreshZineList();
  log(`🗑️ Deleted "${name}".`);
};

$('zineExport').onclick = () => {
  const name = $('zineName').value.trim() || 'zine';
  const blob = new Blob([JSON.stringify(docFromUI(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w.-]+/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  log(`⬇️ Exported ${a.download}.`);
};

$('zineImportBtn').onclick = () => $('zineImport').click();
$('zineImport').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const doc = JSON.parse(await f.text());
    await applyDoc(doc);
    $('zineName').value = f.name.replace(/\.json$/i, '');
    saveDraft();
    log(`📂 Imported ${f.name}.`);
  } catch (err) { log(`❌ Import failed: ${err.message}`); }
};

// Keep the working copy across reloads, without clobbering it on first paint.
['zineText', 'zineFont', 'zineAlign', 'pageSize', 'pageMM', 'pageNums', 'pageLine']
  .forEach((id) => $(id).addEventListener('change', saveDraft));
$('zineText').addEventListener('input', saveDraft);

// --- preview: build the exact 1-bit lines and show them ---------------------
let lastLines = null;
function updatePreview() {
  // Reflect live values in the labels.
  $('fsVal').textContent = $('fontSize').value;
  $('brVal').textContent = $('brightness').value;
  $('coVal').textContent = (+$('contrast').value).toFixed(2);
  $('enVal').textContent = $('energy').value;
  $('feedVal').textContent = $('feed').value;

  let canvas;
  if (activeTab === 'text') {
    canvas = renderZine($('text').value || ' ', {
      fontSize: +$('fontSize').value,
      align: $('align').value,
    });
  } else if (activeTab === 'zine') {
    $('zineFsVal').textContent = $('zineFont').value;
    canvas = renderZine($('zineText').value || ' ', {
      fontSize: +$('zineFont').value,
      align: $('zineAlign').value,
      pageHeight: pageHeightDots(),
      pageNumbers: $('pageNums').checked,
      separator: $('pageLine').checked,
      photos,
    });
    describeZine(canvas);
  } else if (activeTab === 'qr') {
    canvas = renderQR($('qrtext').value, {
      ecc: $('qrEcc').value,
      caption: $('qrCaption').checked,
    });
  } else if (activeTab === 'photobooth') {
    $('pbCoVal').textContent = (+$('pbContrast').value).toFixed(2);
    if (!capturedCanvas) {
      lastLines = null;
      const pv = $('preview'); pv.width = 384; pv.height = 40;
      pv.getContext('2d').clearRect(0, 0, pv.width, pv.height);
      return;
    }
    canvas = renderImage(capturedCanvas);
  } else {
    if (!currentImg) { lastLines = null; return; }
    canvas = renderImage(currentImg);
  }

  // Photos (image/photobooth) → dither; QR/text are already crisp → threshold.
  const isPhoto = activeTab === 'image' || activeTab === 'photobooth';
  const bits = dither(canvas, {
    brightness: +$('brightness').value,
    contrast: activeTab === 'photobooth' ? +$('pbContrast').value : +$('contrast').value,
    mode: activeTab === 'image' ? $('mode').value : (isPhoto ? 'dither' : 'threshold'),
  });
  lastLines = packLines(bits, canvas.width, canvas.height);

  const pv = $('preview');
  pv.width = canvas.width; pv.height = canvas.height;
  pv.getContext('2d').drawImage(canvas, 0, 0);
}

// Re-render preview on any control change.
['text', 'fontSize', 'align', 'brightness', 'contrast', 'mode', 'energy', 'feed',
  'qrtext', 'qrEcc', 'qrCaption', 'pbContrast', 'camCrop',
  'pageSize', 'pageMM', 'pageNums', 'pageLine', 'zineText', 'zineFont', 'zineAlign']
  .forEach((id) => { const el = $(id); el.addEventListener('input', updatePreview); el.addEventListener('change', updatePreview); });

// --- print ------------------------------------------------------------------
$('print').onclick = async () => {
  if (!lastLines || !lastLines.length) { log('Nothing to print.'); return; }
  $('print').disabled = true;
  try {
    await printer.print(lastLines, {
      energy: +$('energy').value / 100,
      feed: +$('feed').value,
    });
  } catch (e) { log(`❌ ${e.message}`); }
  finally { $('print').disabled = !printer.connected; }
};

setConnected(false);
syncPageControls();
renderTray();
updatePreview();

// Restore the last working copy, then start tracking edits.
(async () => {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (draft) { await applyDoc(draft); log('📂 Restored your last zine draft.'); }
  } catch { /* no usable draft */ }
  refreshZineList();
  ready = true;
})();
