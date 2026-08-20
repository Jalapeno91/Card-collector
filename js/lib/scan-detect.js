// The maths behind "Scan card".
//
// A phone photo has the card somewhere in frame, at an angle, on whatever
// surface was to hand. Two jobs live here:
//
//   findCardQuad(img)      → the card's four corners, in photo coordinates
//   unwarpQuad(img, quad)  → those corners straightened into a flat rectangle
//
// The approach is the same one document scanners use. Shrink the photo, find
// the pixels where brightness changes sharply (the card's edges against the
// surface), work out which straight lines those pixels fall on, then pick the
// four lines that box in the most convincing card-shaped region.
//
// Nothing here touches the page beyond an offscreen canvas, so it can be tested
// on its own and knows nothing about the scanner UI.

const WORK_MAX = 480;     // detection runs on a small copy: edges survive, noise doesn't
const SAMPLE_MAX = 1800;  // unwarp reads from a copy this size — ample for a 900px result
const OUT_MAX = 900;      // matches the size ordinary card photos are stored at

const THETA_BINS = 180;   // one accumulator column per degree of line angle
const VOTE_SPREAD = 4;    // each edge pixel votes for angles this many degrees either side
const EDGE_FRACTION = 0.15; // the strongest 15% of pixels count as edges
const CANDIDATES_PER_AXIS = 10;
const OUTLINE_SUPPORT_MIN = 0.48; // a candidate quad needs at least this much of its outline sitting on real edge pixels

/* ── image → numbers ────────────────────────────────────────────────────── */

function sourceSize(img){
  return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
}

// Draws the photo into an offscreen canvas no bigger than maxSide, and reports
// the scale used so coordinates can be mapped back to the original.
function drawScaled(img, maxSide){
  const { w: iw, h: ih } = sourceSize(img);
  const scale = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, w, h);
  return { canvas, scale: w / iw };
}

function grayscale(imageData){
  const { data } = imageData;
  const gray = new Float32Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++){
    gray[p] = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
  }
  return gray;
}

// One pass of a 1-D box blur, along rows or columns. Running it four times
// (twice per axis) approximates a gaussian closely enough, and stops the card's
// own artwork from registering as strongly as its outline.
function boxPass(src, width, height, radius, vertical){
  const out = new Float32Array(src.length);
  const lanes = vertical ? width : height;
  const span  = vertical ? height : width;
  const step  = vertical ? width : 1;
  const lane  = vertical ? 1 : width;
  for (let l = 0; l < lanes; l++){
    const base = l * lane;
    let sum = 0, count = 0;
    for (let i = 0; i <= radius && i < span; i++){ sum += src[base + i*step]; count++; }
    for (let i = 0; i < span; i++){
      out[base + i*step] = sum / count;
      const add = i + radius + 1, drop = i - radius;
      if (add < span){ sum += src[base + add*step]; count++; }
      if (drop >= 0){ sum -= src[base + drop*step]; count--; }
    }
  }
  return out;
}

function blur(gray, width, height, radius){
  let buf = gray;
  for (let pass = 0; pass < 2; pass++){
    buf = boxPass(buf, width, height, radius, false);
    buf = boxPass(buf, width, height, radius, true);
  }
  return buf;
}

// Sobel: how sharply brightness changes at each pixel, and in which direction.
// The direction is what lets each pixel vote only for line angles it could
// plausibly belong to, which keeps the next step both faster and cleaner.
function sobel(gray, width, height){
  const mag = new Float32Array(width * height);
  const dir = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++){
    for (let x = 1; x < width - 1; x++){
      const i = y*width + x;
      const tl = gray[i-width-1], t = gray[i-width], tr = gray[i-width+1];
      const l  = gray[i-1],                          r  = gray[i+1];
      const bl = gray[i+width-1], b = gray[i+width], br = gray[i+width+1];
      const gx = (tr + 2*r + br) - (tl + 2*l + bl);
      const gy = (bl + 2*b + br) - (tl + 2*t + tr);
      mag[i] = Math.hypot(gx, gy);
      dir[i] = Math.atan2(gy, gx);
    }
  }
  return { mag, dir };
}

