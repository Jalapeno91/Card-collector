// In-memory state and every derived reading taken from it.
//
// `data` keeps the nested shape the views were written against; the storage
// layer is what flattens it for persistence and sync.

export let data = { collections: [] };
export const nav = { collectionId: null, subId: null };
export const editing = { collId: null, subId: null, cardId: null };

// View-local state that outlives a single render pass.
export const view = {
  ledgerSearch: '',
  ledgerRarityFilter: '',
  mode: 'ledger',
  binderPage: 0,
  lastBinderSubId: null,
  albumSpread: 0,
  // Which half of the open album a phone is looking at, since a full spread
  // does not fit. Desktop shows both and ignores this.
  albumMobileSide: 'right',
};

export function setData(next){
  data = next && Array.isArray(next.collections) ? next : { collections: [] };
}

export function getData(){ return data; }

/* ── lookups ────────────────────────────────────────────────────────────── */

export function getColl(id){ return data.collections.find(c => c.id === id); }
export function getSortedCollections(){ return [...data.collections].sort((a,b) => a.name.localeCompare(b.name)); }
export function getSub(collId, subId){
  const c = getColl(collId);
  return c ? c.subcollections.find(s => s.id === subId) : null;
}
export function getCard(collId, subId, cardId){
  const s = getSub(collId, subId);
  return s ? s.cards.find(c => c.id === cardId) : null;
}
export function ownedUnique(sub){ return sub.cards.filter(c => Number(c.qty||0) > 0).length; }

export function getFilteredCards(sub){
  const q = view.ledgerSearch.trim().toLowerCase();
  return sub.cards.filter(c => {
    if (view.ledgerRarityFilter && c.rarity !== view.ledgerRarityFilter) return false;
    if (q && !`${c.name} ${c.notes}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a,b) => (a.name||'').localeCompare(b.name||''));
}

/* ── linked slots ───────────────────────────────────────────────────────── */

// One physical card can fill a slot in several series. This indexes every such
// claim by the slot it points at.
export function buildLinkedSlotMap(){
  const map = {};
  data.collections.forEach(c => {
    (c.subcollections||[]).forEach(s => {
      (s.cards||[]).forEach(card => {
        if (Number(card.qty||0) <= 0) return;
        (card.linkedSlots||[]).forEach(link => {
          if (!link || !link.collId || !link.subId || !link.rarity || link.number == null) return;
          const key = link.collId+'|'+link.subId+'|'+link.rarity+'|'+link.number;
          map[key] = { card, homeCollId: c.id, homeSubId: s.id };
        });
      });
    });
  });
  return map;
}

/* ── binder layout ──────────────────────────────────────────────────────── */

export function buildBinderSlots(coll, sub, rarityFilter){
  const linkMap = buildLinkedSlotMap();
  const rarities = (sub.rarities||[]).filter(r => !rarityFilter || r.name === rarityFilter);
  const groups = rarities.map(r => {
    const cardsForRarity = sub.cards.filter(c => c.rarity === r.name);
    let maxNumber = 0;
    cardsForRarity.forEach(c => { if (c.number != null && Number(c.number) > maxNumber) maxNumber = Number(c.number); });
    Object.keys(linkMap).forEach(key => {
      const parts = key.split('|');
      if (parts[0]===coll.id && parts[1]===sub.id && parts[2]===r.name){
        const n = Number(parts[3]);
        if (n > maxNumber) maxNumber = n;
      }
    });
    const effectiveTotal = r.total || (maxNumber > 0 ? maxNumber : null);
    const isInferredTotal = !r.total && !!effectiveTotal;
    let slots;
    if (effectiveTotal){
      slots = [];
      for (let n=1; n<=effectiveTotal; n++){
        const card = cardsForRarity.find(c => Number(c.number)===n) || null;
        let linked = null;
        if (!card){
          const key = coll.id+'|'+sub.id+'|'+r.name+'|'+n;
          if (linkMap[key]) linked = linkMap[key];
        }
        slots.push({ number:n, card, linked });
      }
      const stray = cardsForRarity.filter(c => c.number==null || Number(c.number)<1 || Number(c.number)>effectiveTotal);
      stray.forEach(c => slots.push({ number: c.number ?? null, card: c, linked: null }));
    } else {
      slots = cardsForRarity.map(c => ({ number: c.number ?? null, card: c, linked: null }));
    }
    return { rarity: r, slots, effectiveTotal, isInferredTotal };
  });
  if (!rarityFilter){
    const knownNames = new Set((sub.rarities||[]).map(r => r.name));
    const orphan = sub.cards.filter(c => !knownNames.has(c.rarity));
    if (orphan.length){
      groups.push({
        rarity: { name:'Unsorted', color:'#8d94a8' },
        slots: orphan.map(c => ({ number: c.number ?? null, card: c, linked: null })),
        effectiveTotal: null,
        isInferredTotal: false,
      });
    }
  }
  return groups;
}

/* ── progress ───────────────────────────────────────────────────────────── */

export function subRarityBreakdown(coll, sub){
  const groups = buildBinderSlots(coll, sub, null);
  return groups.filter(g => g.rarity.name !== 'Unsorted').map(g => {
    const owned = g.slots.filter(s => (s.card && Number(s.card.qty||0) > 0) || s.linked).length;
    return { ...g.rarity, owned };
  });
}

export function subProgress(coll, sub){
  const breakdown = subRarityBreakdown(coll, sub);
  const owned = (sub.rarities && sub.rarities.length) ? breakdown.reduce((a,r) => a + r.owned, 0) : ownedUnique(sub);
  const perRarityTotal = breakdown.reduce((a,r) => a + (Number(r.total)||0), 0);
  const anyRarityTotal = breakdown.some(r => r.total);
  let total = null;
  if (anyRarityTotal) total = perRarityTotal;
  else if (sub.totalInSet) total = sub.totalInSet;
  if (!total) return { owned, total:null, pct:null, breakdown };
  return { owned, total, pct: Math.min(100, Math.round((owned/total)*100)), breakdown };
}

export function collProgress(coll){
  let owned=0, total=0, any=false;
  coll.subcollections.forEach(s => {
    const sp = subProgress(coll, s);
    owned += sp.owned;
    if (sp.total != null){ total += sp.total; any = true; }
  });
  if (!any) return { owned, total:null, pct:null };
  return { owned, total, pct: Math.min(100, Math.round((owned/total)*100)) };
}
