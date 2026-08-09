// The 3D card viewer: tilt, holographic sweep, and flip to the back face.

import { el, showToast, EFFECTS } from './ui.js';
import { nav, getColl, getSub } from './state.js';
import { getBlob, photoKey, photoBackKey, rarityBackPhotoKey } from './store.js';
import { openEditCard, confirmDeleteCard } from './modals/card.js';
import { shapeStyle } from './lib/shape.js';

let flipped = false;
let tiltX = 0;
let tiltY = 0;
let frontHint = 'Move your mouse over the card to tilt it.';
let context = { collId: null, subId: null, cardId: null };

function updateTransform(){
  const c3d = el('card3d');
  const flipDeg = flipped ? 180 : 0;
  c3d.style.transform = `rotateX(${tiltX}deg) rotateY(${tiltY + flipDeg}deg)`;
}

function resetTilt(){
  const c3d = el('card3d');
  c3d.classList.remove('live');
  tiltX = 0; tiltY = 0;
  updateTransform();
  c3d.style.setProperty('--rx', 0);
  c3d.style.setProperty('--ry', 0);
}

export function goToLinkedCard(homeCollId, homeSubId, cardId){
  const homeColl = getColl(homeCollId);
  const homeSub = homeColl ? getSub(homeCollId, homeSubId) : null;
  if (!homeColl || !homeSub){ showToast('That card\'s home series no longer exists'); return; }
  nav.collectionId = homeCollId;
  nav.subId = homeSubId;
  // Imported lazily: render.js imports this module, so taking the dependency at
  // module scope would close the cycle at evaluation time.
  import('./render.js').then(({ render }) => {
    render();
    openViewer(homeColl, homeSub, cardId);
  });
}

export async function openViewer(coll, sub, cardId){
  const card = sub.cards.find(c => c.id === cardId);
  if (!card) return;
  context = { collId: coll.id, subId: sub.id, cardId: card.id };
  const rarity = (sub.rarities||[]).find(r => r.name === card.rarity);
  const fx = EFFECTS[card.effect] || EFFECTS.matte;

  // A non-rectangular card gets clipped to its true outline and re-sized to
  // that outline's own proportions; a plain card gets today's fixed rectangle.
  const card3d = el('card3d');
  const style = shapeStyle(card.shape);
  card3d.classList.toggle('shaped', !!style);
  card3d.style.aspectRatio = style ? style.aspectRatio : '';
  card3d.style.height = style ? 'auto' : '';
  document.querySelectorAll('.c-face').forEach(face => {
    face.style.clipPath = style ? style.clipPath : '';
  });

  const cBase = el('cBase');
  cBase.style.backgroundImage = 'none';
  cBase.style.background = `linear-gradient(160deg, ${coll.color} 0%, #14161d 85%)`;
  el('cFx').className = 'c-fx fx-' + (card.effect||'matte');
  el('cEyebrow').textContent = `${coll.name} · ${sub.name}`;
  el('cTitle').textContent = card.name;
  el('cRing').textContent = (card.name||'?').trim().charAt(0).toUpperCase();
  el('cRarity').textContent = card.rarity || '—';
  el('cRarity').style.color = rarity ? rarity.color : 'inherit';
  el('cQty').textContent = '×' + Number(card.qty||0);

  el('vName').textContent = `${card.name}`;
  const verb = matchMedia('(hover:none)').matches ? 'drag across' : 'move your mouse over';
  frontHint = `${fx.glyph} ${fx.label} — ${verb} the card to see the ${fx.label.toLowerCase()} effect.`;
  el('vHint').textContent = frontHint;
  el('vNotes').textContent = card.notes || '';

  document.querySelector('.c-emblem').style.display = card.hasPhoto ? 'none' : '';

  // Back face: reset to a neutral placeholder, then fill in if a photo exists.
  // A rarity with "shared back image" turned on supplies the photo instead of
  // the card's own — the same one every card of that rarity shows.
  const sharedBack = !!(rarity && rarity.sharedBack);
  const backKey = sharedBack ? rarityBackPhotoKey(sub.id, rarity.id) : photoBackKey(card.id);
  const hasBack = sharedBack ? !!rarity.hasSharedBack : !!card.hasBackPhoto;
  const cBaseBack = el('cBaseBack');
  cBaseBack.style.backgroundImage = 'none';
  cBaseBack.style.background = `linear-gradient(160deg, #14161d 0%, ${coll.color} 130%)`;
  el('cBackPlaceholder').textContent = hasBack ? '' : 'No back photo added yet';

  flipped = false;
  resetTilt();
  el('flipCardBtn').textContent = '⟲ Flip to back';
  el('viewerOverlay').classList.add('open');

  if (card.hasPhoto){
    try{
      const value = await getBlob(photoKey(card.id));
      if (value){
        cBase.style.background = 'none';
        cBase.style.backgroundImage = `url(${value})`;
        cBase.style.backgroundSize = 'cover';
        cBase.style.backgroundPosition = 'center';
        cBase.style.backgroundRepeat = 'no-repeat';
      }
    }catch(e){ /* fall back silently to the generated design already drawn above */ }
  }

  if (hasBack){
    try{
      const value = await getBlob(backKey);
      if (value){
        cBaseBack.style.background = 'none';
        cBaseBack.style.backgroundImage = `url(${value})`;
        cBaseBack.style.backgroundSize = 'cover';
        cBaseBack.style.backgroundPosition = 'center';
        cBaseBack.style.backgroundRepeat = 'no-repeat';
      }
    }catch(e){ /* fall back silently to the placeholder already shown */ }
  }
}

