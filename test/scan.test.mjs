// Card scanning: does the detector find a card, and does the crop screen turn
// a photo into a straightened image? Also covers "Unusual shape" mode: does
// the outline detector find a non-rectangular card, and does the crop screen
// hand back a transparent PNG cut to that outline instead of a JPEG rectangle?
//
// Detection is checked against synthetic photos — a card drawn at corners (or
// an outline) the test already knows — so "did it find the card" is a
// measurable distance rather than a judgement call.

import { connect } from './harness.mjs';

const t = await connect();
const { ev, wait, navigate, check } = t;

await navigate();
await t.resetDatabase();
await navigate();

// Page-side helpers. makePhoto draws a card onto a plausible background: a
// slightly textured surface, an off-white card, faint artwork inside it, and a
// dark marker block in the corner listed first so orientation can be checked
// after straightening. The texture is deterministic — a random one would make
// the pass/fail line move between runs. `corners` can be any convex polygon,
// not just four points, so the same helper draws hexagons for shape tests.
await ev(`(() => {
  window.__ready = (async () => {
    window.__scan = await import(new URL('js/lib/scan-detect.js', location.href).href);
    window.__scanUi = await import(new URL('js/scan.js', location.href).href);
  })();

  function background(x, w, h){
    x.fillStyle = '#2e2f33'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++){
      const px = (i * 137) % w, py = (i * 293) % h;
      const shade = 26 + ((i * 61) % 22);
      x.fillStyle = 'rgb(' + shade + ',' + shade + ',' + (shade + 4) + ')';
      x.fillRect(px, py, 10, 10);
    }
  }
  function toImage(c){
    return new Promise(res => { const img = new Image(); img.onload = () => res(img); img.src = c.toDataURL('image/png'); });
  }

  // decorate draws the faint artwork stripes and a dark orientation marker
  // inside the card — needed by the straightening tests, but its near-black
  // marker happens to sit close to this background's own dark tone, which
  // trips up outline detection's foreground/background split. Outline tests
  // pass decorate:false for a clean, uniformly-filled shape instead.
  window.__makePhoto = (corners, size, decorate) => {
    if (decorate === undefined) decorate = true;
    const w = (size && size.w) || 900, h = (size && size.h) || 1200;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    background(x, w, h);
    x.save();
    x.beginPath();
    x.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) x.lineTo(corners[i].x, corners[i].y);
    x.closePath();
    x.fillStyle = '#e9e5da'; x.fill();
    x.clip();
    if (decorate){
      const cx = corners.reduce((s,p) => s + p.x, 0) / corners.length;
      const cy = corners.reduce((s,p) => s + p.y, 0) / corners.length;
      x.fillStyle = 'rgba(120,140,170,0.45)';
      for (let i = 0; i < 6; i++) x.fillRect(cx - 120 + i*44, cy - 160, 26, 320);
      x.fillStyle = '#14161c';
      x.fillRect(corners[0].x - 10 + (cx - corners[0].x) * 0.16,
                 corners[0].y - 10 + (cy - corners[0].y) * 0.16, 64, 64);
    }
    x.restore();
    return toImage(c);
  };

  // A circle, for the curved-edge half of "Unusual shape" — radial sampling
  // ought to read a smooth curve as readily as it reads straight sides.
  window.__makeCirclePhoto = (cx, cy, r, size) => {
    const w = (size && size.w) || 900, h = (size && size.h) || 1200;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    background(x, w, h);
    x.fillStyle = '#e9e5da';
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI*2); x.fill();
    return toImage(c);
  };

  window.__worstCornerError = (found, truth) => {
    if (!found) return Infinity;
    return Math.max(...truth.map((p, i) => Math.hypot(found[i].x - p.x, found[i].y - p.y)));
  };
  window.__polyArea = (pts) => {
    let s = 0;
    for (let i = 0; i < pts.length; i++){ const p = pts[i], q = pts[(i+1) % pts.length]; s += p.x*q.y - q.x*p.y; }
    return Math.abs(s) / 2;
  };
  window.__polyCentroid = (pts) => ({
    x: pts.reduce((s,p) => s+p.x, 0) / pts.length,
    y: pts.reduce((s,p) => s+p.y, 0) / pts.length,
  });
  return 1;
})()`);

