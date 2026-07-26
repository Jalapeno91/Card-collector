// "Scan card": take a photo, confirm where the card is, keep only the card.
//
// The flow is deliberately the phone's own camera rather than a live preview
// inside the app. The camera app is the one the phone has tuned for focus and
// exposure, it needs no permission prompt of ours, and the same button still
// works for a photo already in the gallery.
//
// What comes back is handed to js/lib/scan-detect.js, which proposes four
// corners. Detection is a guess, so the corners are always shown as draggable
// handles: a wrong guess costs a nudge rather than a retake.

import { el, showToast } from './ui.js';
import { findCardQuad, unwarpQuad, defaultQuad } from './lib/scan-detect.js';

const HANDLE_RADIUS = 12;   // drawn size, in CSS pixels
const GRAB_RADIUS = 34;     // how near a finger has to land to catch a handle
const LOUPE_RADIUS = 54;
const LOUPE_ZOOM = 2.6;

let photo = null;      // the full-size Image being cropped
let quad = null;       // its four corners, in photo coordinates
let view = null;       // how photo coordinates map onto the canvas
let dragging = -1;     // index of the corner under the finger, or -1
let pointerId = null;
let onCropped = null;  // what to call with the finished data URL

/* ── loading ────────────────────────────────────────────────────────────── */

function loadImage(file){
  return new Promise((resolve, reject) => {
    // An object URL rather than a data URL: phone photos are large, and this
    // avoids base64-ing several megabytes just to decode them.
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')); };
    img.src = url;
  });
}

function setHint(text){ el('scanHint').textContent = text; }

// Yields to the browser so a hint can actually paint before the work that
// follows blocks the main thread.
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

/* ── laying the photo out on the canvas ─────────────────────────────────── */

function measure(){
  const canvas = el('scanCanvas');
  const stage = el('scanStage');
  const cssW = Math.max(1, stage.clientWidth);
  const cssH = Math.max(1, stage.clientHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const iw = photo.naturalWidth, ih = photo.naturalHeight;
  const scale = Math.min(cssW / iw, cssH / ih);
  view = {
    dpr, scale,
    offsetX: (cssW - iw*scale) / 2,
    offsetY: (cssH - ih*scale) / 2,
  };
}

const toCanvas = p => ({ x: view.offsetX + p.x*view.scale, y: view.offsetY + p.y*view.scale });
const toPhoto  = p => ({ x: (p.x - view.offsetX) / view.scale, y: (p.y - view.offsetY) / view.scale });

/* ── drawing ────────────────────────────────────────────────────────────── */

function draw(){
  if (!photo || !view) return;
  const canvas = el('scanCanvas');
  const ctx = canvas.getContext('2d');
  const cssW = canvas.width / view.dpr, cssH = canvas.height / view.dpr;

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.drawImage(photo, view.offsetX, view.offsetY,
    photo.naturalWidth * view.scale, photo.naturalHeight * view.scale);

  const pts = quad.map(toCanvas);

  // Everything outside the quad is dimmed. One path holding both the full
  // canvas and the quad, filled even-odd, leaves the card as the bright hole.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, cssW, cssH);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(12,14,20,0.66)';
  ctx.fill('evenodd');
  ctx.restore();

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c9a227';

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI*2);
    ctx.fillStyle = i === dragging ? accent : 'rgba(18,21,28,0.85)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  });

  if (dragging >= 0) drawLoupe(ctx, pts[dragging], cssW, cssH);
}

