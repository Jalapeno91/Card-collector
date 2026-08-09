import { el, uid, escapeHtml, showToast, readImageFile, DEFAULT_RARITY_PALETTE } from '../ui.js';
import { nav, editing, getColl, getSub } from '../state.js';
import { saveData, getBlob, setBlob, deleteBlob, boxPhotoKey, rarityBackPhotoKey } from '../store.js';
import { openConfirm } from './confirm.js';
import { render } from '../render.js';
import { startScan } from '../scan.js';

let pendingRarities = [];
let pendingPhoto = { dataUrl: null, remove: false };
// rarity id → { dataUrl, remove } for a shared back image that hasn't been
// saved yet. Keyed by id (not array index) so a reorder never mismatches an
// in-flight upload with the wrong row.
let pendingRarityBacks = {};
// Rarities removed from the list before saving, so their shared back image
// (if any) is cleaned up rather than left orphaned in storage.
let deletedRarityIds = [];

function resetPhotoField(){
  pendingPhoto = { dataUrl: null, remove: false };
  el('subPhotoInput').value = '';
  el('subPhotoPreview').style.backgroundImage = '';
  el('removeSubPhotoBtn').style.display = 'none';
}

function renderRarityManageList(){
  const wrap = el('rarityManageList');
  if (pendingRarities.length === 0){
    wrap.innerHTML = `<div style="font-size:12px; color:var(--parchment-dim);">No rarities yet — add one below.</div>`;
    return;
  }
  wrap.innerHTML = pendingRarities.map((r,i) => `
    <div class="rarity-manage-row">
      <div class="rarity-manage-main">
        <input type="color" data-i="${i}" class="rc-color" value="${r.color}" />
        <input type="text" data-i="${i}" class="rc-name" value="${escapeHtml(r.name)}" />
        <input type="number" min="0" data-i="${i}" class="rc-total" value="${r.total ?? ''}" placeholder="Qty" />
        <button data-i="${i}" data-dir="up" class="rc-move" type="button" title="Move up" ${i===0?'disabled':''}>▲</button>
        <button data-i="${i}" data-dir="down" class="rc-move" type="button" title="Move down" ${i===pendingRarities.length-1?'disabled':''}>▼</button>
        <button data-i="${i}" class="rc-del" type="button" title="Delete rarity">✕</button>
      </div>
      <label class="rarity-shared-toggle">
        <input type="checkbox" data-i="${i}" class="rc-shared-toggle" ${r.sharedBack?'checked':''} />
        Use one shared back image for every "${escapeHtml(r.name)}" card
      </label>
      <div class="rarity-shared-photo" data-i="${i}" style="display:${r.sharedBack?'block':'none'}">
        <button type="button" class="btn-scan rc-shared-scan" data-i="${i}">⛶ Scan card with camera</button>
        <input type="file" accept="image/*" class="rc-shared-input" data-i="${i}" />
        <div class="rarity-shared-preview-row">
          <div class="rarity-shared-preview" data-i="${i}"></div>
          <button type="button" class="rc-shared-remove btn-ghost" data-i="${i}" style="display:none;">Remove photo</button>
        </div>
      </div>
    </div>`).join('');

  // Both the file picker and the camera scan land here — a shared back image
  // has no single card's outline to trace, so a scan's shape (if any, from
  // "Unusual shape" mode) is discarded and only the straightened photo kept.
  function acceptSharedBack(i, dataUrl){
    const r = pendingRarities[i];
    pendingRarityBacks[r.id] = { dataUrl, remove: false };
    wrap.querySelector(`.rarity-shared-preview[data-i="${i}"]`).style.backgroundImage = `url(${dataUrl})`;
    wrap.querySelector(`.rc-shared-remove[data-i="${i}"]`).style.display = 'inline-block';
  }

  wrap.querySelectorAll('.rc-color').forEach(inp => inp.oninput = () => { pendingRarities[inp.dataset.i].color = inp.value; });
  wrap.querySelectorAll('.rc-name').forEach(inp => inp.oninput = () => { pendingRarities[inp.dataset.i].name = inp.value; });
  wrap.querySelectorAll('.rc-total').forEach(inp => inp.oninput = () => {
    const v = inp.value.trim();
    pendingRarities[inp.dataset.i].total = v === '' ? null : Math.max(0, parseInt(v,10));
  });
  wrap.querySelectorAll('.rc-move').forEach(btn => btn.onclick = () => {
    const i = Number(btn.dataset.i);
    const j = btn.dataset.dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= pendingRarities.length) return;
    [pendingRarities[i], pendingRarities[j]] = [pendingRarities[j], pendingRarities[i]];
    renderRarityManageList();
  });
  wrap.querySelectorAll('.rc-del').forEach(btn => btn.onclick = () => {
    const removed = pendingRarities[btn.dataset.i];
    delete pendingRarityBacks[removed.id];
    deletedRarityIds.push(removed.id);
    pendingRarities.splice(btn.dataset.i,1);
    renderRarityManageList();
  });
  wrap.querySelectorAll('.rc-shared-toggle').forEach(inp => inp.onchange = () => {
    pendingRarities[inp.dataset.i].sharedBack = inp.checked;
    renderRarityManageList();
  });
  wrap.querySelectorAll('.rc-shared-input').forEach(inp => inp.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try{
      const { dataUrl } = await readImageFile(file, 800);
      acceptSharedBack(Number(inp.dataset.i), dataUrl);
    }catch(err){ showToast(err.message); }
  });
  wrap.querySelectorAll('.rc-shared-scan').forEach(btn => btn.onclick = () => {
    const i = Number(btn.dataset.i);
    startScan(({ dataUrl }) => {
      acceptSharedBack(i, dataUrl);
      showToast('Card scanned');
    });
  });
  wrap.querySelectorAll('.rc-shared-remove').forEach(btn => btn.onclick = () => {
    const r = pendingRarities[btn.dataset.i];
    pendingRarityBacks[r.id] = { dataUrl: null, remove: true };
    wrap.querySelector(`.rarity-shared-preview[data-i="${btn.dataset.i}"]`).style.backgroundImage = '';
    wrap.querySelector(`.rc-shared-input[data-i="${btn.dataset.i}"]`).value = '';
    btn.style.display = 'none';
  });

  // Fill in the preview for a rarity that already has a saved shared photo and
  // hasn't been touched in this session yet.
  pendingRarities.forEach((r, i) => {
    if (!editing.subId || !r.hasSharedBack || pendingRarityBacks[r.id]) return;
    getBlob(rarityBackPhotoKey(editing.subId, r.id)).then(value => {
      if (!value) return;
      const preview = wrap.querySelector(`.rarity-shared-preview[data-i="${i}"]`);
      const removeBtn = wrap.querySelector(`.rc-shared-remove[data-i="${i}"]`);
      if (preview) preview.style.backgroundImage = `url(${value})`;
      if (removeBtn) removeBtn.style.display = 'inline-block';
    }).catch(() => { /* photo missing or unreadable — leave preview blank */ });
  });
}

