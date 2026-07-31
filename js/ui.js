// Shared primitives: DOM helpers, theming, image handling, toasts.

// Shown in the Sync panel so it is possible to tell, from the outside, whether
// a device has actually picked up a release. Keep in step with sw.js VERSION.
export const BUILD = '2026-07-31.2';

export const EFFECTS = {
  matte:  { label:'Matte',        glyph:'●' },
  shiny:  { label:'Shiny',        glyph:'✦' },
  gold:   { label:'Gold foil',    glyph:'✸' },
  holo:   { label:'Holographic',  glyph:'◈' },
  lenticular: { label:'Lenticular', glyph:'▤' },
};

export const DEFAULT_RARITY_PALETTE = ['#8ab6ff','#a5e0a0','#e0b866','#e08585','#c79cf0','#f0e08a'];

const BASE = { ink:'#1b1f2b', ink2:'#242939', panel:'#2a3040', panel2:'#333a4d', hairline:'#3d4358', accent:'#c9a227' };

export const el = id => document.getElementById(id);
export const uid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
export function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

export function showToast(msg){
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ── color ──────────────────────────────────────────────────────────────── */

function hexToRgb(hex){
  hex = hex.replace('#','');
  if (hex.length===3) hex = hex.split('').map(c=>c+c).join('');
  const num = parseInt(hex,16);
  return { r:(num>>16)&255, g:(num>>8)&255, b:num&255 };
}
function rgbToHex(r,g,b){
  return '#' + [r,g,b].map(v => Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
}
function mixHex(hexA, hexB, t){
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex(a.r+(b.r-a.r)*t, a.g+(b.g-a.g)*t, a.b+(b.b-a.b)*t);
}

export function applyTheme(hex){
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--ink', mixHex(BASE.ink, hex, 0.10));
  root.setProperty('--ink-2', mixHex(BASE.ink2, hex, 0.12));
  root.setProperty('--panel', mixHex(BASE.panel, hex, 0.14));
  root.setProperty('--panel-2', mixHex(BASE.panel2, hex, 0.16));
  root.setProperty('--hairline', mixHex(BASE.hairline, hex, 0.22));
  syncThemeColorMeta();
}
export function resetTheme(){
  const root = document.documentElement.style;
  root.setProperty('--accent', BASE.accent);
  root.setProperty('--ink', BASE.ink);
  root.setProperty('--ink-2', BASE.ink2);
  root.setProperty('--panel', BASE.panel);
  root.setProperty('--panel-2', BASE.panel2);
  root.setProperty('--hairline', BASE.hairline);
  syncThemeColorMeta();
}

// Keeps the phone's status bar in step with the collection theme.
function syncThemeColorMeta(){
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
  if (ink) meta.setAttribute('content', ink);
}

export function randomColor(){
  const palette = ['#c9a227','#7a9cc6','#b8594d','#7ab88a','#a77ac6','#c67aa0','#6cbcb0'];
  return palette[Math.floor(Math.random()*palette.length)];
}

/* ── images ─────────────────────────────────────────────────────────────── */

export function resizeImageToDataUrl(img, maxSide){
  let w = img.width, h = img.height;
  if (w > h && w > maxSide){ h = Math.round(h * (maxSide/w)); w = maxSide; }
  else if (h >= w && h > maxSide){ w = Math.round(w * (maxSide/h)); h = maxSide; }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.78);
}

export function extractDominantColor(img){
  const size = 60;
  const canvas = el('colorCanvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,size,size);
  // cover-fit the image into the square sample so we don't skew toward letterboxed edges
  const scale = Math.max(size/img.width, size/img.height);
  const w = img.width*scale, h = img.height*scale;
  ctx.drawImage(img, (size-w)/2, (size-h)/2, w, h);
  let data;
  try { data = ctx.getImageData(0,0,size,size).data; } catch(e){ return null; }
  const buckets = {};
  for (let i=0;i<data.length;i+=4){
    const r=data[i], g=data[i+1], b=data[i+2], a=data[i+3];
    if (a < 128) continue;
    if (r>235 && g>235 && b>235) continue; // skip near-white background/glare
    if (r<18 && g<18 && b<18) continue;    // skip near-black shadow
    const key = Math.round(r/24)+','+Math.round(g/24)+','+Math.round(b/24);
    if (!buckets[key]) buckets[key] = { count:0, r:0, g:0, b:0 };
    const bucket = buckets[key];
    bucket.count++; bucket.r+=r; bucket.g+=g; bucket.b+=b;
  }
  let best = null;
  Object.values(buckets).forEach(bucket => { if (!best || bucket.count > best.count) best = bucket; });
  if (!best) return null;
  const r = Math.round(best.r/best.count), g = Math.round(best.g/best.count), b = Math.round(best.b/best.count);
  return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}

// Reads a file input into a resized data URL, sharing the load/resize/report
// dance that every photo field in the app was repeating.
export function readImageFile(file, maxSide){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => resolve({ img, dataUrl: resizeImageToDataUrl(img, maxSide), original: ev.target.result });
      img.onerror = () => reject(new Error('Could not load that image'));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}
