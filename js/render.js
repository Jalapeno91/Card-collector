// All view rendering. Each function owns one screen and rewires its own
// handlers after writing markup.

import { el, escapeHtml, applyTheme, resetTheme, EFFECTS } from './ui.js';
import {
  data, nav, view,
  getColl, getSub, getSortedCollections, getFilteredCards, setLedgerSort,
  buildBinderSlots, collProgress, subProgress,
} from './state.js';
import { getBlob, logoKey, boxPhotoKey, photoKey } from './store.js';
import { renderAlbumView } from './album.js';
import { openAddCollection, openEditCollection, confirmDeleteCollection } from './modals/collection.js';
import { openAddSubcollection, openEditSubcollection, confirmDeleteSubcollection } from './modals/series.js';
import { openAddCard, openEditCard, confirmDeleteCard } from './modals/card.js';
import { openViewer, goToLinkedCard } from './viewer.js';

export function render(){
  renderSidebar();
  if (!nav.collectionId){ resetTheme(); renderHome(); }
  else{
    const coll = getColl(nav.collectionId);
    if (!coll){ nav.collectionId=null; nav.subId=null; resetTheme(); renderHome(); return; }
    applyTheme(coll.color);
    if (!nav.subId){ renderCollection(coll); }
    else{
      const sub = getSub(coll.id, nav.subId);
      if (!sub){ nav.subId=null; renderCollection(coll); return; }
      renderSubcollection(coll, sub);
    }
  }
  hydrateCollLogos();
}

function collLogoTag(coll, sizePx){
  return coll.hasLogo ? `<span class="coll-logo" data-logo-id="${coll.id}" style="width:${sizePx}px; height:${sizePx}px;"></span>` : '';
}

// Logos are stored as blobs, so the markup goes out first and the images fill
// in as they load.
function hydrateCollLogos(){
  const ids = new Set();
  document.querySelectorAll('.coll-logo[data-logo-id]').forEach(node => ids.add(node.dataset.logoId));
  ids.forEach(id => {
    getBlob(logoKey(id)).then(value => {
      if (!value) return;
      document.querySelectorAll(`.coll-logo[data-logo-id="${id}"]`).forEach(node => { node.style.backgroundImage = `url(${value})`; });
    }).catch(() => {});
  });
}

export function renderSidebar(){
  const list = el('collList');
  list.innerHTML = '';
  getSortedCollections().forEach(c => {
    const p = collProgress(c);
    const item = document.createElement('div');
    item.className = 'coll-item' + (nav.collectionId===c.id ? ' active':'');
    item.style.setProperty('--dot', c.color);
    item.innerHTML = `<div class="row">${collLogoTag(c, 18)}<span class="dot"></span><span class="nm">${escapeHtml(c.name)}</span>${p.pct===100 && p.total!=null ? '<span class="badge-complete-mini" title="Complete">✓</span>' : ''}</div>
      <div class="bar"><div class="bar-fill" style="width:${p.pct==null?0:p.pct}%"></div></div>`;
    item.onclick = () => { nav.collectionId = c.id; nav.subId = null; render(); };
    list.appendChild(item);
  });
}