// The magnitude above which a pixel counts as an edge, chosen so that roughly
// `fraction` of the image qualifies. Relative rather than absolute, so a photo
// taken in poor light is judged on its own terms.
function edgeThreshold(mag, fraction){
  let max = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > max) max = mag[i];
  if (max <= 0) return Infinity;
  const BINS = 256;
  const hist = new Int32Array(BINS);
  for (let i = 0; i < mag.length; i++) hist[Math.min(BINS-1, Math.floor(mag[i] / max * (BINS-1)))]++;
  const want = Math.round(mag.length * fraction);
  let seen = 0;
  for (let b = BINS - 1; b >= 0; b--){
    seen += hist[b];
    if (seen >= want) return b / (BINS - 1) * max;
  }
  return 0;
}

/* ── edge pixels → straight lines ───────────────────────────────────────── */

// A Hough transform. Every edge pixel votes for the straight lines that could
// pass through it; lines that collect many votes are the ones really present in
// the photo. A line is held as (angle of its perpendicular, distance from the
// origin) because that can describe vertical lines, which y = mx + c cannot.
function hough(mag, dir, width, height, threshold){
  const diag = Math.ceil(Math.hypot(width, height));
  const rhoBins = 2*diag + 1;
  const acc = new Float32Array(THETA_BINS * rhoBins);
  const cos = new Float32Array(THETA_BINS), sin = new Float32Array(THETA_BINS);
  for (let t = 0; t < THETA_BINS; t++){
    const a = t * Math.PI / THETA_BINS;
    cos[t] = Math.cos(a); sin[t] = Math.sin(a);
  }
  for (let y = 1; y < height - 1; y++){
    for (let x = 1; x < width - 1; x++){
      const i = y*width + x;
      const m = mag[i];
      if (m < threshold) continue;
      const centre = Math.round(dir[i] * THETA_BINS / Math.PI);
      for (let d = -VOTE_SPREAD; d <= VOTE_SPREAD; d++){
        let t = (centre + d) % THETA_BINS;
        if (t < 0) t += THETA_BINS;
        const rho = Math.round(x*cos[t] + y*sin[t]) + diag;
        if (rho < 0 || rho >= rhoBins) continue;
        acc[t*rhoBins + rho] += m;
      }
    }
  }
  return { acc, rhoBins, rhoOffset: diag };
}

// Two accumulator peaks describe the same edge when they agree on angle and
// offset. Angles wrap at 180°, where the offset flips sign — so 179° and 1°
// describe nearly the same orientation, and the comparison has to allow for it.
function sameLine(a, b){
  let dt = Math.abs(a.t - b.t);
  let wrapped = false;
  if (dt > THETA_BINS/2){ dt = THETA_BINS - dt; wrapped = true; }
  if (dt > 6) return false;
  return Math.abs(a.rho - (wrapped ? -b.rho : b.rho)) < 18;
}

function extractLines(h, limit){
  const { acc, rhoBins, rhoOffset } = h;
  let peak = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > peak) peak = acc[i];
  if (peak <= 0) return [];
  const floor = peak * 0.22;

  // Only local maxima are worth ranking — a strong line smears across
  // neighbouring bins, and without this every bin in the smear competes.
  const peaks = [];
  for (let t = 0; t < THETA_BINS; t++){
    const prev = ((t - 1 + THETA_BINS) % THETA_BINS) * rhoBins;
    const next = ((t + 1) % THETA_BINS) * rhoBins;
    const here = t * rhoBins;
    for (let r = 1; r < rhoBins - 1; r++){
      const v = acc[here + r];
      if (v < floor) continue;
      if (v < acc[here + r - 1] || v < acc[here + r + 1]) continue;
      if (v < acc[prev + r] || v < acc[next + r]) continue;
      peaks.push({ t, rho: r - rhoOffset, votes: v });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);

  const kept = [];
  for (const p of peaks){
    if (kept.length >= limit) break;
    if (kept.some(k => sameLine(k, p))) continue;
    kept.push(p);
  }
  return kept;
}

/* ── lines → a quadrilateral ────────────────────────────────────────────── */