el('addRarityBtn').onclick = () => {
  const name = el('newRarityName').value.trim();
  if (!name) return;
  const totalRaw = el('newRarityTotal').value.trim();
  const total = totalRaw === '' ? null : Math.max(0, parseInt(totalRaw,10));
  pendingRarities.push({ id: uid(), name, color: el('newRarityColor').value, total, sharedBack: false, hasSharedBack: false });
  el('newRarityName').value = '';
  el('newRarityTotal').value = '';
  el('newRarityColor').value = DEFAULT_RARITY_PALETTE[Math.floor(Math.random()*DEFAULT_RARITY_PALETTE.length)];
  renderRarityManageList();
};

el('subPhotoInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try{
    const { dataUrl } = await readImageFile(file, 800);
    pendingPhoto = { dataUrl, remove: false };
    el('subPhotoPreview').style.backgroundImage = `url(${dataUrl})`;
    el('removeSubPhotoBtn').style.display = 'inline-block';
  }catch(err){ showToast(err.message); }
};

el('removeSubPhotoBtn').onclick = () => {
  pendingPhoto = { dataUrl: null, remove: true };
  el('subPhotoPreview').style.backgroundImage = '';
  el('subPhotoInput').value = '';
  el('removeSubPhotoBtn').style.display = 'none';
};

export function openAddSubcollection(collId){
  editing.collId = collId; editing.subId = null;
  pendingRarities = [];
  pendingRarityBacks = {};
  deletedRarityIds = [];
  el('subModalTitle').textContent = 'New series';
  el('subName').value = ''; el('subTotal').value = '';
  el('deleteSubBtn').style.display = 'none';
  resetPhotoField();
  renderRarityManageList();
  el('subOverlay').classList.add('open');
  el('subName').focus();
}

