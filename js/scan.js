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
//
// A second mode handles cards that aren't rectangles: the same photo, but the
// proposal is a traced outline of any shape instead of four corners, and the
// handles it hands back can be dragged, added to, or removed, not just
// nudged. That mode saves a PNG with the area outside the shape made
// transparent, instead of the usual straightened JPEG.

import { el, showToast } from './ui.js';
import { detectCardEdges, unwarpQuad, defaultQuad, findCardOutline, rasterizeOutline, intersect, pointLineDistance } from './lib/scan-detect.js';

const HANDLE_RADIUS = 12;   // drawn size, in CSS pixels
const GRAB_RADIUS = 34;     // how near a finger has to land to catch a handle
const SNAP_RADIUS = 11;     // how near a detected edge/point has to be for a drag to lock onto it
const SNAP_CANDIDATES_PER_AXIS = 3; // only the strongest lines on each axis are snap targets — weak/noisy ones from a loosened detection pass shouldn't grab a finger
const LOUPE_RADIUS = 54;
const LOUPE_ZOOM = 2.6;

let photo = null;      // the full-size Image being cropped
let quad = null;       // its four corners, in photo coordinates
let view = null;       // how photo coordinates map onto the canvas
let dragging = -1;     // index of the corner under the finger, or -1
let pointerId = null;
let onCropped = null;  // what to call with the finished data URL

// What a dragged corner/point can snap to, both in photo coordinates.
// Rectangle mode: the straight lines the detector found (even ones that lost
// out on forming the winning quad). Shape mode: the originally-traced
// outline, frozen at detect time so edits don't chase their own tail.
let detectedLines = [];
let detectedOutline = null;