function intersect(a, b){
  const ta = a.t * Math.PI / THETA_BINS, tb = b.t * Math.PI / THETA_BINS;
  const ca = Math.cos(ta), sa = Math.sin(ta);
  const cb = Math.cos(tb), sb = Math.sin(tb);
  const det = ca*sb - sa*cb;
  if (Math.abs(det) < 1e-6) return null;   // parallel: no single crossing point
  return { x: (a.rho*sb - sa*b.rho) / det, y: (ca*b.rho - a.rho*cb) / det };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function polygonArea(pts){
  let sum = 0;
  for (let i = 0; i < pts.length; i++){
    const p = pts[i], q = pts[(i+1) % pts.length];
    sum += p.x*q.y - q.x*p.y;
  }
  return Math.abs(sum) / 2;
}

// Clockwise from the top-left, as seen on screen. Every later step — which side
// is "top", which way up the straightened card comes out — depends on this.
function orderCorners(pts){
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y-cy, a.x-cx) - Math.atan2(b.y-cy, b.x-cx));
  let start = 0, best = Infinity;
  sorted.forEach((p, i) => { if (p.x + p.y < best){ best = p.x + p.y; start = i; } });
  return sorted.map((_, i) => sorted[(start + i) % sorted.length]);
}

function isConvex(pts){
  let sign = 0;
  for (let i = 0; i < pts.length; i++){
    const a = pts[i], b = pts[(i+1) % pts.length], c = pts[(i+2) % pts.length];
    const cross = (b.x-a.x)*(c.y-b.y) - (b.y-a.y)*(c.x-b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

// Rejects quads that no photo of a card could produce: corners far outside the
// frame, shapes too small or too slanted, sides that disagree wildly in length.
function plausible(quad, width, height){
  const marginX = width * 0.08, marginY = height * 0.08;
  for (const p of quad){
    if (p.x < -marginX || p.x > width + marginX) return false;
    if (p.y < -marginY || p.y > height + marginY) return false;
  }
  if (!isConvex(quad)) return false;

  const area = polygonArea(quad);
  const frac = area / (width * height);
  if (frac < 0.05 || frac > 0.98) return false;

  for (let i = 0; i < 4; i++){
    const prev = quad[(i+3) % 4], here = quad[i], next = quad[(i+1) % 4];
    const v1 = { x: prev.x-here.x, y: prev.y-here.y };
    const v2 = { x: next.x-here.x, y: next.y-here.y };
    const cosA = (v1.x*v2.x + v1.y*v2.y) / (Math.hypot(v1.x,v1.y) * Math.hypot(v2.x,v2.y) || 1);
    if (Math.abs(cosA) > 0.68) return false;   // corner outside roughly 47°–133°
  }

  const top = dist(quad[0], quad[1]), bottom = dist(quad[3], quad[2]);
  const left = dist(quad[0], quad[3]), right = dist(quad[1], quad[2]);
  if (Math.min(top,bottom) / Math.max(top,bottom) < 0.48) return false;
  if (Math.min(left,right) / Math.max(left,right) < 0.48) return false;
  return true;
}

// How much of the quad's outline actually sits on edge pixels. This is what
// separates the card from, say, the edge of the table crossing behind it: a
// long strong line can win on votes while explaining none of this quad's sides.
function outlineSupport(quad, mag, width, height, threshold){
  const SAMPLES = 32, REACH = 2;
  let hit = 0, total = 0;
  for (let s = 0; s < 4; s++){
    const a = quad[s], b = quad[(s+1) % 4];
    for (let i = 0; i < SAMPLES; i++){
      const t = (i + 0.5) / SAMPLES;
      const px = Math.round(a.x + (b.x-a.x)*t);
      const py = Math.round(a.y + (b.y-a.y)*t);
      total++;
      let found = false;
      for (let dy = -REACH; dy <= REACH && !found; dy++){
        for (let dx = -REACH; dx <= REACH && !found; dx++){
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          if (mag[y*width + x] >= threshold) found = true;
        }
      }
      if (found) hit++;
    }
  }
  return total ? hit / total : 0;
}

// A gentle nudge toward card-shaped rectangles. Trading cards are usually about
// 63×88mm, so a ratio near 0.72 is a little more believable — but only a
// little, because the app should not refuse to scan an unusually shaped card.
function shapeBonus(quad){
  const w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  if (!w || !h) return 1;
  const ratio = Math.min(w, h) / Math.max(w, h);
  return 1 + 0.25 * Math.exp(-Math.pow((ratio - 0.716) / 0.12, 2));
}

// How well a candidate quad matches `foregroundBlob`'s colour-segmented
// silhouette, when there was a trustworthy one to compare against (1, a
// neutral no-op, otherwise). This is what breaks a tie between two
// similarly edge-supported rectangles — a picture frame, a placemat, a
// patterned surface — where more than one is geometrically plausible but
// only one actually sits over the region that differs in colour from what
// is behind it.
function blobAgreement(quad, blob){
  if (!blob || !blob.count) return 1;
  const qCentroid = {
    x: (quad[0].x+quad[1].x+quad[2].x+quad[3].x) / 4,
    y: (quad[0].y+quad[1].y+quad[2].y+quad[3].y) / 4,
  };
  const qArea = polygonArea(quad);
  const scale = Math.sqrt(blob.count) || 1;
  const centroidDist = dist(qCentroid, blob.centroid) / scale;
  const areaRatio = Math.min(qArea, blob.count) / Math.max(qArea, blob.count);
  const centroidTerm = Math.exp(-Math.pow(centroidDist / 0.35, 2));
  return 0.4 + 0.6 * areaRatio * centroidTerm;
}

// Raises `mag` to its own current maximum wherever `mask` (a foregroundBlob
// silhouette) has a boundary, so the Hough transform below is guaranteed to
// treat the colour-segmented outline as real edge pixels even on a low-
// contrast photo where the grayscale gradient there is weak — a white card
// on a pale surface, or a face washed out by glare.
function boostBlobBoundary(mag, mask, width, height){
  let max = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > max) max = mag[i];
  if (!(max > 0)) return;
  for (let y = 0; y < height; y++){
    for (let x = 0; x < width; x++){
      const i = y*width + x;
      const here = mask[i];
      const l = x > 0 ? mask[i-1] : here, r = x < width-1 ? mask[i+1] : here;
      const u = y > 0 ? mask[i-width] : here, d = y < height-1 ? mask[i+width] : here;
      if (here !== l || here !== r || here !== u || here !== d){
        if (mag[i] < max) mag[i] = max;
      }
    }
  }
}

/* ── the public detection call ──────────────────────────────────────────── */

// The crop offered when detection finds nothing to be confident about: a
// card-shaped box in the middle of the frame, ready to be dragged into place.
export function defaultQuad(width, height){
  const RATIO = 0.716;
  let w = width * 0.62;
  let h = w / RATIO;
  // On a square or landscape photo the height is the binding constraint, so fit
  // to that instead — the box stays card-shaped either way.
  if (h > height * 0.82){ h = height * 0.82; w = h * RATIO; }
  const x = (width - w) / 2, y = (height - h) / 2;
  return [{ x, y }, { x: x+w, y }, { x: x+w, y: y+h }, { x, y: y+h }];
}

// Returns the card's four corners in the original photo's coordinates,
// ordered clockwise from the top-left — or null when nothing convincing was
// found. Two independent readings feed this: brightness gradients (good
// wherever the card contrasts sharply with what's under it) and a colour
// segmentation borrowed from findCardOutline below (good wherever the
// contrast is more about colour than brightness, or too faint for gradients
// alone). Neither is trusted on its own — the colour reading only ever
// reinforces edges and breaks ties between rectangles the gradient reading
// already considers plausible, so a photo where it finds nothing changes
// nothing here.
export function findCardQuad(img){
  const { canvas, scale } = drawScaled(img, WORK_MAX);
  const width = canvas.width, height = canvas.height;
  if (width < 24 || height < 24) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, width, height);
  const gray = blur(grayscale(imageData), width, height, 2);
  const { mag, dir } = sobel(gray, width, height);

  const blob = foregroundBlob(imageData.data, width, height, 0.05, 0.98);
  if (blob) boostBlobBoundary(mag, blob.mask, width, height);

  const threshold = edgeThreshold(mag, EDGE_FRACTION);
  if (!Number.isFinite(threshold)) return null;

  const lines = extractLines(hough(mag, dir, width, height, threshold), 30);
  // A line's angle here is that of its perpendicular, so the near-upright lines
  // are the ones whose perpendicular points sideways.
  const upright = lines.filter(l => l.t < 45 || l.t >= 135).slice(0, CANDIDATES_PER_AXIS);
  const across  = lines.filter(l => l.t >= 45 && l.t < 135).slice(0, CANDIDATES_PER_AXIS);
  if (upright.length < 2 || across.length < 2) return null;

  const minGapX = width * 0.15, minGapY = height * 0.15;
  const shortlist = [];
  for (let i = 0; i < upright.length; i++){
    for (let j = i+1; j < upright.length; j++){
      const [v1, v2] = [upright[i], upright[j]];
      for (let k = 0; k < across.length; k++){
        for (let l = k+1; l < across.length; l++){
          const [h1, h2] = [across[k], across[l]];
          const corners = [intersect(v1,h1), intersect(v2,h1), intersect(v2,h2), intersect(v1,h2)];
          if (corners.some(c => !c)) continue;
          const quad = orderCorners(corners);
          if (dist(quad[0], quad[1]) < minGapX && dist(quad[0], quad[3]) < minGapY) continue;
          if (!plausible(quad, width, height)) continue;
          const votes = v1.votes + v2.votes + h1.votes + h2.votes;
          const areaFrac = polygonArea(quad) / (width * height);
          shortlist.push({ quad, prelim: votes * Math.sqrt(areaFrac), areaFrac });
        }
      }
    }
  }
  if (!shortlist.length) return null;

  // Support is the expensive test, so only the geometrically promising quads
  // earn one.
  shortlist.sort((a, b) => b.prelim - a.prelim);
  let best = null;
  for (const cand of shortlist.slice(0, 40)){
    const support = outlineSupport(cand.quad, mag, width, height, threshold);
    if (support < OUTLINE_SUPPORT_MIN) continue;
    const score = support * support * Math.sqrt(cand.areaFrac) * shapeBonus(cand.quad) * blobAgreement(cand.quad, blob);
    if (!best || score > best.score) best = { quad: cand.quad, score };
  }
  if (!best) return null;

  return best.quad.map(p => ({ x: p.x / scale, y: p.y / scale }));
}

/* ── an outline of any shape ────────────────────────────────────────────── */
//
// Some cards aren't rectangles. Rather than fitting straight lines (which by
// definition can't follow a curve), this separates the card from its
// background by colour, then samples that shape's edge at many angles around
// its centre — a technique that reads straight sides and curved ones the
// same way, with no separate code path for either.

const OUTLINE_SAMPLES = 72;     // rays cast from the blob's centre, one per 5°
const OUTLINE_MIN_POINTS = 8;   // fewer surviving rays than this and the trace is too broken to trust
const OUTLINE_AREA_MIN = 0.03;  // plausibility bounds, mirrors plausible()'s area check above
const OUTLINE_AREA_MAX = 0.92;

// Colour statistics of a thin ring around the photo's edge — on the
// assumption that whatever surface the card sits on, that surface (not the
// card) is what a border-hugging ring mostly contains.
function backgroundStats(data, width, height){
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  let n = 0, sr = 0, sg = 0, sb = 0;
  const visit = (x, y, fn) => { const i = (y*width + x) * 4; fn(i); };
  const forRing = (fn) => {
    for (let x = 0; x < width; x++){
      for (let d = 0; d < ring; d++){ visit(x, d, fn); visit(x, height-1-d, fn); }
    }
    for (let y = ring; y < height - ring; y++){
      for (let d = 0; d < ring; d++){ visit(d, y, fn); visit(width-1-d, y, fn); }
    }
  };
  forRing(i => { sr += data[i]; sg += data[i+1]; sb += data[i+2]; n++; });
  const mean = [sr/n, sg/n, sb/n];
  let vr = 0, vg = 0, vb = 0;
  forRing(i => { vr += (data[i]-mean[0])**2; vg += (data[i+1]-mean[1])**2; vb += (data[i+2]-mean[2])**2; });
  // Floored so a near-uniform background (a sheet of paper, a desk) doesn't
  // make the distance test blow up on ordinary compression noise.
  const std = [Math.max(6, Math.sqrt(vr/n)), Math.max(6, Math.sqrt(vg/n)), Math.max(6, Math.sqrt(vb/n))];
  return { mean, std };
}

// How far each pixel's colour sits from the background, in standard
// deviations — a card that contrasts with its background scores high here
// regardless of whether either one is light, dark, or coloured.
function distanceFromBackground(data, width, height, stats){
  const { mean, std } = stats;
  const dist = new Float32Array(width * height);
  for (let p = 0, i = 0; p < dist.length; p++, i += 4){
    const dr = (data[i]-mean[0])/std[0], dg = (data[i+1]-mean[1])/std[1], db = (data[i+2]-mean[2])/std[2];
    dist[p] = Math.sqrt(dr*dr + dg*dg + db*db);
  }
  return dist;
}

// Otsu's method: the split point that best separates a two-humped histogram
// into its two groups. Used here on "distance from background" rather than
// brightness, to turn that distance map into a clean foreground/background
// split without a fixed, guessed threshold.
function otsuThreshold(values){
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  if (max <= 0) return 0;
  const BINS = 256;
  const hist = new Int32Array(BINS);
  for (let i = 0; i < values.length; i++) hist[Math.min(BINS-1, Math.floor(values[i]/max*(BINS-1)))]++;
  const total = values.length;
  let sumAll = 0;
  for (let b = 0; b < BINS; b++) sumAll += b * hist[b];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let b = 0; b < BINS; b++){
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar){ bestVar = between; best = b; }
  }
  return best / (BINS - 1) * max;
}

