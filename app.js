// app.js — UI glue.
import { CatPrinter } from './printer.js';
import { renderText, renderImage, renderQR, dither, packLines } from './render.js';

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
    ['text', 'image', 'qr', 'photobooth'].forEach((t) => $(`pane-${t}`).classList.toggle('active', activeTab === t));
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
}

$('camStart').onclick = async () => {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1280 }, audio: false });
    const cam = $('cam');
    cam.srcObject = camStream;
    cam.style.display = 'inline-block';
    await cam.play();
    applyMirror();
    $('camShot').disabled = false;
    log('📷 Camera started.');
  } catch (e) { log(`❌ Camera: ${e.message}`); }
};

$('camShot').onclick = () => {
  const cam = $('cam');
  if (!cam.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = cam.videoWidth; c.height = cam.videoHeight;
  const ctx = c.getContext('2d');
  if ($('camMirror').checked) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(cam, 0, 0);
  capturedCanvas = c;
  $('camRetake').disabled = false;
  log('📸 Captured.');
  updatePreview();
};

$('camRetake').onclick = () => { capturedCanvas = null; $('camRetake').disabled = true; updatePreview(); };

function applyMirror() { $('cam').style.transform = $('camMirror').checked ? 'scaleX(-1)' : 'none'; }
$('camMirror').addEventListener('change', applyMirror);

// --- image loading ----------------------------------------------------------
$('file').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => { currentImg = img; updatePreview(); };
  img.src = URL.createObjectURL(f);
};

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
    canvas = renderText($('text').value || ' ', {
      fontSize: +$('fontSize').value,
      align: $('align').value,
    });
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
  'qrtext', 'qrEcc', 'qrCaption', 'pbContrast']
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
updatePreview();