function renderHome(){
  const main = el('mainView');
  const tiles = getSortedCollections().map(c => {
    const p = collProgress(c);
    return `<div class="tile" data-coll="${c.id}" style="--dot:${c.color}">
      <div class="topbar"></div>
      <div class="body">
        <div class="t-name">${collLogoTag(c, 28)} ${escapeHtml(c.name)}${p.pct===100 && p.total!=null ? ' <span class="badge-complete">✓ Complete</span>' : ''}</div>
        ${c.publisher ? `<div class="t-publisher">${escapeHtml(c.publisher)}</div>` : ''}
        <div class="t-meta">${c.subcollections.length} series · ${p.total!=null ? p.pct+'% complete' : 'no target set'}</div>
        <div class="bar"><div class="bar-fill" style="width:${p.pct==null?0:p.pct}%"></div></div>
      </div>
      <div class="tile-actions">
        <button data-act="edit-coll" data-id="${c.id}" title="Edit">✎</button>
        <button data-act="del-coll" data-id="${c.id}" title="Delete">✕</button>
      </div>
    </div>`;
  }).join('');

  main.innerHTML = `
    <h2 class="section-title">All Collections</h2>
    <div class="tile-grid">
      ${tiles}
      <div class="tile add-tile" id="addTileHome"><div>+ New collection</div></div>
    </div>
  `;

  main.querySelectorAll('.tile[data-coll]').forEach(t => {
    t.onclick = (e) => { if (e.target.closest('.tile-actions')) return; nav.collectionId = t.dataset.coll; nav.subId=null; render(); };
  });
  main.querySelectorAll('[data-act="edit-coll"]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openEditCollection(b.dataset.id); });
  main.querySelectorAll('[data-act="del-coll"]').forEach(b => b.onclick = (e) => { e.stopPropagation(); confirmDeleteCollection(b.dataset.id); });
  el('addTileHome').onclick = openAddCollection;
}

function renderCollection(coll){
  const main = el('mainView');
  const p = collProgress(coll);

  const tiles = coll.subcollections.map(s => {
    const sp = subProgress(coll, s);
    return `<div class="tile" data-sub="${s.id}" style="--dot:${coll.color}">
      <div class="topbar${s.hasBoxPhoto ? ' has-photo' : ''}" data-topper="${s.id}"></div>
      <div class="body">
        <div class="t-name">${escapeHtml(s.name)}${sp.pct===100 && sp.total!=null ? ' <span class="badge-complete">✓ Complete</span>' : ''}</div>
        <div class="t-meta">${sp.total!=null ? sp.owned+' / '+sp.total+' owned' : sp.owned+' logged · no target'}</div>
        <div class="bar"><div class="bar-fill" style="width:${sp.pct==null?0:sp.pct}%"></div></div>
      </div>
      <div class="tile-actions">
        <button data-act="edit-sub" data-id="${s.id}" title="Edit">✎</button>
        <button data-act="del-sub" data-id="${s.id}" title="Delete">✕</button>
      </div>
    </div>`;
  }).join('');

  main.innerHTML = `
    <div class="crumbs"><span id="crumbHome">All Collections</span><span class="sep">/</span>${escapeHtml(coll.name)}</div>
    ${coll.publisher ? `<div class="coll-publisher">Published by ${escapeHtml(coll.publisher)}</div>` : ''}
    <h2 class="section-title">${collLogoTag(coll, 32)}${escapeHtml(coll.name)}${p.pct===100 && p.total!=null ? ' <span class="badge-complete">✓ Complete</span>' : ''}
      <div class="header-actions">
        <button class="icon-btn" id="editCollBtn">Edit collection</button>
        <button class="icon-btn danger" id="delCollBtn">Delete</button>
      </div>
    </h2>
    <div class="progress-block">
      <div class="progress-label"><span>Collection progress</span><span>${p.total!=null ? p.owned+' / '+p.total+' ('+p.pct+'%)' : 'no targets set yet'}</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${p.pct==null?0:p.pct}%"></div></div>
    </div>
    <div class="tile-grid">
      ${tiles}
      <div class="tile add-tile" id="addTileSub"><div>+ New series</div></div>
    </div>
  `;

  el('crumbHome').onclick = () => { nav.collectionId=null; render(); };
  el('editCollBtn').onclick = () => openEditCollection(coll.id);
  el('delCollBtn').onclick = () => confirmDeleteCollection(coll.id);
  el('addTileSub').onclick = () => openAddSubcollection(coll.id);

  main.querySelectorAll('.tile[data-sub]').forEach(t => {
    t.onclick = (e) => { if (e.target.closest('.tile-actions')) return; nav.subId = t.dataset.sub; render(); };
  });
  main.querySelectorAll('[data-act="edit-sub"]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openEditSubcollection(coll.id, b.dataset.id); });
  main.querySelectorAll('[data-act="del-sub"]').forEach(b => b.onclick = (e) => { e.stopPropagation(); confirmDeleteSubcollection(coll.id, b.dataset.id); });

  coll.subcollections.filter(s => s.hasBoxPhoto).forEach(async s => {
    try{
      const value = await getBlob(boxPhotoKey(s.id));
      if (value){
        const node = main.querySelector(`[data-topper="${s.id}"]`);
        if (node) node.style.backgroundImage = `url(${value})`;
      }
    }catch(e){ /* photo missing — leave the flat color topbar */ }
  });
}

function renderRarityBreakdownHtml(sp){
  if (!sp.breakdown || sp.breakdown.length === 0) return '';
  return `<div class="rarity-breakdown">
    ${sp.breakdown.map(r => {
      const pct = r.total ? Math.min(100, Math.round((r.owned/r.total)*100)) : null;
      return `<div class="rb-row">
        <span class="rb-name" style="color:${r.color}">${escapeHtml(r.name)}${pct===100 ? '<span class="badge-complete-mini" title="Complete">✓</span>' : ''}</span>
        <div class="rb-bar"><div class="rb-fill" style="width:${pct==null?0:pct}%; background:${r.color};"></div></div>
        <span class="rb-count">${r.total!=null ? r.owned+' / '+r.total : r.owned+' owned'}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderSubcollection(coll, sub){
  const main = el('mainView');
  const sp = subProgress(coll, sub);
  if (sub.id !== view.lastBinderSubId){
    view.binderPage = 0;
    view.lastBinderSubId = sub.id;
  }

  main.innerHTML = `
    <div class="crumbs">
      <span id="crumbHome">All Collections</span><span class="sep">/</span>
      <span id="crumbColl">${escapeHtml(coll.name)}</span><span class="sep">/</span>${escapeHtml(sub.name)}
    </div>
    ${sub.hasBoxPhoto ? `<div class="series-banner" id="seriesBanner"></div>` : ''}
    <h2 class="section-title">${collLogoTag(coll, 28)}${escapeHtml(sub.name)}${sp.pct===100 && sp.total!=null ? ' <span class="badge-complete">✓ Complete</span>' : ''}
      <div class="header-actions">
        <button class="icon-btn" id="editSubBtn">Edit series</button>
        <button class="icon-btn danger" id="delSubBtn">Delete</button>
      </div>
    </h2>
    <div class="progress-block">
      <div class="progress-label"><span>Series progress</span><span>${sp.total!=null ? sp.owned+' / '+sp.total+' ('+sp.pct+'%)' : sp.owned+' unique cards logged'}</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${sp.pct==null?0:sp.pct}%"></div></div>
      ${sp.total==null ? `<div class="progress-empty-note">No target set — <button id="setTargetBtn">set a total, or quantities per rarity</button> to track completion.</div>` : ''}
    </div>
    ${renderRarityBreakdownHtml(sp)}
    <div class="toolbar">
      <input type="text" class="search" id="searchInput" placeholder="Search by card name or notes…" value="${escapeHtml(view.ledgerSearch)}" />
      <select class="rarity-filter" id="rarityFilter"><option value="">All rarities</option></select>
      ${view.mode === 'ledger' ? `<select class="rarity-filter" id="ledgerSort">
        <option value="name">Sort: A–Z</option>
        <option value="rarity">Sort: by rarity</option>
      </select>` : ''}
      <div class="view-toggle">
        <button data-mode="ledger" class="${view.mode==='ledger'?'active':''}">Ledger</button>
        <button data-mode="binder" class="${view.mode==='binder'?'active':''}">Binder</button>
        <button data-mode="album" class="${view.mode==='album'?'active':''}">Album</button>
        <button data-mode="overview" class="${view.mode==='overview'?'active':''}">Overview</button>
      </div>
      <button class="btn-primary" id="openAddCard">+ Add card</button>
    </div>
    <div id="ledgerWrap"></div>
  `;

  el('crumbHome').onclick = () => { nav.collectionId=null; nav.subId=null; render(); };
  el('crumbColl').onclick = () => { nav.subId=null; render(); };
  el('editSubBtn').onclick = () => openEditSubcollection(coll.id, sub.id);
  el('delSubBtn').onclick = () => confirmDeleteSubcollection(coll.id, sub.id);
  const setTargetBtn = el('setTargetBtn');
  if (setTargetBtn) setTargetBtn.onclick = () => openEditSubcollection(coll.id, sub.id);

  if (sub.hasBoxPhoto){
    getBlob(boxPhotoKey(sub.id)).then(value => {
      if (value){ const banner = el('seriesBanner'); if (banner) banner.style.backgroundImage = `url(${value})`; }
    }).catch(() => {});
  }

  const rf = el('rarityFilter');
  (sub.rarities||[]).forEach(r => { const o=document.createElement('option'); o.value=r.name; o.textContent=r.name; rf.appendChild(o); });
  rf.value = view.ledgerRarityFilter;
  rf.onchange = () => { view.ledgerRarityFilter = rf.value; renderContent(coll, sub); };
  // Only rendered in the Ledger view — the Binder and Album have an order of
  // their own that this would have no say over.
  const ls = el('ledgerSort');
  if (ls){
    ls.value = view.ledgerSort;
    ls.onchange = () => { setLedgerSort(ls.value); renderContent(coll, sub); };
  }
  el('searchInput').oninput = (e) => { view.ledgerSearch = e.target.value; renderContent(coll, sub); };
  el('openAddCard').onclick = () => openAddCard(coll.id, sub.id);

  main.querySelectorAll('.view-toggle button').forEach(b => {
    b.onclick = () => { view.mode = b.dataset.mode; view.binderPage = 0; view.albumSpread = 0; renderSubcollection(coll, sub); };
  });

  renderContent(coll, sub);
}

function renderContent(coll, sub){
  if (view.mode === 'binder') renderBinderView(coll, sub);
  else if (view.mode === 'album') renderAlbumView(coll, sub);
  else if (view.mode === 'overview') renderOverviewView(coll, sub);
  else renderLedgerRows(coll, sub);
}

function renderLedgerRows(coll, sub){
  const cards = getFilteredCards(sub);
  const wrap = el('ledgerWrap');

  if (cards.length === 0){
    wrap.innerHTML = `<div class="empty-state">
      <div class="stamp">${sub.cards.length===0 ? 'No cards logged yet' : 'No cards match'}</div>
      <div>${sub.cards.length===0 ? 'Add your first card to this series.' : 'Try a different search or filter.'}</div>
    </div>`;
    return;
  }

  let rows = `<div class="ledger-row head">
    <div>Card</div><div class="rarity-cell">Rarity</div><div class="fx-cell">Effect</div><div class="cond-cell">Condition</div><div>Qty</div><div></div>
  </div>`;
  // A heading at each change of rarity. It only shows on a narrow screen,
  // where the Rarity column is hidden — without it, ordering by rarity there
  // would look like no order at all.
  let groupSoFar = null;
  cards.forEach(c => {
    const rarity = (sub.rarities||[]).find(r => r.name === c.rarity);
    if (view.ledgerSort === 'rarity' && c.rarity !== groupSoFar){
      groupSoFar = c.rarity;
      rows += `<div class="ledger-group"${rarity ? ` style="color:${rarity.color};"` : ''}>${escapeHtml(c.rarity || 'No rarity')}</div>`;
    }
    const fx = EFFECTS[c.effect] || EFFECTS.matte;
    rows += `<div class="ledger-row" data-id="${c.id}">
      <div class="cell-name">${escapeHtml(c.name)}${c.hasPhoto ? ' <span title="Has a photo" style="opacity:.7;">📷</span>' : ''}${c.linkedSlots && c.linkedSlots.length ? ' <span title="Also counts toward other series" style="opacity:.7;">🔗</span>' : ''}</div>
      <div class="rarity-cell">${rarity ? `<span class="pill" style="border-color:${rarity.color}; color:${rarity.color};">${escapeHtml(rarity.name)}${c.number!=null ? ' #'+c.number : ''}</span>` : '—'}</div>
      <div class="fx-cell fx-tag">${fx.glyph} ${fx.label}</div>
      <div class="cond-cell">${escapeHtml(c.condition||'—')}</div>
      <div class="qty">×${Number(c.qty||0)}</div>
      <div class="row-actions">
        <button data-act="view" title="View in 3D">◎</button>
        <button data-act="edit" title="Edit">✎</button>
        <button data-act="del" class="danger" title="Delete">✕</button>
      </div>
    </div>`;
  });
  wrap.innerHTML = `<div class="ledger">${rows}</div>`;

  wrap.querySelectorAll('.ledger-row[data-id]').forEach(row => {
    const id = row.dataset.id;
    row.onclick = (e) => {
      const act = e.target.dataset.act;
      if (act === 'edit'){ openEditCard(coll.id, sub.id, id); return; }
      if (act === 'del'){ confirmDeleteCard(coll.id, sub.id, id); return; }
      openViewer(coll, sub, id);
    };
  });
}

function renderBinderView(coll, sub){
  const groups = buildBinderSlots(coll, sub, view.ledgerRarityFilter);
  const flat = [];
  groups.forEach(g => g.slots.forEach(s => flat.push({ ...s, rarity: g.rarity })));

  const wrap = el('ledgerWrap');
  const pageSize = 9;

  if (flat.length === 0){
    const hasRarities = (sub.rarities||[]).length > 0;
    wrap.innerHTML = `<div class="empty-state">
      <div class="stamp">${hasRarities ? 'No slots to show' : 'No rarities defined yet'}</div>
      <div>${hasRarities ? 'Try a different rarity filter.' : 'Edit this series to add rarities with a quantity, and the binder will lay out every slot.'}</div>
    </div>`;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(flat.length/pageSize));
  if (view.binderPage >= totalPages) view.binderPage = totalPages-1;
  if (view.binderPage < 0) view.binderPage = 0;
  const start = view.binderPage*pageSize;
  const pageSlots = flat.slice(start, start+pageSize);

  const pockets = pageSlots.map(s => {
    if (s.linked){
      const homeColl = getColl(s.linked.homeCollId);
      return `<div class="pocket linked-pocket" data-linked-coll="${s.linked.homeCollId}" data-linked-sub="${s.linked.homeSubId}" data-linked-card="${s.linked.card.id}" style="--rc:${s.rarity.color};">
        <div class="pocket-face" style="background:linear-gradient(160deg, ${homeColl?homeColl.color:'#555'} 0%, #14161d 85%);">
          <div class="pocket-mono">🔗</div>
          <div class="pocket-name">${escapeHtml(s.linked.card.name)}</div>
        </div>
        <div class="pocket-foot"><span style="color:${s.rarity.color}">${escapeHtml(s.rarity.name)}${s.number!=null ? ' #'+s.number : ''}</span><span>linked</span></div>
      </div>`;
    }
    if (!s.card){
      return `<div class="pocket empty-pocket" data-rarity="${escapeHtml(s.rarity.name)}" data-number="${s.number ?? ''}" style="--rc:${s.rarity.color};">
        <div class="pocket-face empty"><div class="pocket-slot-number">${s.number!=null ? '#'+s.number : '+'}</div></div>
        <div class="pocket-foot"><span style="color:${s.rarity.color}">${escapeHtml(s.rarity.name)}</span><span>empty</span></div>
      </div>`;
    }
    const c = s.card;
    return `<div class="pocket" data-id="${c.id}">
      <div class="pocket-face" data-face="${c.id}" style="--rc:${s.rarity.color}; background:linear-gradient(160deg, ${coll.color} 0%, #14161d 85%);">
        ${c.hasPhoto ? '' : `<div class="pocket-mono">${escapeHtml((c.name||'?').trim().charAt(0).toUpperCase())}</div>`}
        <div class="pocket-name">${escapeHtml(c.name)}</div>
      </div>
      <div class="pocket-foot">
        <span style="color:${s.rarity.color}">${escapeHtml(s.rarity.name)}${s.number!=null ? ' #'+s.number : ''}</span>
        <span>×${Number(c.qty||0)}</span>
      </div>
      <div class="tile-actions">
        <button data-act="edit-card" data-id="${c.id}" title="Edit">✎</button>
        <button data-act="del-card" data-id="${c.id}" title="Delete">✕</button>
      </div>
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="binder-page">${pockets}</div>
    <div class="binder-pager">
      <button id="binderFirst" class="edge" title="First page" ${view.binderPage===0?'disabled':''}>« First</button>
      <button id="binderPrev" ${view.binderPage===0?'disabled':''}>‹ Prev</button>
      <span>Page ${view.binderPage+1} of ${totalPages}</span>
      <button id="binderNext" ${view.binderPage>=totalPages-1?'disabled':''}>Next ›</button>
      <button id="binderLast" class="edge" title="Last page" ${view.binderPage>=totalPages-1?'disabled':''}>Last »</button>
    </div>
  `;

  wrap.querySelectorAll('.pocket[data-id]').forEach(p => {
    p.onclick = (e) => { if (e.target.closest('.tile-actions')) return; openViewer(coll, sub, p.dataset.id); };
  });
  wrap.querySelectorAll('[data-act="edit-card"]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openEditCard(coll.id, sub.id, b.dataset.id); });
  wrap.querySelectorAll('[data-act="del-card"]').forEach(b => b.onclick = (e) => { e.stopPropagation(); confirmDeleteCard(coll.id, sub.id, b.dataset.id); });
  wrap.querySelectorAll('.pocket.empty-pocket').forEach(p => {
    p.onclick = () => openAddCard(coll.id, sub.id, { rarity: p.dataset.rarity, number: p.dataset.number ? Number(p.dataset.number) : null });
  });
  wrap.querySelectorAll('.pocket.linked-pocket').forEach(p => {
    p.onclick = () => goToLinkedCard(p.dataset.linkedColl, p.dataset.linkedSub, p.dataset.linkedCard);
  });
  const firstBtn = el('binderFirst'); if (firstBtn) firstBtn.onclick = () => { view.binderPage = 0; renderBinderView(coll, sub); };
  const prevBtn = el('binderPrev'); if (prevBtn) prevBtn.onclick = () => { view.binderPage--; renderBinderView(coll, sub); };
  const nextBtn = el('binderNext'); if (nextBtn) nextBtn.onclick = () => { view.binderPage++; renderBinderView(coll, sub); };
  const lastBtn = el('binderLast'); if (lastBtn) lastBtn.onclick = () => { view.binderPage = totalPages-1; renderBinderView(coll, sub); };

  pageSlots.filter(s => s.card && s.card.hasPhoto).forEach(s => {
    getBlob(photoKey(s.card.id)).then(value => {
      if (!value) return;
      const face = wrap.querySelector(`.pocket-face[data-face="${s.card.id}"]`);
      if (!face) return;
      face.style.backgroundImage = `url(${value})`;
      face.style.backgroundSize = 'cover';
      face.style.backgroundPosition = 'center';
      face.style.backgroundRepeat = 'no-repeat';
    }).catch(() => {});
  });
}

function renderOverviewView(coll, sub){
  const groups = buildBinderSlots(coll, sub, view.ledgerRarityFilter);
  const wrap = el('ledgerWrap');

  if (groups.length === 0 || groups.every(g => g.slots.length === 0)){
    wrap.innerHTML = `<div class="empty-state">
      <div class="stamp">Nothing to show yet</div>
      <div>Edit this series to add rarities with a quantity, and the whole binder will lay out here at a glance.</div>
    </div>`;
    return;
  }

  const sections = groups.map(g => {
    const owned = g.slots.filter(s => (s.card && Number(s.card.qty||0) > 0) || s.linked).length;
    const isComplete = g.rarity.total && owned >= g.rarity.total;
    const label = g.rarity.total ? `${owned} / ${g.rarity.total}`
      : g.isInferredTotal ? `${owned} / ${g.effectiveTotal}+ (no target set)`
      : `${owned} owned`;
    const chips = g.slots.map(s => {
      if (s.linked){
        return `<div class="slot-chip linked" data-linked-coll="${s.linked.homeCollId}" data-linked-sub="${s.linked.homeSubId}" data-linked-card="${s.linked.card.id}" style="background:${g.rarity.color};" title="${escapeHtml(s.linked.card.name)} — linked from another series${s.number!=null ? ' · #'+s.number : ''}">${s.number!=null ? s.number : '🔗'}</div>`;
      }
      if (s.card){
        return `<div class="slot-chip filled" data-id="${s.card.id}" style="background:${g.rarity.color};" title="${escapeHtml(s.card.name)}${s.number!=null ? ' · #'+s.number : ''}">${s.number!=null ? s.number : '✓'}</div>`;
      }
      return `<div class="slot-chip empty" data-rarity="${escapeHtml(g.rarity.name)}" data-number="${s.number ?? ''}" style="border-color:${g.rarity.color};" title="Empty — click to add${s.number!=null ? ' #'+s.number : ''}">${s.number!=null ? s.number : '?'}</div>`;
    }).join('');
    return `<div class="overview-section">
      <div class="overview-head"><span style="color:${g.rarity.color}">${escapeHtml(g.rarity.name)}${isComplete ? ' <span class="badge-complete-mini" title="Complete">✓</span>' : ''}</span><span>${label}</span></div>
      <div class="overview-chips">${chips}</div>
    </div>`;
  }).join('');

  wrap.innerHTML = `<div class="overview-wrap">${sections}</div>`;

  wrap.querySelectorAll('.slot-chip.filled').forEach(c => {
    c.onclick = () => openViewer(coll, sub, c.dataset.id);
  });
  wrap.querySelectorAll('.slot-chip.empty').forEach(c => {
    c.onclick = () => openAddCard(coll.id, sub.id, { rarity: c.dataset.rarity, number: c.dataset.number ? Number(c.dataset.number) : null });
  });
  wrap.querySelectorAll('.slot-chip.linked').forEach(c => {
    c.onclick = () => goToLinkedCard(c.dataset.linkedColl, c.dataset.linkedSub, c.dataset.linkedCard);
  });
}