// Flood-fills every foreground blob, and keeps the largest one that never
// touches the photo's edge — the assumption (stated in the scan hint) is
// that the card is framed with a margin, so whatever's still cut off by the
// frame is background clutter, not the card.
function largestInteriorBlob(mask, width, height){
  const label = new Int32Array(mask.length).fill(-1);
  const marginX = Math.round(width * 0.04), marginY = Math.round(height * 0.04);
  let bestId = -1, bestCount = 0, id = 0;
  const stack = [];
  for (let start = 0; start < mask.length; start++){
    if (mask[start] !== 1 || label[start] !== -1) continue;
    let count = 0, touchesBorder = false;
    stack.length = 0; stack.push(start); label[start] = id;
    while (stack.length){
      const cur = stack.pop();
      const cx = cur % width, cy = (cur / width) | 0;
      count++;
      if (cx < marginX || cx >= width-marginX || cy < marginY || cy >= height-marginY) touchesBorder = true;
      for (const n of [cur-1, cur+1, cur-width, cur+width]){
        if (n < 0 || n >= mask.length) continue;
        if (Math.abs((n % width) - cx) > 1) continue; // guards the cur±1 row-wrap case
        if (mask[n] === 1 && label[n] === -1){ label[n] = id; stack.push(n); }
      }
    }
    if (!touchesBorder && count > bestCount){ bestCount = count; bestId = id; }
    id++;
  }
  if (bestId < 0) return null;
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = label[i] === bestId ? 1 : 0;
  return { mask: out, count: bestCount };
}

