import { el, uid, showToast, randomColor, extractDominantColor, readImageFile } from '../ui.js';
import { data, nav, editing, getColl } from '../state.js';
import { saveData, getBlob, setBlob, deleteBlob, logoKey } from '../store.js';
import { openConfirm } from './confirm.js';
import { render } from '../render.js';

let pendingLogo = { dataUrl: null, remove: false };

function resetLogoField(){
  pendingLogo = { dataUrl: null, remove: false };
  el('collLogoInput').value = '';
  el('collLogoPreview').style.backgroundImage = '';
  el('removeCollLogoBtn').style.display = 'none';
}

function resetBoxPhotoField(){
  el('boxPhotoInput').value = '';
  el('boxPreview').style.backgroundImage = '';
}

el('collLogoInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try{
    const { img, dataUrl } = await readImageFile(file, 400);
    pendingLogo = { dataUrl, remove: false };
    el('collLogoPreview').style.backgroundImage = `url(${dataUrl})`;
    el('removeCollLogoBtn').style.display = 'inline-block';
    const hex = extractDominantColor(img);
    if (hex){ el('collColor').value = hex; showToast('Theme color updated to match the logo'); }
  }catch(err){ showToast(err.message); }
};

el('removeCollLogoBtn').onclick = () => {
  pendingLogo = { dataUrl: null, remove: true };
  el('collLogoPreview').style.backgroundImage = '';
  el('collLogoInput').value = '';
  el('removeCollLogoBtn').style.display = 'none';
};

// The box photo is only ever sampled for a color — it is never stored.
el('boxPhotoInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try{
    const { img, original } = await readImageFile(file, 800);
    el('boxPreview').style.backgroundImage = `url(${original})`;
    const hex = extractDominantColor(img);
    if (hex){ el('collColor').value = hex; showToast('Theme color detected from photo'); }
    else showToast('Could not read a color from that photo');
  }catch(err){ showToast(err.message); }
};

export function openAddCollection(){
  editing.collId = null;
  el('collModalTitle').textContent = 'New collection';
  el('collName').value = '';
  el('collColor').value = randomColor();
  el('deleteCollBtn').style.display = 'none';
  resetBoxPhotoField();
  resetLogoField();
  el('collOverlay').classList.add('open');
  el('collName').focus();
}

export async function openEditCollection(id){
  const c = getColl(id);
  if (!c) return;
  editing.collId = id;
  el('collModalTitle').textContent = 'Edit collection';
  el('collName').value = c.name;
  el('collColor').value = c.color;
  el('deleteCollBtn').style.display = 'inline-block';
  resetBoxPhotoField();
  resetLogoField();
  el('collOverlay').classList.add('open');
  if (c.hasLogo){
    try{
      const value = await getBlob(logoKey(c.id));
      if (value){
        el('collLogoPreview').style.backgroundImage = `url(${value})`;
        el('removeCollLogoBtn').style.display = 'inline-block';
      }
    }catch(e){ /* logo missing or unreadable — leave preview blank */ }
  }
}

el('cancelColl').onclick = () => el('collOverlay').classList.remove('open');

el('saveColl').onclick = async () => {
  const name = el('collName').value.trim();
  if (!name){ el('collName').focus(); return; }
  const color = el('collColor').value;
  const collId = editing.collId || uid();

  let hasLogo;
  if (pendingLogo.dataUrl){
    try{ await setBlob(logoKey(collId), pendingLogo.dataUrl); hasLogo = true; }
    catch(e){ showToast('Collection saved, but the logo could not be stored'); hasLogo = false; }
  } else if (pendingLogo.remove){
    try{ await deleteBlob(logoKey(collId)); }catch(e){ /* nothing to remove */ }
    hasLogo = false;
  }

  if (editing.collId){
    const c = getColl(editing.collId);
    c.name = name; c.color = color;
    if (hasLogo !== undefined) c.hasLogo = hasLogo;
  } else {
    data.collections.push({ id: collId, name, color, hasLogo: hasLogo||false, subcollections: [] });
  }
  await saveData();
  el('collOverlay').classList.remove('open');
  render();
  showToast('Collection saved');
};

el('deleteCollBtn').onclick = () => {
  el('collOverlay').classList.remove('open');
  confirmDeleteCollection(editing.collId);
};

export function confirmDeleteCollection(id){
  const c = getColl(id);
  if (!c) return;
  openConfirm(`Delete "${c.name}"?`, `This removes the collection, all its series, and every card inside it. This can't be undone.`, async () => {
    data.collections = data.collections.filter(x => x.id !== id);
    if (nav.collectionId === id){ nav.collectionId = null; nav.subId = null; }
    try{ await deleteBlob(logoKey(id)); }catch(e){ /* no logo to remove */ }
    await saveData();
    render();
    showToast('Collection deleted');
  });
}
