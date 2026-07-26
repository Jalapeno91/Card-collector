// Card scanning: does the detector find a card, and does the crop screen turn
// a photo into a straightened image?
//
// Detection is checked against synthetic photos — a card drawn at corners the
// test already knows — so "did it find the card" is a measurable distance
// rather than a judgement call.

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
// the pass/fail line move between runs.
await ev(`(() => {
  window.__ready = (async () => {
    window.__scan = await import(new URL('js/lib/scan-detect.js', location.href).href);
    window.__scanUi = await import(new URL('js/scan.js', location.href).href);
  })();

  window.__makePhoto = (corners, size) => new Promise(res => {
    const w = (size && size.w) || 900, h = (size && size.h) || 1200;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#2e2f33'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++){
      const px = (i * 137) % w, py = (i * 293) % h;
      const shade = 26 + ((i * 61) % 22);
      x.fillStyle = 'rgb(' + shade + ',' + shade + ',' + (shade + 4) + ')';
      x.fillRect(px, py, 10, 10);
    }
    x.save();
    x.beginPath();
    x.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) x.lineTo(corners[i].x, corners[i].y);
    x.closePath();
    x.fillStyle = '#e9e5da'; x.fill();
    x.clip();
    const cx = corners.reduce((s,p) => s + p.x, 0) / 4;
    const cy = corners.reduce((s,p) => s + p.y, 0) / 4;
    x.fillStyle = 'rgba(120,140,170,0.45)';
    for (let i = 0; i < 6; i++) x.fillRect(cx - 120 + i*44, cy - 160, 26, 320);
    x.fillStyle = '#14161c';
    x.fillRect(corners[0].x - 10 + (cx - corners[0].x) * 0.16,
               corners[0].y - 10 + (cy - corners[0].y) * 0.16, 64, 64);
    x.restore();
    const img = new Image();
    img.onload = () => res(img);
    img.src = c.toDataURL('image/png');
  });

  window.__worstCornerError = (found, truth) => {
    if (!found) return Infinity;
    return Math.max(...truth.map((p, i) => Math.hypot(found[i].x - p.x, found[i].y - p.y)));
  };
  return 1;
})()`);

await ev(`window.__ready.then(() => 1)`);
check('detection module loads', await ev(`typeof window.__scan.findCardQuad`), 'function');

/* ── detection ──────────────────────────────────────────────────────────── */

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

/* ── the crop screen ────────────────────────────────────────────────────── */

check('scan markup and buttons are present', await ev(`
  ['scanOverlay','scanStage','scanCanvas','scanHint','scanCancel','scanRetake','scanReset',
   'scanUse','scanCaptureInput','scanPhotoBtn','scanPhotoBackBtn'
  ].filter(id => !document.getElementById(id))`), []);

check('the camera input asks for the back camera', await ev(`
  document.getElementById('scanCaptureInput').getAttribute('capture')`), 'environment');

check('the scan overlay starts closed', await ev(`
  getComputedStyle(document.getElementById('scanOverlay')).display`), 'none');

// End to end, minus the camera itself: stub the file picker, hand the input a
// photo as though one had just been taken, then drive the crop screen.
await ev(`(async () => {
  const input = document.getElementById('scanCaptureInput');
  window.__picked = 0;
  input.click = () => { window.__picked++; };
  window.__result = null;
  window.__scanUi.startScan(url => { window.__result = url; });

  const truth = [{x:280,y:300},{x:672,y:217},{x:788,y:765},{x:396,y:848}];
  const img = await window.__makePhoto(truth);
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
check('using the crop hands back a JPEG data URL', await ev(`
  (window.__result || '').startsWith('data:image/jpeg;base64,')`), true);

check('the crop is a straightened card, not the whole photo', await ev(`(async () => {
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = window.__result; });
  return [Math.abs(img.naturalWidth/img.naturalHeight - 0.716) < 0.12, img.naturalWidth <= 900];
})()`), [true, true]);

check('cancelling leaves no photo behind', await ev(`(async () => {
  const input = document.getElementById('scanCaptureInput');
  window.__result = null;
  window.__scanUi.startScan(url => { window.__result = url; });
  const img = await window.__makePhoto([{x:250,y:250},{x:650,y:250},{x:650,y:810},{x:250,y:810}]);
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
  await new Promise(r => setTimeout(r, 700));
  document.getElementById('scanCancel').click();
  return [document.getElementById('scanOverlay').classList.contains('open'), window.__result];
})()`), [false, null]);

process.exit(t.finish('scan') ? 0 : 1);