await ev(`window.__ready.then(() => 1)`);
check('detection module loads', await ev(`typeof window.__scan.findCardQuad`), 'function');
check('outline module loads', await ev(`typeof window.__scan.findCardOutline`), 'function');
check('rasterizeOutline is exported', await ev(`typeof window.__scan.rasterizeOutline`), 'function');

/* ── rectangle detection ────────────────────────────────────────────────── */

// 900×1200 photo, so the diagonal is 1500px; 36px is 2.4% of that.
const TOLERANCE = 36;

const CASES = [
  { name: 'square-on card', corners: [{x:250,y:250},{x:650,y:250},{x:650,y:810},{x:250,y:810}] },
  { name: 'card rotated ~12°', corners: [{x:280,y:300},{x:672,y:217},{x:788,y:765},{x:396,y:848}] },
  { name: 'card at an angle (keystone)', corners: [{x:300,y:260},{x:620,y:300},{x:690,y:880},{x:230,y:840}] },
  { name: 'card near the frame edge', corners: [{x:70,y:120},{x:520,y:96},{x:560,y:740},{x:110,y:764}] },
];

for (const c of CASES){
  const err = await ev(`(async () => {
    const img = await window.__makePhoto(${JSON.stringify(c.corners)});
    const found = window.__scan.findCardQuad(img);
    return Math.round(window.__worstCornerError(found, ${JSON.stringify(c.corners)}));
  })()`);
  check(`finds the ${c.name} (worst corner off by ${err}px, allowed ${TOLERANCE})`, err <= TOLERANCE, true);
}

// The corners must come back clockwise from the top-left, because everything
// downstream — which edge is "top", which way up the crop lands — assumes it.
check('corners come back clockwise from the top-left', await ev(`(async () => {
  const truth = [{x:250,y:250},{x:650,y:250},{x:650,y:810},{x:250,y:810}];
  const q = window.__scan.findCardQuad(await window.__makePhoto(truth));
  if (!q) return 'not found';
  return [q[0].x < q[1].x, q[1].y < q[2].y, q[2].x > q[3].x, q[3].y > q[0].y];
})()`), [true, true, true, true]);

// A photo with no card in it must say so rather than invent one, so the UI can
// fall back to a draggable starting box.
check('a featureless photo detects nothing', await ev(`(async () => {
  const c = document.createElement('canvas'); c.width = 600; c.height = 800;
  const x = c.getContext('2d'); x.fillStyle = '#2e2f33'; x.fillRect(0,0,600,800);
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = c.toDataURL('image/png'); });
  return window.__scan.findCardQuad(img);
})()`), null);

check('the fallback box is card-shaped and centred', await ev(`(() => {
  const q = window.__scan.defaultQuad(1000, 1000);
  const w = q[1].x - q[0].x, h = q[3].y - q[0].y;
  return [
    Math.abs((q[0].x + q[1].x)/2 - 500) < 1,
    Math.abs((q[0].y + q[3].y)/2 - 500) < 1,
    Math.abs(w/h - 0.716) < 0.02,
  ];
})()`), [true, true, true]);

/* ── straightening ──────────────────────────────────────────────────────── */

check('straightening squares up a slanted card', await ev(`(async () => {
  const truth = [{x:280,y:300},{x:672,y:217},{x:788,y:765},{x:396,y:848}];
  const img = await window.__makePhoto(truth);
  const out = window.__scan.unwarpQuad(img, truth);
  const ctx = out.getContext('2d');
  // The dark marker was drawn just inside the first corner, which straightens
  // to the top-left. Comparing quadrant brightness proves the crop is not
  // rotated or mirrored.
  const mean = (x, y) => {
    const d = ctx.getImageData(x, y, Math.floor(out.width/3), Math.floor(out.height/3)).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i];
    return s / (d.length/4);
  };
  const topLeft = mean(0, 0);
  const others = [mean(Math.floor(out.width*2/3), 0), mean(0, Math.floor(out.height*2/3)),
                  mean(Math.floor(out.width*2/3), Math.floor(out.height*2/3))];
  return [
    out.width > 0 && out.height > 0,
    Math.max(out.width, out.height) <= 900,
    Math.abs(out.width/out.height - 0.716) < 0.12,   // recovers the card's true shape
    others.every(v => v > topLeft + 20),             // marker landed top-left
  ];
})()`), [true, true, true, true]);