/* ── tilt ───────────────────────────────────────────────────────────────── */

// Pointer events rather than mouse events, so a finger dragged across the card
// tilts it the same way a cursor does.
function bindTilt(){
  const stage = document.querySelector('.stage-wrap');
  const c3d = el('card3d');
  let tracking = false;

  function apply(e){
    const rect = c3d.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    tiltX = (0.5 - py) * 22;
    tiltY = (px - 0.5) * 26;
    c3d.classList.add('live');
    updateTransform();
    c3d.style.setProperty('--rx', tiltX.toFixed(2));
    c3d.style.setProperty('--ry', tiltY.toFixed(2));
    c3d.style.setProperty('--mx', (px*100).toFixed(1)+'%');
    c3d.style.setProperty('--my', (py*100).toFixed(1)+'%');
  }

  stage.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse'){ tracking = true; apply(e); }
  });
  stage.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse' || tracking) apply(e);
  });
  stage.addEventListener('pointerup', () => { tracking = false; resetTilt(); });
  stage.addEventListener('pointercancel', () => { tracking = false; resetTilt(); });
  stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') resetTilt(); });
  // Keep a drag on the card from scrolling the page behind the overlay.
  stage.addEventListener('touchmove', e => { if (tracking) e.preventDefault(); }, { passive:false });
}

export function initViewer(){
  bindTilt();

  el('flipCardBtn').onclick = () => {
    flipped = !flipped;
    updateTransform();
    el('flipCardBtn').textContent = flipped ? '⟲ Flip to front' : '⟲ Flip to back';
    el('vHint').textContent = flipped ? 'Showing the back of the card.' : frontHint;
  };
  el('viewerEditBtn').onclick = () => {
    const { collId, subId, cardId } = context;
    el('viewerOverlay').classList.remove('open');
    openEditCard(collId, subId, cardId);
  };
  el('viewerDeleteBtn').onclick = () => {
    const { collId, subId, cardId } = context;
    el('viewerOverlay').classList.remove('open');
    confirmDeleteCard(collId, subId, cardId);
  };
  el('viewerClose').onclick = () => el('viewerOverlay').classList.remove('open');
  el('viewerOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'viewerOverlay') el('viewerOverlay').classList.remove('open');
  });
}
