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
const EDGE_FRACTION = 0.12; // the strongest 12% of pixels count as edges
const CANDIDATES_PER_AXIS = 8;

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
  const marginX = width * 0.06, marginY = height * 0.06;
  for (const p of quad){
    if (p.x < -marginX || p.x > width + marginX) return false;
    if (p.y < -marginY || p.y > height + marginY) return false;
  }
  if (!isConvex(quad)) return false;

  const area = polygonArea(quad);
  const frac = area / (width * height);
  if (frac < 0.06 || frac > 0.98) return false;

  for (let i = 0; i < 4; i++){
    const prev = quad[(i+3) % 4], here = quad[i], next = quad[(i+1) % 4];
    const v1 = { x: prev.x-here.x, y: prev.y-here.y };
    const v2 = { x: next.x-here.x, y: next.y-here.y };
    const cosA = (v1.x*v2.x + v1.y*v2.y) / (Math.hypot(v1.x,v1.y) * Math.hypot(v2.x,v2.y) || 1);
    if (Math.abs(cosA) > 0.6) return false;   // corner outside roughly 53°–127°
  }

  const top = dist(quad[0], quad[1]), bottom = dist(quad[3], quad[2]);
  const left = dist(quad[0], quad[3]), right = dist(quad[1], quad[2]);
  if (Math.min(top,bottom) / Math.max(top,bottom) < 0.55) return false;
  if (Math.min(left,right) / Math.max(left,right) < 0.55) return false;
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

// Returns the card's four corners in the original photo's coordinates, ordered
// clockwise from the top-left — or null when nothing convincing was found.
export function findCardQuad(img){
  const { canvas, scale } = drawScaled(img, WORK_MAX);
  const width = canvas.width, height = canvas.height;
  if (width < 24 || height < 24) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const gray = blur(grayscale(ctx.getImageData(0, 0, width, height)), width, height, 2);
  const { mag, dir } = sobel(gray, width, height);
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
    if (support < 0.55) continue;
    const score = support * support * Math.sqrt(cand.areaFrac) * shapeBonus(cand.quad);
    if (!best || score > best.score) best = { quad: cand.quad, score };
  }
  if (!best) return null;

  return best.quad.map(p => ({ x: p.x / scale, y: p.y / scale }));
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