export async function openEditSubcollection(collId, subId){
  const s = getSub(collId, subId);
  if (!s) return;
  editing.collId = collId; editing.subId = subId;
  pendingRarities = (s.rarities||[]).map(r => ({...r}));
  pendingRarityBacks = {};
  deletedRarityIds = [];
  el('subModalTitle').textContent = 'Edit series';
  el('subName').value = s.name;
  el('subTotal').value = s.totalInSet ?? '';
  el('deleteSubBtn').style.display = 'inline-block';
  resetPhotoField();
  renderRarityManageList();
  el('subOverlay').classList.add('open');
  el('subName').focus();
  if (s.hasBoxPhoto){
    try{
      const value = await getBlob(boxPhotoKey(s.id));
      if (value){
        el('subPhotoPreview').style.backgroundImage = `url(${value})`;
        el('removeSubPhotoBtn').style.display = 'inline-block';
      }
    }catch(e){ /* photo missing or unreadable — leave preview blank */ }
  }
}

el('cancelSub').onclick = () => el('subOverlay').classList.remove('open');

el('saveSub').onclick = async () => {
  const name = el('subName').value.trim();
  if (!name){ el('subName').focus(); return; }
  const totalRaw = el('subTotal').value.trim();
  const total = totalRaw === '' ? null : Math.max(0, parseInt(totalRaw,10));
  const coll = getColl(editing.collId);
  if (!coll) return;
  const subId = editing.subId || uid();

  let hasBoxPhoto;
  if (pendingPhoto.dataUrl){
    try{ await setBlob(boxPhotoKey(subId), pendingPhoto.dataUrl); hasBoxPhoto = true; }
    catch(e){ showToast('Series saved, but the photo could not be stored'); hasBoxPhoto = false; }
  } else if (pendingPhoto.remove){
    try{ await deleteBlob(boxPhotoKey(subId)); }catch(e){ /* nothing to remove */ }
    hasBoxPhoto = false;
  }

  for (const id of deletedRarityIds){
    try{ await deleteBlob(rarityBackPhotoKey(subId, id)); }catch(e){ /* nothing to remove */ }
  }
  deletedRarityIds = [];

  for (const r of pendingRarities){
    const pending = pendingRarityBacks[r.id];
    if (!pending) continue;
    if (pending.dataUrl){
      try{ await setBlob(rarityBackPhotoKey(subId, r.id), pending.dataUrl); r.hasSharedBack = true; }
      catch(e){ showToast('Series saved, but a shared back photo could not be stored'); r.hasSharedBack = false; }
    } else if (pending.remove){
      try{ await deleteBlob(rarityBackPhotoKey(subId, r.id)); }catch(e){ /* nothing to remove */ }
      r.hasSharedBack = false;
    }
  }
  pendingRarityBacks = {};

  if (editing.subId){
    const s = getSub(editing.collId, editing.subId);
    s.name = name; s.totalInSet = total; s.rarities = pendingRarities;
    if (hasBoxPhoto !== undefined) s.hasBoxPhoto = hasBoxPhoto;
  } else {
    coll.subcollections.push({ id: subId, name, totalInSet: total, rarities: pendingRarities, hasBoxPhoto: hasBoxPhoto||false, cards: [] });
  }
  await saveData();
  el('subOverlay').classList.remove('open');
  render();
  showToast('Series saved');
};

el('deleteSubBtn').onclick = () => {
  el('subOverlay').classList.remove('open');
  confirmDeleteSubcollection(editing.collId, editing.subId);
};

export function confirmDeleteSubcollection(collId, subId){
  const s = getSub(collId, subId);
  if (!s) return;
  openConfirm(`Delete "${s.name}"?`, `This removes the series and every card inside it. This can't be undone.`, async () => {
    const coll = getColl(collId);
    coll.subcollections = coll.subcollections.filter(x => x.id !== subId);
    if (nav.subId === subId) nav.subId = null;
    try{ await deleteBlob(boxPhotoKey(subId)); }catch(e){ /* no photo to remove */ }
    for (const r of (s.rarities||[])){
      try{ await deleteBlob(rarityBackPhotoKey(subId, r.id)); }catch(e){ /* no photo to remove */ }
    }
    await saveData();
    render();
    showToast('Series deleted');
  });
}