function centroidOf(mask, width, height){
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < height; y++){
    for (let x = 0; x < width; x++){
      if (mask[y*width + x] === 1){ sx += x; sy += y; n++; }
    }
  }
  return n ? { x: sx/n, y: sy/n } : null;
}

// Segments the photo into card vs. background by colour and returns its
// largest interior region — the same reading findCardOutline traces a full
// shape from, shared here so the rectangle detector above can lean on it too
// wherever gradients alone are weak or misleading. Returns null wherever
// that reading isn't trustworthy (no clean interior region at a believable
// size), and callers fall back to exactly their prior, colour-blind
// behaviour.
function foregroundBlob(data, width, height, areaMin, areaMax){
  const stats = backgroundStats(data, width, height);
  const dist = distanceFromBackground(data, width, height, stats);
  const threshold = otsuThreshold(dist);
  if (!(threshold > 0)) return null;

  let mask = new Float32Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = dist[i] > threshold ? 1 : 0;
  // A blur-then-rethreshold acts as a majority filter: it closes small holes
  // (glare on a glossy card) and drops single-pixel speckle.
  mask = blur(mask, width, height, 2);
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < binary.length; i++) binary[i] = mask[i] > 0.5 ? 1 : 0;

  const blob = largestInteriorBlob(binary, width, height);
  if (!blob) return null;
  const areaFrac = blob.count / (width * height);
  if (areaFrac < areaMin || areaFrac > areaMax) return null;

  const centroid = centroidOf(blob.mask, width, height);
  if (!centroid) return null;
  return { mask: blob.mask, count: blob.count, centroid };
}

