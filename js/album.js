// The Album: the binder drawn as an actual binder — an open book of
// translucent pocket pages that turn.
//
// The physical model is a binder filled from one side only. Each leaf holds
// nine cards in the pockets on its front; turning that leaf shows the same
// nine cards from behind. So spread `s` shows leaf s-1's backs on the left and
// leaf s's fronts on the right, and there is one spread more than there are
// leaves: the last one lays the final leaf's backs against the inside cover.
//
// Because the left page is a leaf seen from behind, its columns run the other
// way — the card at the top left of a page is at the top right of its reverse.
// `mirrorRows` is what keeps that honest.

import { el, escapeHtml } from './ui.js';
import { view, buildBinderSlots, getColl } from './state.js';
import { getBlob, photoKey, photoBackKey } from './store.js';
import { openViewer, goToLinkedCard } from './viewer.js';
import { shapeStyle } from './lib/shape.js';

const PER_LEAF = 9;
const TURN_MS = 620;

// One turn at a time. Without this, a fast double-click starts a second
// animation whose end handler renders a spread the first one has moved past.
let turning = false;

function prefersReducedMotion(){
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function mirrorRows(slots){
  const out = [];
  for (let r = 0; r < 3; r++) out.push(...slots.slice(r*3, r*3+3).reverse());
  return out;
}

/* ── one pocket ─────────────────────────────────────────────────────────── */

// A sleeve is the plastic pocket; what sits inside it depends on the slot and
// on which side of the leaf we are looking at.
function sleeveHtml(inner, attrs = ''){
  return `<div class="sleeve" ${attrs}>
    <div class="sleeve-card">${inner}</div>
    <div class="sleeve-plastic"></div>
  </div>`;
}

function frontPocketHtml(slot, coll){
  if (slot.blank) return sleeveHtml('<div class="pocket-face vacant"></div>');

  if (slot.linked){
    const homeColl = getColl(slot.linked.homeCollId);
    return sleeveHtml(
      `<div class="pocket-face" style="background:linear-gradient(160deg, ${homeColl?homeColl.color:'#555'} 0%, #14161d 85%);">
         <div class="pocket-mono">🔗</div>
         <div class="pocket-name">${escapeHtml(slot.linked.card.name)}</div>
       </div>`,
      `data-linked-coll="${slot.linked.homeCollId}" data-linked-sub="${slot.linked.homeSubId}" data-linked-card="${slot.linked.card.id}"`);
  }

  if (!slot.card){
    return sleeveHtml(
      `<div class="pocket-face vacant">
         <div class="pocket-slot-number">${slot.number!=null ? '#'+slot.number : ''}</div>
       </div>`);
  }

  const c = slot.card;
  const shpFront = shapeStyle(c.shape);
  return sleeveHtml(
    `<div class="pocket-face" data-face="front-${c.id}" style="background:linear-gradient(160deg, ${coll.color} 0%, #14161d 85%);${shpFront ? ` clip-path:${shpFront.clipPath};` : ''}">
       ${c.hasPhoto ? '' : `<div class="pocket-mono">${escapeHtml((c.name||'?').trim().charAt(0).toUpperCase())}</div>`}
       <div class="pocket-name">${escapeHtml(c.name)}</div>
     </div>`,
    `data-id="${c.id}"`);
}

function backPocketHtml(slot, coll){
  if (slot.blank || slot.linked || !slot.card){
    return sleeveHtml('<div class="pocket-face vacant"></div>');
  }
  const c = slot.card;
  // No back photo yet: a generated back in the collection's colour, so the
  // page still reads as a page rather than a grid of holes.
  const shpBack = shapeStyle(c.shape);
  return sleeveHtml(
    `<div class="pocket-face card-back${c.hasBackPhoto ? '' : ' generated'}" data-face="back-${c.id}" style="background:linear-gradient(160deg, #14161d 0%, ${coll.color} 130%);${shpBack ? ` clip-path:${shpBack.clipPath};` : ''}">
       ${c.hasBackPhoto ? '' : '<div class="card-back-mark"></div>'}
     </div>`,
    `data-id="${c.id}"`);
}

/* ── one leaf ───────────────────────────────────────────────────────────── */

function leafHtml(slots, side, coll){
  if (!slots) return '';
  const ordered = side === 'back' ? mirrorRows(slots) : slots;
  const pockets = ordered.map(s => side === 'back' ? backPocketHtml(s, coll) : frontPocketHtml(s, coll)).join('');
  return `<div class="album-leaf ${side==='back'?'is-back':'is-front'}">${pockets}</div>`;
}

function coverHtml(coll, sub, which){
  return `<div class="album-cover">
    <div class="album-cover-plate">
      <div class="album-cover-eyebrow">${escapeHtml(coll.name)}</div>
      <div class="album-cover-title">${escapeHtml(sub.name)}</div>
      <div class="album-cover-note">${which==='front' ? 'inside cover' : 'end of the album'}</div>
    </div>
  </div>`;
}

// Fills in photos once they come back from IndexedDB. Scoped to `root` so the
// leaf being turned and the leaf underneath it never write to each other.
function loadLeafPhotos(root, slots, side){
  if (!slots) return;
  slots.forEach(slot => {
    const c = slot.card;
    if (!c) return;
    const key = side === 'back'
      ? (c.hasBackPhoto ? photoBackKey(c.id) : null)
      : (c.hasPhoto ? photoKey(c.id) : null);
    if (!key) return;
    getBlob(key).then(value => {
      if (!value) return;
      const face = root.querySelector(`.pocket-face[data-face="${side}-${c.id}"]`);
      if (!face) return;
      face.style.backgroundImage = `url(${value})`;
      face.style.backgroundSize = 'cover';
      face.style.backgroundPosition = 'center';
      face.style.backgroundRepeat = 'no-repeat';
    }).catch(() => {});
  });
}

/* ── the view ───────────────────────────────────────────────────────────── */

export function renderAlbumView(coll, sub){
  const groups = buildBinderSlots(coll, sub, view.ledgerRarityFilter);
  const flat = [];
  groups.forEach(g => g.slots.forEach(s => flat.push({ ...s, rarity: g.rarity })));

  const wrap = el('ledgerWrap');

  if (flat.length === 0){
    const hasRarities = (sub.rarities||[]).length > 0;
    wrap.innerHTML = `<div class="empty-state">
      <div class="stamp">${hasRarities ? 'No slots to show' : 'No rarities defined yet'}</div>
      <div>${hasRarities ? 'Try a different rarity filter.' : 'Edit this series to add rarities with a quantity, and the album will fill its pages.'}</div>
    </div>`;
    return;
  }

  // A real page keeps all nine sleeves even when the set runs out part way, so
  // the last leaf is padded rather than short.
  const leaves = [];
  for (let i = 0; i < flat.length; i += PER_LEAF){
    const slots = flat.slice(i, i + PER_LEAF);
    while (slots.length < PER_LEAF) slots.push({ blank: true });
    leaves.push(slots);
  }

  const spreads = leaves.length + 1;
  if (view.albumSpread >= spreads) view.albumSpread = spreads - 1;
  if (view.albumSpread < 0) view.albumSpread = 0;
  const s = view.albumSpread;

  const leftLeaf  = s > 0 ? leaves[s-1] : null;
  const rightLeaf = s < leaves.length ? leaves[s] : null;

  const label = rightLeaf ? `Page ${s+1} of ${leaves.length}` : 'End of the album';

  wrap.innerHTML = `
    <div class="album" data-side="${view.albumMobileSide}">
      <div class="album-book" id="albumBook">
        <div class="album-side album-left" id="albumLeft">
          ${leftLeaf ? leafHtml(leftLeaf, 'back', coll) : coverHtml(coll, sub, 'front')}
        </div>
        <div class="album-spine"><i></i><i></i><i></i></div>
        <div class="album-side album-right" id="albumRight">
          ${rightLeaf ? leafHtml(rightLeaf, 'front', coll) : coverHtml(coll, sub, 'back')}
        </div>
      </div>
      <div class="binder-pager" id="albumPager"></div>
    </div>
  `;

  const leftEl = el('albumLeft');
  const rightEl = el('albumRight');
  loadLeafPhotos(leftEl, leftLeaf, 'back');
  loadLeafPhotos(rightEl, rightLeaf, 'front');

  bindSleeves(wrap, coll, sub);
  paintPager(coll, sub, leaves);
}

// Drawn on its own so it can be brought up to date after a page turn without
// rebuilding the book. It reads view.albumSpread each time rather than a
// spread number captured when the album was last built, so the buttons stay
// honest however the reader got to this page.
function paintPager(coll, sub, leaves){
  const pager = el('albumPager');
  if (!pager) return;

  const s = view.albumSpread;
  const spreads = leaves.length + 1;
  const atStart = s === 0;
  const atEnd = s >= spreads - 1;

  pager.innerHTML = `
    <button id="albumFirst" class="edge" title="First page" ${atStart?'disabled':''}>« First</button>
    <button id="albumPrev" ${atStart?'disabled':''}>‹ Prev</button>
    <span>${s < leaves.length ? `Page ${s+1} of ${leaves.length}` : 'End of the album'}</span>
    <button id="albumNext" ${atEnd?'disabled':''}>Next ›</button>
    <button id="albumLast" class="edge" title="Last page" ${atEnd?'disabled':''}>Last »</button>
    <button id="albumFlip" class="album-flip">${view.albumMobileSide==='right' ? '⟲ See backs' : '⟲ See fronts'}</button>
  `;

  const go = (target) => {
    const from = view.albumSpread;
    if (target === from || target < 0 || target >= spreads) return;
    const step = target > from ? 1 : -1;
    // Only a single-step move is a page turn; First and Last jump.
    if (Math.abs(target - from) === 1 && !prefersReducedMotion()) turnTo(target, step, coll, sub, leaves);
    else { view.albumSpread = target; renderAlbumView(coll, sub); }
  };

  const bind = (id, fn) => { const b = el(id); if (b) b.onclick = fn; };
  bind('albumFirst', () => go(0));
  bind('albumPrev',  () => go(view.albumSpread - 1));
  bind('albumNext',  () => go(view.albumSpread + 1));
  bind('albumLast',  () => go(spreads - 1));
  bind('albumFlip',  () => {
    view.albumMobileSide = view.albumMobileSide === 'right' ? 'left' : 'right';
    renderAlbumView(coll, sub);
  });
}

function bindSleeves(root, coll, sub){
  root.querySelectorAll('.sleeve[data-id]').forEach(p => {
    p.onclick = () => openViewer(coll, sub, p.dataset.id);
  });
  root.querySelectorAll('.sleeve[data-linked-card]').forEach(p => {
    p.onclick = () => goToLinkedCard(p.dataset.linkedColl, p.dataset.linkedSub, p.dataset.linkedCard);
  });
}

/* ── turning a page ─────────────────────────────────────────────────────── */

// The leaf that moves is lifted onto its own layer above the book. The page it
// uncovers is put in place underneath first, so the turn reveals it rather
// than the spread jumping at the end.
function turnTo(target, step, coll, sub, leaves){
  if (turning) return;
  const book = el('albumBook');
  const leftEl = el('albumLeft');
  const rightEl = el('albumRight');
  if (!book || !leftEl || !rightEl){ view.albumSpread = target; renderAlbumView(coll, sub); return; }

  const s = view.albumSpread;
  const movingLeaf = step > 0 ? leaves[s] : leaves[s-1];
  if (!movingLeaf){ view.albumSpread = target; renderAlbumView(coll, sub); return; }

  turning = true;

  const turn = document.createElement('div');
  turn.className = 'album-turn ' + (step > 0 ? 'from-right' : 'from-left');

  if (step > 0){
    // Forward: the right leaf swings left, front face first, landing on its back.
    turn.innerHTML =
      `<div class="album-turn-face a">${leafHtml(movingLeaf, 'front', coll)}</div>` +
      `<div class="album-turn-face b">${leafHtml(movingLeaf, 'back', coll)}</div>`;
    const nextRight = target < leaves.length ? leaves[target] : null;
    rightEl.innerHTML = nextRight ? leafHtml(nextRight, 'front', coll) : coverHtml(coll, sub, 'back');
    loadLeafPhotos(rightEl, nextRight, 'front');
  } else {
    // Backward: the left leaf swings right, back face first, landing on its front.
    turn.innerHTML =
      `<div class="album-turn-face a">${leafHtml(movingLeaf, 'back', coll)}</div>` +
      `<div class="album-turn-face b">${leafHtml(movingLeaf, 'front', coll)}</div>`;
    const nextLeft = target > 0 ? leaves[target-1] : null;
    leftEl.innerHTML = nextLeft ? leafHtml(nextLeft, 'back', coll) : coverHtml(coll, sub, 'front');
    loadLeafPhotos(leftEl, nextLeft, 'back');
  }

  book.appendChild(turn);
  const faceA = turn.querySelector('.album-turn-face.a');
  const faceB = turn.querySelector('.album-turn-face.b');
  loadLeafPhotos(faceA, movingLeaf, step > 0 ? 'front' : 'back');
  loadLeafPhotos(faceB, movingLeaf, step > 0 ? 'back' : 'front');

  // Settle the turn without rebuilding the album.
  //
  // Everything the finished spread needs is already on screen and already
  // painted: the face now towards the reader is the leaf the turn carried, and
  // the page it uncovered was put in place before the rotation began. So the
  // leaf is moved into the book and the turning layer is dropped.
  //
  // Rebuilding instead — which is what this used to do — threw that away and
  // read every photo back out of IndexedDB, leaving the pockets showing only
  // their backing gradient until the photos returned. That was the flicker: a
  // frame or two of the whole spread changing, a good 50ms after the movement
  // had stopped, which reads as a fault rather than as part of the turn.
  const finish = () => {
    if (!turning) return;
    turning = false;
    view.albumSpread = target;

    // Face B is the one left facing the reader: the leaf's back on the way
    // forward, its front on the way back.
    const landed = turn.querySelector('.album-turn-face.b > .album-leaf');
    turn.remove();
    if (!landed){ renderAlbumView(coll, sub); return; }

    (step > 0 ? leftEl : rightEl).replaceChildren(landed);
    // The moved pockets and the page uncovered at the start both carry markup
    // that has never been wired up, and the pager is a spread out of date.
    bindSleeves(el('ledgerWrap'), coll, sub);
    paintPager(coll, sub, leaves);
  };

  // transitionend is the signal; the timer is the safety net for the case
  // where the transition never fires (a hidden tab, a dropped frame).
  const timer = setTimeout(finish, TURN_MS + 220);
  turn.addEventListener('transitionend', (e) => {
    if (e.propertyName !== 'transform') return;
    clearTimeout(timer);
    finish();
  });

  // Two frames: one for the browser to take the start transform, one to
  // change it. Without the gap the element is created and moved in the same
  // paint and there is nothing to animate between.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    turn.classList.add('turned');
  }));
}
