// Ordering the Ledger list: A–Z, or by the series' own rarity order.
//
// The rarities here are deliberately named so that alphabetical order and the
// series' order disagree — "Rare" is listed first but sorts second — because a
// sort that quietly used the names would still look right on a Common/SSR
// series and only go wrong on someone else's.

import { connect } from './harness.mjs';

const t = await connect();
const { ev, navigate, check, resetDatabase } = t;

await navigate();
await resetDatabase();
await navigate();

// Seed: two known rarities in a deliberate order, plus a card carrying a
// rarity the series has never heard of.
await ev(`(async()=>{
  const st = await import('/js/state.js');
  const s  = await import('/js/store.js');
  st.setData({ collections: [{
    id:'c1', name:'Paper Bride', color:'#b8594d', subcollections:[{
      id:'s1', name:'Series One',
      rarities:[{name:'Rare',color:'#c9a227',total:4},{name:'Common',color:'#8899aa',total:4}],
      cards:[
        { id:'k1', name:'Zebra',    rarity:'Common', number:2,    qty:1, effect:'matte', condition:'Mint', notes:'', linkedSlots:[] },
        { id:'k2', name:'Apple',    rarity:'Common', number:1,    qty:1, effect:'matte', condition:'Mint', notes:'', linkedSlots:[] },
        { id:'k3', name:'Mango',    rarity:'Rare',   number:2,    qty:1, effect:'gold',  condition:'Mint', notes:'', linkedSlots:[] },
        { id:'k4', name:'Cherry',   rarity:'Rare',   number:1,    qty:1, effect:'matte', condition:'Mint', notes:'', linkedSlots:[] },
        { id:'k5', name:'Banana',   rarity:'Common', number:null, qty:1, effect:'matte', condition:'Mint', notes:'', linkedSlots:[] },
        { id:'k6', name:'Damson',   rarity:'Common', number:null, qty:1, effect:'matte', condition:'Mint', notes:'', linkedSlots:[] },
        { id:'k7', name:'Orphan',   rarity:'Legendary', number:1, qty:1, effect:'matte', condition:'Mint', notes:'', linkedSlots:[] },
      ]
    }]
  }]});
  await s.saveData();
  st.nav.collectionId='c1'; st.nav.subId='s1';
  return 1;
})()`);

const names = () => ev(`(async()=>{
  const st = await import('/js/state.js');
  return st.getFilteredCards(st.data.collections[0].subcollections[0]).map(c=>c.name);
})()`);

const setSort = v => ev(`(async()=>{ (await import('/js/state.js')).view.ledgerSort=${JSON.stringify(v)}; return 1; })()`);

/* ── the two orders ─────────────────────────────────────────────────────── */

check('default order is A–Z', await ev(`(await import('/js/state.js')).view.ledgerSort`), 'name');
check('A–Z ignores rarity', await names(),
  ['Apple','Banana','Cherry','Damson','Mango','Orphan','Zebra']);

await setSort('rarity');
// Rare before Common because the series lists them that way, each group by
// printed number, unnumbered cards after numbered ones, unknown rarity last.
check('by rarity follows the series order, not the alphabet', await names(),
  ['Cherry','Mango','Apple','Zebra','Banana','Damson','Orphan']);

/* ── the pieces of that order, stated on their own ──────────────────────── */

check('numbered cards run by number inside a rarity', await ev(`(async()=>{
  const st = await import('/js/state.js');
  const cards = st.getFilteredCards(st.data.collections[0].subcollections[0]);
  return cards.filter(c=>c.rarity==='Rare').map(c=>[c.name,c.number]);
})()`), [['Cherry',1],['Mango',2]]);

check('unnumbered cards follow the numbered ones, A–Z', await ev(`(async()=>{
  const st = await import('/js/state.js');
  const cards = st.getFilteredCards(st.data.collections[0].subcollections[0]);
  return cards.filter(c=>c.rarity==='Common').map(c=>c.name);
})()`), ['Apple','Zebra','Banana','Damson']);

check('a rarity the series does not know lands last', await names().then(n => n[n.length-1]), 'Orphan');

/* ── sorting must not disturb anything else ─────────────────────────────── */

check('the stored order is left alone', await ev(`(async()=>{
  const st = await import('/js/state.js');
  return st.data.collections[0].subcollections[0].cards.map(c=>c.id);
})()`), ['k1','k2','k3','k4','k5','k6','k7']);

check('the search box still filters while sorted by rarity', await ev(`(async()=>{
  const st = await import('/js/state.js');
  st.view.ledgerSearch = 'an';
  const out = st.getFilteredCards(st.data.collections[0].subcollections[0]).map(c=>c.name);
  st.view.ledgerSearch = '';
  return out;
})()`), ['Mango','Banana','Orphan']);  // M-an-go, B-an-ana, Orph-an — still in rarity order

check('the rarity filter still applies while sorted by rarity', await ev(`(async()=>{
  const st = await import('/js/state.js');
  st.view.ledgerRarityFilter = 'Common';
  const out = st.getFilteredCards(st.data.collections[0].subcollections[0]).map(c=>c.name);
  st.view.ledgerRarityFilter = '';
  return out;
})()`), ['Apple','Zebra','Banana','Damson']);