// Walks outward from the centre along `samples` evenly spaced angles,
// keeping the last pixel still inside the mask on each ray. The result is
// already in angular order — a polygon, with no separate step needed to
// stitch boundary pixels into a sequence.
function radialBoundary(mask, width, height, centroid, samples){
  const points = [];
  const maxR = Math.hypot(width, height);
  for (let k = 0; k < samples; k++){
    const theta = (k / samples) * Math.PI * 2;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    let lastInside = null;
    for (let r = 0; r < maxR; r++){
      const x = Math.round(centroid.x + cos*r), y = Math.round(centroid.y + sin*r);
      if (x < 0 || y < 0 || x >= width || y >= height) break;
      if (mask[y*width + x] === 1) lastInside = { x, y };
      else if (lastInside) break; // left the shape after having been inside it
    }
    if (lastInside) points.push(lastInside);
  }
  return points;
}

// Ramer–Douglas–Peucker over an open run of points: drops any point that
// lies within `epsilon` of the straight line between its surviving
// neighbours, so long straight sides collapse toward their two endpoints
// while curved ones keep enough points to still read as curved.
function simplify(points, epsilon){
  if (points.length < 3) return points.slice();
  const sqEpsilon = epsilon * epsilon;
  function sqSegDist(p, a, b){
    let x = a.x, y = a.y, dx = b.x-a.x, dy = b.y-a.y;
    if (dx || dy){
      const t = ((p.x-x)*dx + (p.y-y)*dy) / (dx*dx + dy*dy);
      if (t > 1){ x = b.x; y = b.y; } else if (t > 0){ x += dx*t; y += dy*t; }
    }
    dx = p.x-x; dy = p.y-y;
    return dx*dx + dy*dy;
  }
  function rdp(pts){
    let maxDist = 0, index = -1;
    const a = pts[0], b = pts[pts.length-1];
    for (let i = 1; i < pts.length-1; i++){
      const d = sqSegDist(pts[i], a, b);
      if (d > maxDist){ maxDist = d; index = i; }
    }
    if (index !== -1 && maxDist > sqEpsilon){
      const left = rdp(pts.slice(0, index+1));
      return left.slice(0, -1).concat(rdp(pts.slice(index)));
    }
    return [a, b];
  }
  return rdp(points);
}

