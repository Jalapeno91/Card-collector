import { el, uid, escapeHtml, showToast, readImageFile, DEFAULT_RARITY_PALETTE } from '../ui.js';
import { nav, editing, getColl, getSub } from '../state.js';
import { saveData, getBlob, setBlob, deleteBlob, boxPhotoKey } from '../store.js';
import { openConfirm } from './confirm.js';
import { render } from '../render.js';

let pendingRarities = [];
let pendingPhoto = { dataUrl: null, remove: false };

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
      <input type="color" data-i="${i}" class="rc-color" value="${r.color}" />
      <input type="text" data-i="${i}" class="rc-name" value="${escapeHtml(r.name)}" />
      <input type="number" min="0" data-i="${i}" class="rc-total" value="${r.total ?? ''}" placeholder="Qty" />
      <button data-i="${i}" class="rc-del" type="button">✕</button>
    </div>`).join('');
  wrap.querySelectorAll('.rc-color').forEach(inp => inp.oninput = () => { pendingRarities[inp.dataset.i].color = inp.value; });
  wrap.querySelectorAll('.rc-name').forEach(inp => inp.oninput = () => { pendingRarities[inp.dataset.i].name = inp.value; });
  wrap.querySelectorAll('.rc-total').forEach(inp => inp.oninput = () => {
    const v = inp.value.trim();
    pendingRarities[inp.dataset.i].total = v === '' ? null : Math.max(0, parseInt(v,10));
  });
  wrap.querySelectorAll('.rc-del').forEach(btn => btn.onclick = () => { pendingRarities.splice(btn.dataset.i,1); renderRarityManageList(); });
}

el('addRarityBtn').onclick = () => {
  const name = el('newRarityName').value.trim();
  if (!name) return;
  const totalRaw = el('newRarityTotal').value.trim();
  const total = totalRaw === '' ? null : Math.max(0, parseInt(totalRaw,10));
  pendingRarities.push({ id: uid(), name, color: el('newRarityColor').value, total });
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
    await saveData();
    render();
    showToast('Series deleted');
  });
}