// A finger covers the very corner it is placing. The loupe shows that spot
// magnified, parked in whichever half of the screen the finger is not in.
function drawLoupe(ctx, at, cssW, cssH){
  const cx = cssW / 2;
  const cy = at.y < cssH/2 ? cssH - LOUPE_RADIUS - 18 : LOUPE_RADIUS + 18;
  const src = quad[dragging];

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, LOUPE_RADIUS, 0, Math.PI*2);
  ctx.clip();
  ctx.fillStyle = '#0c0e14';
  ctx.fillRect(cx - LOUPE_RADIUS, cy - LOUPE_RADIUS, LOUPE_RADIUS*2, LOUPE_RADIUS*2);

  const zoom = view.scale * LOUPE_ZOOM;
  ctx.drawImage(photo,
    cx - src.x*zoom, cy - src.y*zoom,
    photo.naturalWidth * zoom, photo.naturalHeight * zoom);

  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
  ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, LOUPE_RADIUS, 0, Math.PI*2);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/* ── dragging the corners ───────────────────────────────────────────────── */

function localPoint(e){
  const rect = el('scanCanvas').getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function bindCanvas(){
  const canvas = el('scanCanvas');

  canvas.onpointerdown = (e) => {
    if (!quad || pointerId !== null) return;
    const p = localPoint(e);
    let nearest = -1, bestDist = GRAB_RADIUS;
    quad.map(toCanvas).forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestDist){ bestDist = d; nearest = i; }
    });
    if (nearest < 0) return;
    dragging = nearest;
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    draw();
  };

  canvas.onpointermove = (e) => {
    if (dragging < 0 || e.pointerId !== pointerId) return;
    const p = toPhoto(localPoint(e));
    quad[dragging] = {
      x: Math.max(0, Math.min(photo.naturalWidth, p.x)),
      y: Math.max(0, Math.min(photo.naturalHeight, p.y)),
    };
    e.preventDefault();
    draw();
  };

  const release = (e) => {
    if (e.pointerId !== pointerId) return;
    dragging = -1;
    pointerId = null;
    draw();
  };
  canvas.onpointerup = release;
  canvas.onpointercancel = release;
}

/* ── the flow ───────────────────────────────────────────────────────────── */

function close(){
  el('scanOverlay').classList.remove('open');
  photo = null; quad = null; view = null;
  dragging = -1; pointerId = null;
  el('scanCaptureInput').value = '';
}

async function detect(){
  setHint('Finding the card…');
  await nextFrame();
  let found = null;
  try{ found = findCardQuad(photo); }
  catch(e){ found = null; }
  quad = found || defaultQuad(photo.naturalWidth, photo.naturalHeight);
  setHint(found
    ? 'Found the card — drag a corner if it needs nudging'
    : "Couldn't pick out the card — drag the corners to match it");
  draw();
}

async function present(file){
  try{
    photo = await loadImage(file);
  }catch(err){
    showToast(err.message);
    return;
  }
  el('scanOverlay').classList.add('open');
  // The overlay has to be on screen before the stage has a size to measure.
  await nextFrame();
  measure();
  await detect();
}

el('scanCaptureInput').onchange = (e) => {
  const file = e.target.files[0];
  if (file) present(file);
};

el('scanCancel').onclick = close;

el('scanRetake').onclick = () => {
  el('scanCaptureInput').value = '';
  el('scanCaptureInput').click();
};

el('scanReset').onclick = () => { if (photo) detect(); };

el('scanUse').onclick = async () => {
  if (!photo || !quad) return;
  setHint('Straightening…');
  await nextFrame();
  try{
    const cropped = unwarpQuad(photo, quad);
    const dataUrl = cropped.toDataURL('image/jpeg', 0.82);
    const done = onCropped;
    close();
    if (done) done(dataUrl);
  }catch(err){
    setHint('That crop could not be straightened — try adjusting the corners');
  }
};

// Orientation changes and the phone's address bar sliding away both resize the
// stage; the quad is stored in photo coordinates, so only the mapping is stale.
window.addEventListener('resize', () => {
  if (!photo) return;
  measure();
  draw();
});

bindCanvas();

// Opens the camera, then the crop screen. `handler` receives the finished
// photo as a data URL; it is never called if the camera is dismissed.
export function startScan(handler){
  onCropped = handler;
  el('scanCaptureInput').value = '';
  el('scanCaptureInput').click();
}
