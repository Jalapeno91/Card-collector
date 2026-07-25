// Generates the PWA icons from code so the repo carries no binary blobs that
// nobody can edit. Run: node scripts/make-icons.mjs
//
// Draws at 4x and box-downsamples, which is enough antialiasing for rounded
// corners at icon sizes, then writes PNGs using only node's built-in zlib.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SS = 4; // supersampling factor

const INK = [0x1b, 0x1f, 0x2b];
const BRASS = [0xc9, 0xa2, 0x27];
const BRASS_DIM = [0x8c, 0x76, 0x27];

/* ── drawing ────────────────────────────────────────────────────────────── */

function canvas(size){
  return { size, px: new Uint8Array(size * size * 4) };
}

function fill(c, rgb){
  for (let i = 0; i < c.size * c.size; i++){
    c.px[i*4] = rgb[0]; c.px[i*4+1] = rgb[1]; c.px[i*4+2] = rgb[2]; c.px[i*4+3] = 255;
  }
}

function blend(c, x, y, rgb){
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  c.px[i] = rgb[0]; c.px[i+1] = rgb[1]; c.px[i+2] = rgb[2]; c.px[i+3] = 255;
}

// Rounded rectangle in normalized (0..1) coordinates.
function roundedRect(c, nx, ny, nw, nh, nr, rgb){
  const s = c.size;
  const x0 = nx*s, y0 = ny*s, w = nw*s, h = nh*s, r = nr*s;
  const x1 = x0 + w, y1 = y0 + h;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++){
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++){
      // Distance to the inner rect that the corner radius rounds around.
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx*dx + dy*dy <= r*r) blend(c, x, y, rgb);
    }
  }
}

function circle(c, ncx, ncy, nr, rgb){
  const s = c.size;
  const cx = ncx*s, cy = ncy*s, r = nr*s;
  for (let y = Math.floor(cy-r); y < Math.ceil(cy+r); y++){
    for (let x = Math.floor(cx-r); x < Math.ceil(cx+r); x++){
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx*dx + dy*dy <= r*r) blend(c, x, y, rgb);
    }
  }
}

function downsample(src, factor){
  const size = src.size / factor;
  const out = canvas(size);
  for (let y = 0; y < size; y++){
    for (let x = 0; x < size; x++){
      let r=0, g=0, b=0;
      for (let sy = 0; sy < factor; sy++){
        for (let sx = 0; sx < factor; sx++){
          const i = ((y*factor+sy) * src.size + (x*factor+sx)) * 4;
          r += src.px[i]; g += src.px[i+1]; b += src.px[i+2];
        }
      }
      const n = factor*factor;
      const i = (y*size + x)*4;
      out.px[i] = Math.round(r/n); out.px[i+1] = Math.round(g/n); out.px[i+2] = Math.round(b/n); out.px[i+3] = 255;
    }
  }
  return out;
}

// Two offset cards, back one dimmed — legible down to a 32px favicon.
function drawEmblem(c, scale){
  const mid = 0.5;
  const at = (v) => mid + (v - mid) * scale;
  const len = (v) => v * scale;

  roundedRect(c, at(0.24), at(0.22), len(0.34), len(0.48), len(0.045), BRASS_DIM);
  roundedRect(c, at(0.42), at(0.30), len(0.34), len(0.48), len(0.045), BRASS);
  circle(c, at(0.59), at(0.54), len(0.072), INK);
}

function makeIcon(size, emblemScale){
  const c = canvas(size * SS);
  fill(c, INK);
  drawEmblem(c, emblemScale);
  return downsample(c, SS);
}

/* ── PNG encoding ───────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf){
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data){
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(c){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.size, 0);
  ihdr.writeUInt32BE(c.size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Each scanline is prefixed with filter type 0 (none).
  const stride = c.size * 4;
  const raw = Buffer.alloc((stride + 1) * c.size);
  for (let y = 0; y < c.size; y++){
    raw[y * (stride + 1)] = 0;
    Buffer.from(c.px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── output ─────────────────────────────────────────────────────────────── */

mkdirSync(join(ROOT, 'icons'), { recursive: true });

const outputs = [
  ['icons/icon-192.png', 192, 1.0],
  ['icons/icon-512.png', 512, 1.0],
  // Maskable icons get cropped to a circle on some launchers, so the emblem
  // shrinks into the safe zone.
  ['icons/icon-maskable-512.png', 512, 0.68],
];

for (const [path, size, scale] of outputs){
  writeFileSync(join(ROOT, path), encodePng(makeIcon(size, scale)));
  console.log(`wrote ${path} (${size}×${size})`);
}