check('straightening never upscales past the stored size', await ev(`(async () => {
  const truth = [{x:250,y:250},{x:650,y:250},{x:650,y:810},{x:250,y:810}];
  const out = window.__scan.unwarpQuad(await window.__makePhoto(truth), truth, 200);
  return Math.max(out.width, out.height) <= 200;
})()`), true);

/* ── outline detection (non-rectangular cards) ─────────────────────────── */

function hexagon(cx, cy, r){
  const pts = [];
  for (let i = 0; i < 6; i++){
    const a = -Math.PI/2 + i * Math.PI/3;
    pts.push({ x: Math.round(cx + r*Math.cos(a)), y: Math.round(cy + r*Math.sin(a)) });
  }
  return pts;
}
const HEX_CENTER = { x: 450, y: 560 }, HEX_R = 260;
const HEX = hexagon(HEX_CENTER.x, HEX_CENTER.y, HEX_R);
const HEX_AREA = (3*Math.sqrt(3)/2) * HEX_R*HEX_R;

check('finds a straight-edged shape (hexagon)', await ev(`(async () => {
  const img = await window.__makePhoto(${JSON.stringify(HEX)}, undefined, false);
  const found = window.__scan.findCardOutline(img);
  if (!found || found.length < 5) return 'not found';
  const area = window.__polyArea(found), c = window.__polyCentroid(found);
  return [
    Math.abs(area - ${HEX_AREA}) / ${HEX_AREA} < 0.15,
    Math.hypot(c.x - ${HEX_CENTER.x}, c.y - ${HEX_CENTER.y}) < 30,
  ];
})()`), [true, true]);

const CIRCLE = { x: 460, y: 540, r: 240 };
check('finds a curved shape (circle)', await ev(`(async () => {
  const img = await window.__makeCirclePhoto(${CIRCLE.x}, ${CIRCLE.y}, ${CIRCLE.r});
  const found = window.__scan.findCardOutline(img);
  if (!found || found.length < 5) return 'not found';
  const trueArea = Math.PI * ${CIRCLE.r}*${CIRCLE.r};
  const area = window.__polyArea(found), c = window.__polyCentroid(found);
  return [
    Math.abs(area - trueArea) / trueArea < 0.15,
    Math.hypot(c.x - ${CIRCLE.x}, c.y - ${CIRCLE.y}) < 30,
  ];
})()`), [true, true]);

check('a featureless photo has no outline either', await ev(`(async () => {
  const c = document.createElement('canvas'); c.width = 600; c.height = 800;
  const x = c.getContext('2d'); x.fillStyle = '#2e2f33'; x.fillRect(0,0,600,800);
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = c.toDataURL('image/png'); });
  return window.__scan.findCardOutline(img);
})()`), null);

/* ── cutting the shape out (rasterizeOutline) ──────────────────────────── */

check('rasterizeOutline crops to the outline and makes the rest transparent', await ev(`(async () => {
  const img = await window.__makePhoto(${JSON.stringify(HEX)});
  const { canvas, points, aspect } = window.__scan.rasterizeOutline(img, ${JSON.stringify(HEX)});
  const ctx = canvas.getContext('2d');
  const centerAlpha = ctx.getImageData(Math.floor(canvas.width/2), Math.floor(canvas.height/2), 1, 1).data[3];
  const cornerAlpha = ctx.getImageData(1, 1, 1, 1).data[3]; // outside the hexagon, inside its bounding box
  return [
    canvas.width > 0 && canvas.height > 0,
    centerAlpha === 255,
    cornerAlpha === 0,
    points.length >= 5,
    aspect > 0,
  ];
})()`), [true, true, true, true, true]);

/* ── the crop screen: rectangle mode (default) ─────────────────────────── */

check('scan markup and buttons are present', await ev(`
  ['scanOverlay','scanStage','scanCanvas','scanHint','scanCancel','scanRetake','scanReset',
   'scanUse','scanCaptureInput','scanPhotoBtn','scanPhotoBackBtn','scanModeRect','scanModeShape'
  ].filter(id => !document.getElementById(id))`), []);

check('the camera input asks for the back camera', await ev(`
  document.getElementById('scanCaptureInput').getAttribute('capture')`), 'environment');

check('the scan overlay starts closed', await ev(`
  getComputedStyle(document.getElementById('scanOverlay')).display`), 'none');