/* ── the control, and what the page actually shows ──────────────────────── */

const renderIn = mode => ev(`(async()=>{
  const st = await import('/js/state.js'); const r = await import('/js/render.js');
  st.view.mode=${JSON.stringify(mode)}; r.render();
  return 1;
})()`);

await setSort('name');
await renderIn('ledger');
check('the sort control is offered in the Ledger', await ev(`!!document.getElementById('ledgerSort')`), true);
check('it opens on the order in use', await ev(`document.getElementById('ledgerSort').value`), 'name');
check('rows are drawn A–Z', await ev(`[...document.querySelectorAll('.ledger-row[data-id] .cell-name')].map(n=>n.textContent.trim())`),
  ['Apple','Banana','Cherry','Damson','Mango','Orphan','Zebra']);

// Change it the way a person would, rather than by setting state directly.
await ev(`(()=>{ const s=document.getElementById('ledgerSort'); s.value='rarity'; s.onchange(); return 1; })()`);
check('choosing "by rarity" redraws the rows in that order', await ev(`[...document.querySelectorAll('.ledger-row[data-id] .cell-name')].map(n=>n.textContent.trim())`),
  ['Cherry','Mango','Apple','Zebra','Banana','Damson','Orphan']);
check('the choice sticks in view state', await ev(`(await import('/js/state.js')).view.ledgerSort`), 'rarity');

/* ── rarity headings, for the screens with no Rarity column ─────────────── */

check('a heading marks each change of rarity', await ev(`[...document.querySelectorAll('.ledger-group')].map(g=>g.textContent.trim())`),
  ['Rare','Common','Legendary']);
check('one heading per group, not one per card', await ev(`document.querySelectorAll('.ledger-group').length`), 3);
check('headings are not clickable rows', await ev(`document.querySelectorAll('.ledger-group[data-id]').length`), 0);
check('a heading takes its rarity colour', await ev(`document.querySelector('.ledger-group').style.color`), 'rgb(201, 162, 39)');
check('and none appear when sorting A–Z', await ev(`(async()=>{
  const st=await import('/js/state.js'); const r=await import('/js/render.js');
  st.view.ledgerSort='name'; r.render();
  const n = document.querySelectorAll('.ledger-group').length;
  st.view.ledgerSort='rarity'; r.render();
  return n;
})()`), 0);

await renderIn('binder');
check('the Binder does not offer it — it has an order of its own', await ev(`!!document.getElementById('ledgerSort')`), false);
await renderIn('album');
check('nor does the Album', await ev(`!!document.getElementById('ledgerSort')`), false);

await renderIn('ledger');
check('returning to the Ledger keeps the chosen order', await ev(`document.getElementById('ledgerSort').value`), 'rarity');

/* ── the choice outlives the session ────────────────────────────────────── */

check('choosing an order writes it down', await ev(`localStorage.getItem('ledger-sort')`), 'rarity');
check('the filters that hide cards are not written down', await ev(`
  [localStorage.getItem('ledger-search'), localStorage.getItem('ledger-rarity-filter')]`), [null, null]);

await navigate();  // a fresh page, as if the app had been closed and reopened
check('it comes back on the order chosen last time', await ev(`(await import('/js/state.js')).view.ledgerSort`), 'rarity');
check('and the control opens on it', await ev(`(async()=>{
  const st=await import('/js/state.js'); const r=await import('/js/render.js');
  st.nav.collectionId='c1'; st.nav.subId='s1'; st.view.mode='ledger'; r.render();
  return document.getElementById('ledgerSort').value;
})()`), 'rarity');

check('switching back to A–Z is remembered too', await ev(`(async()=>{
  const st=await import('/js/state.js');
  st.setLedgerSort('name');
  return localStorage.getItem('ledger-sort');
})()`), 'name');

// Storage is shared with anything else on the origin and can be edited by
// hand, so a value the app does not recognise must not leave it sorting by
// nothing at all.
await ev(`(()=>{ localStorage.setItem('ledger-sort','sideways'); return 1; })()`);
await navigate();
check('a stored value that makes no sense falls back to A–Z',
  await ev(`(await import('/js/state.js')).view.ledgerSort`), 'name');

check('setting an order that makes no sense is refused too', await ev(`(async()=>{
  const st=await import('/js/state.js');
  st.setLedgerSort('sideways');
  return [st.view.ledgerSort, localStorage.getItem('ledger-sort')];
})()`), ['name','name']);

/* ── a series with no rarities defined at all ───────────────────────────── */

check('no rarities defined is not an error', await ev(`(async()=>{
  const st = await import('/js/state.js');
  const sub = { rarities: [], cards: [
    { id:'x1', name:'Second', rarity:'', number:2, qty:1, notes:'' },
    { id:'x2', name:'First',  rarity:'', number:1, qty:1, notes:'' },
  ]};
  return st.getFilteredCards(sub).map(c=>c.name);
})()`), ['First','Second']);

process.exit(t.finish('ledger-sort') ? 0 : 1);
