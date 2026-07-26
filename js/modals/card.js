import { el, uid, escapeHtml, showToast, readImageFile, EFFECTS } from '../ui.js';
import { startScan } from '../scan.js';
import { data, editing, getColl, getSub, getCard, getSortedCollections } from '../state.js';
import { saveData, getBlob, setBlob, deleteBlob, photoKey, photoBackKey } from '../store.js';
import { openConfirm } from './confirm.js';
import { render } from '../render.js';

let selectedEffect = 'matte';
let pendingLinkedSlots = [];
let pendingFront = { dataUrl: null, remove: false };
let pendingBack = { dataUrl: null, remove: false };

/* ── photo fields ───────────────────────────────────────────────────────── */

// Front and back behave identically, so both sides are driven from one table.
const PHOTO_FIELDS = [
  { input:'fPhotoInput',     scanBtn:'scanPhotoBtn',     preview:'fPhotoPreview',     removeBtn:'removePhotoBtn',     get:() => pendingFront, set:v => { pendingFront = v; } },
  { input:'fPhotoBackInput', scanBtn:'scanPhotoBackBtn', preview:'fPhotoBackPreview', removeBtn:'removePhotoBackBtn', get:() => pendingBack,  set:v => { pendingBack = v; } },
];

PHOTO_FIELDS.forEach(field => {
  // A scanned photo joins the same pending-photo queue as a picked one, so
  // saving, replacing and syncing need to know nothing about where it came from.
  function accept(dataUrl){
    field.set({ dataUrl, remove: false });
    el(field.preview).style.backgroundImage = `url(${dataUrl})`;
    el(field.removeBtn).style.display = 'inline-block';
  }

  el(field.scanBtn).onclick = () => startScan(dataUrl => {
    accept(dataUrl);
    showToast('Card scanned');
  });

  el(field.input).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try{
      const { dataUrl } = await readImageFile(file, 900);
      accept(dataUrl);
    }catch(err){ showToast(err.message); }
  };
  el(field.removeBtn).onclick = () => {
    field.set({ dataUrl: null, remove: true });
    el(field.preview).style.backgroundImage = '';
    el(field.input).value = '';
    el(field.removeBtn).style.display = 'none';
  };
});

function resetPhotoFields(){
  PHOTO_FIELDS.forEach(field => {
    field.set({ dataUrl: null, remove: false });
    el(field.input).value = '';
    el(field.preview).style.backgroundImage = '';
    el(field.removeBtn).style.display = 'none';
  });
}

async function showExistingPhoto(field, key){
  try{
    const value = await getBlob(key);
    if (!value) return;
    el(field.preview).style.backgroundImage = `url(${value})`;
    el(field.removeBtn).style.display = 'inline-block';
  }catch(e){ /* photo missing or unreadable — leave preview blank */ }
}

/* ── effect picker ──────────────────────────────────────────────────────── */

function renderEffectPicker(){
  const wrap = el('effectPicker');
  wrap.innerHTML = Object.entries(EFFECTS).map(([key,v]) => `
    <div class="effect-opt${selectedEffect===key?' sel':''}" data-key="${key}">
      <span class="glyph">${v.glyph}</span>${v.label}
    </div>`).join('');
  wrap.querySelectorAll('.effect-opt').forEach(o => o.onclick = () => { selectedEffect = o.dataset.key; renderEffectPicker(); });
}

function populateRaritySelect(collId, subId){
  const sub = getSub(collId, subId);
  const sel = el('fRarity');
  if (!sub || !sub.rarities || sub.rarities.length === 0){
    sel.innerHTML = `<option value="">No rarities defined — edit series to add some</option>`;
  } else {
    sel.innerHTML = sub.rarities.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
  }
}

/* ── linked slots ───────────────────────────────────────────────────────── */

function pickDefaultLinkTarget(){
  const firstColl = data.collections.find(c => c.subcollections.some(s => !(c.id===editing.collId && s.id===editing.subId)));
  if (!firstColl) return { collId:'', subId:'', rarity:'', number:null };
  const firstSub = firstColl.subcollections.find(s => !(firstColl.id===editing.collId && s.id===editing.subId));
  return { collId: firstColl.id, subId: firstSub.id, rarity:'', number:null };
}