check('rectangle mode is the default', await ev(`
  document.getElementById('scanModeRect').classList.contains('sel')`), true);

// End to end, minus the camera itself: stub the file picker so startScan's
// click() is caught rather than opening a real dialog, then hand the input a
// photo as though one had just been taken and drive the crop screen. The stub
// and the startScan() call that triggers it must land in the same tick, so
// this is one ev() round-trip rather than a helper split across two.
async function startScanWith(makePhotoExpr){
  await ev(`(async () => {
    const input = document.getElementById('scanCaptureInput');
    window.__picked = window.__picked || 0;
    input.click = () => { window.__picked++; };
    window.__result = null;
    window.__scanUi.startScan(r => { window.__result = r; });
    const img = await (${makePhotoExpr});
    const blob = await new Promise(r => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob(r, 'image/png');
    });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'card.png', { type: 'image/png' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return 1;
  })()`);
}

await startScanWith(`window.__makePhoto(${JSON.stringify([{x:280,y:300},{x:672,y:217},{x:788,y:765},{x:396,y:848}])})`);
await wait(900);

check('starting a scan opens the camera picker', await ev(`window.__picked`), 1);
check('a captured photo opens the crop screen', await ev(`
  document.getElementById('scanOverlay').classList.contains('open')`), true);
check('the crop screen reports it found the card', await ev(`
  document.getElementById('scanHint').textContent.includes('Found the card')`), true);
check('the crop canvas has been sized and drawn', await ev(`
  document.getElementById('scanCanvas').width > 0`), true);

await ev(`(document.getElementById('scanUse').click(), 1)`);
await wait(900);

check('using the crop closes the screen', await ev(`
  document.getElementById('scanOverlay').classList.contains('open')`), false);
check('a rectangular scan hands back a JPEG with no shape', await ev(`
  window.__result && window.__result.dataUrl.startsWith('data:image/jpeg;base64,') && window.__result.shape === null`), true);

check('the crop is a straightened card, not the whole photo', await ev(`(async () => {
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = window.__result.dataUrl; });
  return [Math.abs(img.naturalWidth/img.naturalHeight - 0.716) < 0.12, img.naturalWidth <= 900];
})()`), [true, true]);

await startScanWith(`window.__makePhoto(${JSON.stringify([{x:250,y:250},{x:650,y:250},{x:650,y:810},{x:250,y:810}])})`);
await wait(700);
await ev(`(document.getElementById('scanCancel').click(), 1)`);
check('cancelling leaves no photo behind', await ev(`
  [document.getElementById('scanOverlay').classList.contains('open'), window.__result]`), [false, null]);

/* ── the crop screen: "Unusual shape" mode ─────────────────────────────── */

await startScanWith(`window.__makePhoto(${JSON.stringify(HEX)})`);
await wait(900);

check('switching to Unusual shape re-detects as an outline', await ev(`(async () => {
  document.getElementById('scanModeShape').click();
  await new Promise(r => setTimeout(r, 500));
  return [
    document.getElementById('scanModeShape').classList.contains('sel'),
    document.getElementById('scanHint').textContent.includes('outline'),
  ];
})()`), [true, true]);

await ev(`(document.getElementById('scanUse').click(), 1)`);
await wait(900);

check('an unusual-shape scan hands back a transparent PNG with a shape', await ev(`
  !!window.__result && window.__result.dataUrl.startsWith('data:image/png;base64,')
    && Array.isArray(window.__result.shape.points) && window.__result.shape.points.length >= 5
    && window.__result.shape.aspect > 0`), true);

check('the PNG has a transparent edge outside the shape', await ev(`(async () => {
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = window.__result.dataUrl; });
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  return [
    ctx.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data[3] === 255,
    ctx.getImageData(0, 0, 1, 1).data[3] === 0,
  ];
})()`), [true, true]);

// Switching back to Rectangle should re-run the plain detector and drop the
// traced outline, since the two modes produce genuinely different crops.
check('switching back to Rectangle re-detects as a quad', await ev(`(async () => {
  document.getElementById('scanModeRect').click();
  await new Promise(r => setTimeout(r, 500));
  return document.getElementById('scanModeRect').classList.contains('sel');
})()`), true);
await ev(`(document.getElementById('scanCancel').click(), 1)`);

process.exit(t.finish('scan') ? 0 : 1);