// The same simplification, but for a closed loop: split at the loop's two
// most distant points so each half has real anchors to simplify against,
// instead of an arbitrary seam where the point array happens to start.
function simplifyClosed(points, epsilon){
  if (points.length < 5) return points.slice();
  let ia = 0, ib = 1, best = -1;
  for (let i = 0; i < points.length; i++){
    for (let j = i+1; j < points.length; j++){
      const d = (points[i].x-points[j].x)**2 + (points[i].y-points[j].y)**2;
      if (d > best){ best = d; ia = i; ib = j; }
    }
  }
  const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
  const arc1 = simplify(points.slice(lo, hi+1), epsilon);
  const arc2 = simplify(points.slice(hi).concat(points.slice(0, lo+1)), epsilon);
  return arc1.slice(0, -1).concat(arc2.slice(0, -1));
}

// Returns an ordered outline of the card in the original photo's
// coordinates, clockwise from the top-left like findCardQuad — or null when
// nothing convincing was found (the caller falls back to defaultQuad, same
// as it does for the rectangle path).
export function findCardOutline(img){
  const { canvas, scale } = drawScaled(img, WORK_MAX);
  const width = canvas.width, height = canvas.height;
  if (width < 24 || height < 24) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, width, height).data;

  const blob = foregroundBlob(data, width, height, OUTLINE_AREA_MIN, OUTLINE_AREA_MAX);
  if (!blob) return null;

  const raw = radialBoundary(blob.mask, width, height, blob.centroid, OUTLINE_SAMPLES);
  if (raw.length < OUTLINE_MIN_POINTS) return null;

  const epsilon = Math.max(1.5, Math.min(width, height) * 0.006);
  const simplified = simplifyClosed(raw, epsilon);
  if (simplified.length < 5) return null;

  const ordered = orderCorners(simplified);
  return ordered.map(p => ({ x: p.x / scale, y: p.y / scale }));
}