function renderLinkedSlotsUI(){
  const wrap = el('linkedSlotsWrap');
  const rowsHtml = pendingLinkedSlots.map((link, i) => {
    const collOptions = getSortedCollections().map(c => `<option value="${c.id}" ${link.collId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
    const chosenColl = getColl(link.collId);
    const availableSubs = chosenColl ? chosenColl.subcollections.filter(s => !(chosenColl.id===editing.collId && s.id===editing.subId)) : [];
    const subOptions = availableSubs.map(s => `<option value="${s.id}" ${link.subId===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
    const chosenSub = chosenColl ? availableSubs.find(s => s.id===link.subId) : null;
    const rarityOptions = chosenSub ? (chosenSub.rarities||[]).map(r => `<option value="${escapeHtml(r.name)}" ${link.rarity===r.name?'selected':''}>${escapeHtml(r.name)}</option>`).join('') : '';
    return `<div class="link-row" data-i="${i}">
      <select class="link-coll">${collOptions || '<option value="">No collections</option>'}</select>
      <select class="link-sub">${subOptions || '<option value="">No series</option>'}</select>
      <select class="link-rarity">${rarityOptions || '<option value="">No rarities</option>'}</select>
      <input class="link-number" type="number" min="1" placeholder="#" value="${link.number ?? ''}" />
      <button type="button" class="link-remove" data-i="${i}" title="Remove">✕</button>
    </div>`;
  }).join('');
  wrap.innerHTML = rowsHtml + `<button type="button" class="btn-ghost add-link-btn" id="addLinkRowBtn">+ Add another series</button>`;

  wrap.querySelectorAll('.link-row').forEach(row => {
    const i = Number(row.dataset.i);
    row.querySelector('.link-coll').onchange = (e) => {
      const nc = getColl(e.target.value);
      const firstSub = nc ? nc.subcollections.find(s => !(nc.id===editing.collId && s.id===editing.subId)) : null;
      pendingLinkedSlots[i] = { collId: e.target.value, subId: firstSub ? firstSub.id : '', rarity: '', number: pendingLinkedSlots[i].number };
      renderLinkedSlotsUI();
    };
    row.querySelector('.link-sub').onchange = (e) => {
      pendingLinkedSlots[i].subId = e.target.value;
      pendingLinkedSlots[i].rarity = '';
      renderLinkedSlotsUI();
    };
    row.querySelector('.link-rarity').onchange = (e) => { pendingLinkedSlots[i].rarity = e.target.value; };
    row.querySelector('.link-number').oninput = (e) => {
      const v = e.target.value.trim();
      pendingLinkedSlots[i].number = v === '' ? null : Math.max(1, parseInt(v,10));
    };
  });
  wrap.querySelectorAll('.link-remove').forEach(btn => btn.onclick = () => {
    pendingLinkedSlots.splice(Number(btn.dataset.i), 1);
    renderLinkedSlotsUI();
  });
  const addBtn = el('addLinkRowBtn');
  if (addBtn) addBtn.onclick = () => { pendingLinkedSlots.push(pickDefaultLinkTarget()); renderLinkedSlotsUI(); };
}

el('fLinkToggle').onchange = (e) => {
  el('linkedSlotsWrap').style.display = e.target.checked ? '' : 'none';
  if (e.target.checked && pendingLinkedSlots.length === 0){
    pendingLinkedSlots.push(pickDefaultLinkTarget());
    renderLinkedSlotsUI();
  }
};

function clearLinkedSlots(){
  pendingLinkedSlots = [];
  el('fLinkToggle').checked = false;
  el('linkedSlotsWrap').style.display = 'none';
  el('linkedSlotsWrap').innerHTML = '';
}

/* ── open / save / delete ───────────────────────────────────────────────── */

export function openAddCard(collId, subId, prefill){
  editing.collId = collId; editing.subId = subId; editing.cardId = null;
  el('cardModalTitle').textContent = 'Add a card';
  el('fName').value = ''; el('fQty').value = 1; el('fCondition').value = ''; el('fNotes').value = '';
  el('fNumber').value = '';
  populateRaritySelect(collId, subId);
  if (prefill){
    if (prefill.rarity) el('fRarity').value = prefill.rarity;
    if (prefill.number != null) el('fNumber').value = prefill.number;
  }
  selectedEffect = 'matte'; renderEffectPicker();
  resetPhotoFields();
  clearLinkedSlots();
  el('deleteCardBtn').style.display = 'none';
  el('cardOverlay').classList.add('open');
  el('fName').focus();
}

export async function openEditCard(collId, subId, cardId){
  const c = getCard(collId, subId, cardId);
  if (!c) return;
  editing.collId = collId; editing.subId = subId; editing.cardId = cardId;
  el('cardModalTitle').textContent = 'Edit card';
  el('fName').value = c.name; el('fQty').value = c.qty ?? 1;
  el('fCondition').value = c.condition||''; el('fNotes').value = c.notes||'';
  el('fNumber').value = c.number ?? '';
  populateRaritySelect(collId, subId);
  el('fRarity').value = c.rarity || '';
  selectedEffect = c.effect || 'matte'; renderEffectPicker();
  resetPhotoFields();

  if (c.linkedSlots && c.linkedSlots.length){
    pendingLinkedSlots = c.linkedSlots.map(l => ({...l}));
    el('fLinkToggle').checked = true;
    el('linkedSlotsWrap').style.display = '';
    renderLinkedSlotsUI();
  } else {
    clearLinkedSlots();
  }

  el('deleteCardBtn').style.display = 'inline-block';
  el('cardOverlay').classList.add('open');
  el('fName').focus();

  if (c.hasPhoto) await showExistingPhoto(PHOTO_FIELDS[0], photoKey(c.id));
  if (c.hasBackPhoto) await showExistingPhoto(PHOTO_FIELDS[1], photoBackKey(c.id));
}

el('cancelCard').onclick = () => el('cardOverlay').classList.remove('open');

el('saveCard').onclick = async () => {
  const name = el('fName').value.trim();
  if (!name){ el('fName').focus(); return; }
  const numberRaw = el('fNumber').value.trim();
  const payload = {
    name,
    rarity: el('fRarity').value,
    number: numberRaw === '' ? null : Math.max(1, parseInt(numberRaw,10)),
    qty: Math.max(0, parseInt(el('fQty').value||'1',10)),
    condition: el('fCondition').value.trim(),
    notes: el('fNotes').value.trim(),
    effect: selectedEffect,
    linkedSlots: el('fLinkToggle').checked
      ? pendingLinkedSlots.filter(l => l.collId && l.subId && l.rarity && l.number != null)
      : [],
  };
  const sub = getSub(editing.collId, editing.subId);
  if (!sub) return;
  const cardId = editing.cardId || uid();

  const photoWrites = [
    { pending: pendingFront, key: photoKey(cardId),     flag: 'hasPhoto',     label: 'front' },
    { pending: pendingBack,  key: photoBackKey(cardId), flag: 'hasBackPhoto', label: 'back' },
  ];
  for (const w of photoWrites){
    if (w.pending.dataUrl){
      try{ await setBlob(w.key, w.pending.dataUrl); payload[w.flag] = true; }
      catch(e){ showToast(`Card saved, but the ${w.label} photo could not be stored`); payload[w.flag] = false; }
    } else if (w.pending.remove){
      try{ await deleteBlob(w.key); }catch(e){ /* nothing to remove */ }
      payload[w.flag] = false;
    }
  }

  if (editing.cardId){
    const idx = sub.cards.findIndex(c => c.id === editing.cardId);
    sub.cards[idx] = { ...sub.cards[idx], ...payload };
  } else {
    sub.cards.push({ id: cardId, ...payload });
  }
  await saveData();
  el('cardOverlay').classList.remove('open');
  render();
  showToast(editing.cardId ? 'Card updated' : 'Card added');
};

el('deleteCardBtn').onclick = () => {
  el('cardOverlay').classList.remove('open');
  confirmDeleteCard(editing.collId, editing.subId, editing.cardId);
};

export function confirmDeleteCard(collId, subId, cardId){
  const sub = getSub(collId, subId);
  const c = sub ? sub.cards.find(x => x.id === cardId) : null;
  if (!c) return;
  openConfirm(`Delete "${c.name}"?`, `This removes the card from your ledger. This can't be undone.`, async () => {
    sub.cards = sub.cards.filter(x => x.id !== cardId);
    try{ await deleteBlob(photoKey(cardId)); }catch(e){ /* no photo to remove */ }
    try{ await deleteBlob(photoBackKey(cardId)); }catch(e){ /* no back photo to remove */ }
    await saveData();
    render();
    showToast('Card deleted');
  });
}