let shapeMode = false;        // false = rectangle (default), true = a traced outline
let downPoint = null;         // canvas-space pointerdown position, to tell a tap from a drag
let moved = false;
let lastTap = { index: -1, time: 0 }; // double-tap-to-remove bookkeeping, shape mode only

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

  // In shape mode, a faint dot at each edge's midpoint hints that tapping
  // there adds a point — the only way to add one, since there's no menu.
  if (shapeMode){
    for (let i = 0; i < pts.length; i++){
      const a = pts[i], b = pts[(i+1) % pts.length];
      ctx.beginPath();
      ctx.arc((a.x+b.x)/2, (a.y+b.y)/2, HANDLE_RADIUS*0.4, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.fill();
    }
  }

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

// The point on a closed polyline nearest `p`, checking every edge rather
// than just the vertices — used both to find where a tap should insert a
// new shape-mode point, and to snap a shape-mode drag to the originally
// traced outline.
function nearestOnPolyline(p, pts){
  let best = -1, bestDist = Infinity, bestPoint = null;
  for (let i = 0; i < pts.length; i++){
    const a = pts[i], b = pts[(i+1) % pts.length];
    const dx = b.x-a.x, dy = b.y-a.y;
    const t = Math.max(0, Math.min(1, dx||dy ? ((p.x-a.x)*dx + (p.y-a.y)*dy) / (dx*dx+dy*dy) : 0));
    const point = { x: a.x+dx*t, y: a.y+dy*t };
    const d = Math.hypot(point.x - p.x, point.y - p.y);
    if (d < bestDist){ bestDist = d; best = i; bestPoint = point; }
  }
  return { segment: best, point: bestPoint, dist: bestDist };
}

// Locks a rectangle-mode drag onto the detected lines it's closing in on:
// onto their intersection when two are close, onto just the one line
// (sliding freely along it) when only one is, or left alone otherwise.
function snapCorner(p, lines, radiusPhoto){
  // `lines` arrives sorted strongest-first within each axis (scan-detect.js
  // sorts by vote count before handing them over), so slicing here keeps
  // just the lines most likely to be the card's real border.
  const upright = lines.filter(l => l.t < 45 || l.t >= 135).slice(0, SNAP_CANDIDATES_PER_AXIS);
  const across  = lines.filter(l => l.t >= 45 && l.t < 135).slice(0, SNAP_CANDIDATES_PER_AXIS);
  const nearest = (set) => set.reduce((best, l) => {
    const d = pointLineDistance(l, p);
    return (!best || d < best.dist) ? { line: l, dist: d } : best;
  }, null);
  const nu = nearest(upright), na = nearest(across);
  const hitU = nu && nu.dist < radiusPhoto;
  const hitA = na && na.dist < radiusPhoto;

  if (hitU && hitA){
    const corner = intersect(nu.line, na.line);
    if (corner) return corner;
  }
  if (hitU || hitA){
    const { line } = hitU ? nu : na;
    const theta = line.t * Math.PI / 180;
    // Project p onto the line: p minus its (signed) distance along the normal.
    const signedDist = p.x*Math.cos(theta) + p.y*Math.sin(theta) - line.rho;
    return { x: p.x - signedDist*Math.cos(theta), y: p.y - signedDist*Math.sin(theta) };
  }
  return p;
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

    // No handle close enough — in shape mode, a tap near an edge inserts a
    // new point there instead, which the same gesture then drags into place.
    if (nearest < 0 && shapeMode){
      const pts = quad.map(toCanvas);
      const { segment, dist } = nearestOnPolyline(p, pts);
      if (segment >= 0 && dist < GRAB_RADIUS){
        quad.splice(segment+1, 0, toPhoto(p));
        nearest = segment+1;
      }
    }

    if (nearest < 0) return;
    dragging = nearest;
    pointerId = e.pointerId;
    downPoint = p;
    moved = false;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    draw();
  };

  canvas.onpointermove = (e) => {
    if (dragging < 0 || e.pointerId !== pointerId) return;
    const local = localPoint(e);
    if (downPoint && Math.hypot(local.x-downPoint.x, local.y-downPoint.y) > 4) moved = true;
    let p = toPhoto(local);
    const radiusPhoto = SNAP_RADIUS / view.scale;
    if (shapeMode){
      if (detectedOutline && detectedOutline.length){
        const near = nearestOnPolyline(p, detectedOutline);
        if (near.dist < radiusPhoto) p = near.point;
      }
    } else if (detectedLines.length){
      p = snapCorner(p, detectedLines, radiusPhoto);
    }
    quad[dragging] = {
      x: Math.max(0, Math.min(photo.naturalWidth, p.x)),
      y: Math.max(0, Math.min(photo.naturalHeight, p.y)),
    };
    e.preventDefault();
    draw();
  };

  const release = (e) => {
    if (e.pointerId !== pointerId) return;
    // A tap (not a drag) on a point, twice within 400ms, removes it — shape
    // mode only, and never below a triangle.
    if (shapeMode && !moved && dragging >= 0 && quad.length > 3){
      const now = performance.now();
      if (lastTap.index === dragging && now - lastTap.time < 400){
        quad.splice(dragging, 1);
        lastTap = { index: -1, time: 0 };
      } else {
        lastTap = { index: dragging, time: now };
      }
    }
    dragging = -1;
    pointerId = null;
    downPoint = null;
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
  downPoint = null; moved = false; lastTap = { index: -1, time: 0 };
  detectedLines = []; detectedOutline = null;
  setShapeMode(false);
  el('scanCaptureInput').value = '';
}

function setShapeMode(on){
  shapeMode = on;
  el('scanModeRect').classList.toggle('sel', !on);
  el('scanModeShape').classList.toggle('sel', on);
}

async function detect(){
  setHint(shapeMode ? 'Tracing the outline…' : 'Finding the card…');
  await nextFrame();
  let found = null;
  detectedLines = [];
  detectedOutline = null;
  try{
    if (shapeMode){
      found = findCardOutline(photo);
      if (found) detectedOutline = found.map(p => ({ x: p.x, y: p.y }));
    } else {
      const edges = detectCardEdges(photo);
      found = edges.quad;
      detectedLines = edges.lines;
    }
  }catch(e){ found = null; }
  quad = found || defaultQuad(photo.naturalWidth, photo.naturalHeight);
  setHint(found
    ? (shapeMode ? 'Traced an outline — drag points to fix it, tap an edge to add one, tap a point twice to remove it'
                 : 'Found the card — drag a corner if it needs nudging')
    : (shapeMode ? "Couldn't trace an outline — drag the points to match your card, shot flat-on works best"
                 : "Couldn't pick out the card — drag the corners to match it"));
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

el('scanModeRect').onclick = () => { if (photo && shapeMode){ setShapeMode(false); detect(); } };
el('scanModeShape').onclick = () => { if (photo && !shapeMode){ setShapeMode(true); detect(); } };

el('scanUse').onclick = async () => {
  if (!photo || !quad) return;
  setHint(shapeMode ? 'Cutting out the shape…' : 'Straightening…');
  await nextFrame();
  try{
    const done = onCropped;
    if (shapeMode){
      const { canvas: cropped, points, aspect } = rasterizeOutline(photo, quad);
      const dataUrl = cropped.toDataURL('image/png');
      close();
      if (done) done({ dataUrl, shape: { points, aspect } });
    } else {
      const cropped = unwarpQuad(photo, quad);
      const dataUrl = cropped.toDataURL('image/jpeg', 0.82);
      close();
      if (done) done({ dataUrl, shape: null });
    }
  }catch(err){
    setHint(shapeMode ? 'That shape could not be cut out — try adjusting the points'
                       : 'That crop could not be straightened — try adjusting the corners');
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

// Opens the camera, then the crop screen. `handler` receives
// `{ dataUrl, shape }` — `shape` is `null` for an ordinary rectangular scan,
// or `{ points }` (normalized 0–1 outline points) when the user chose
// "Unusual shape". It is never called if the camera is dismissed.
export function startScan(handler){
  onCropped = handler;
  el('scanCaptureInput').value = '';
  el('scanCaptureInput').click();
}