/* ── straightening ──────────────────────────────────────────────────────── */

// Solves the 8 unknowns of the projective transform that maps the flat output
// rectangle onto the slanted quad in the photo. Working in that direction means
// every output pixel can simply ask which source pixel it came from.
function solveHomography(dst, src){
  const rows = [], rhs = [];
  for (let i = 0; i < 4; i++){
    const { x: u, y: v } = dst[i];
    const { x, y } = src[i];
    rows.push([u, v, 1, 0, 0, 0, -u*x, -v*x]); rhs.push(x);
    rows.push([0, 0, 0, u, v, 1, -u*y, -v*y]); rhs.push(y);
  }
  const n = rhs.length;
  const m = rows.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++){
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++){
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

// Straightens the quad out of the photo into a flat, front-on rectangle.
// Returns a canvas so callers can choose their own encoding.
export function unwarpQuad(img, quad, maxSide = OUT_MAX){
  const { canvas: source, scale } = drawScaled(img, SAMPLE_MAX);
  const q = orderCorners(quad).map(p => ({ x: p.x * scale, y: p.y * scale }));

  const wide = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const tall = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const shrink = Math.min(1, maxSide / Math.max(wide, tall));
  const outW = Math.max(1, Math.round(wide * shrink));
  const outH = Math.max(1, Math.round(tall * shrink));

  const dst = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
  const H = solveHomography(dst, q);
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const outCtx = out.getContext('2d');
  if (!H){ outCtx.drawImage(source, 0, 0, outW, outH); return out; }

  const [a, b, c, d, e, f, g, h] = H;
  const srcCtx = source.getContext('2d', { willReadFrequently: true });
  const src = srcCtx.getImageData(0, 0, source.width, source.height);
  const dest = outCtx.createImageData(outW, outH);
  const sw = source.width, sh = source.height;

  for (let y = 0; y < outH; y++){
    for (let x = 0; x < outW; x++){
      const w = g*x + h*y + 1;
      const sx = (a*x + b*y + c) / w;
      const sy = (d*x + e*y + f) / w;
      const o = (y*outW + x) * 4;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1){
        dest.data[o+3] = 255;
        continue;
      }
      // Bilinear sampling: without it the straightened card looks jagged along
      // every edge that was not axis-aligned in the photo.
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0*sw + x0)*4, i10 = (y0*sw + x1)*4;
      const i01 = (y1*sw + x0)*4, i11 = (y1*sw + x1)*4;
      for (let ch = 0; ch < 3; ch++){
        const top = src.data[i00+ch] + (src.data[i10+ch] - src.data[i00+ch]) * fx;
        const bot = src.data[i01+ch] + (src.data[i11+ch] - src.data[i01+ch]) * fx;
        dest.data[o+ch] = top + (bot - top) * fy;
      }
      dest.data[o+3] = 255;
    }
  }
  outCtx.putImageData(dest, 0, 0);
  return out;
}

// Cuts an odd-shaped card out of its photo: crops to the outline's bounding
// box and makes everything outside the outline transparent. There's no
// perspective correction here, unlike unwarpQuad — once the card isn't a
// rectangle there's no longer a known-flat shape in frame to unwarp against,
// so this only handles scale and offset. Returns the cropped canvas, the
// outline re-expressed as 0–1 fractions of that canvas, and that box's true
// width:height ratio — needed separately because normalizing the points to
// their own bounding box, on two axes independently, throws the ratio away.
export function rasterizeOutline(img, points, maxSide = OUT_MAX){
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const boxW = Math.max(1, maxX - minX), boxH = Math.max(1, maxY - minY);
  const shrink = Math.min(1, maxSide / Math.max(boxW, boxH));
  const outW = Math.max(1, Math.round(boxW * shrink)), outH = Math.max(1, Math.round(boxH * shrink));

  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, minX, minY, boxW, boxH, 0, 0, outW, outH);

  // destination-in keeps only the pixels already on the canvas that the new
  // fill also covers — an easy way to punch a photo down to an arbitrary
  // path without touching the pixels that survive.
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = (p.x - minX) * shrink, y = (p.y - minY) * shrink;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  const normalized = points.map(p => [(p.x - minX) / boxW, (p.y - minY) / boxH]);
  return { canvas, points: normalized, aspect: boxW / boxH };
}
