// Local storage: CRUD through the real UI, persistence across reloads, the
// tree-diff that decides what is dirty, tombstones, and backup round trips.

import { connect } from './harness.mjs';

const t = await connect();
const { ev, wait, navigate, check } = t;

await navigate();
await t.resetDatabase();
await navigate();

console.log('\ncreate');
await ev(`document.getElementById('addTileHome').click()`);
await ev(`document.getElementById('collName').value = 'Paper Bride'`);
await ev(`document.getElementById('collColor').value = '#b8594d'`);
await ev(`document.getElementById('saveColl').click()`);
await wait(400);
check('collection in memory', await ev(`(await import('/js/state.js')).data.collections.map(c=>c.name)`), ['Paper Bride']);
check('collection tile rendered', await ev(`!!document.querySelector('.tile[data-coll]')`), true);

console.log('\npersistence');
await navigate();
check('collection survives reload', await ev(`(await import('/js/state.js')).data.collections.map(c=>c.name)`), ['Paper Bride']);
check('theme color survives reload', await ev(`(await import('/js/state.js')).data.collections[0].color`), '#b8594d');

console.log('\nseries with rarities');
await ev(`document.querySelector('.tile[data-coll]').click()`);
await wait(200);
await ev(`document.getElementById('addTileSub').click()`);
await ev(`document.getElementById('subName').value = 'Series 1'`);
await ev(`document.getElementById('newRarityName').value = 'SSR'`);
await ev(`document.getElementById('newRarityTotal').value = '3'`);
await ev(`document.getElementById('addRarityBtn').click()`);
await ev(`document.getElementById('saveSub').click()`);
await wait(400);
check('series saved with its rarity',
  await ev(`(await import('/js/state.js')).data.collections[0].subcollections.map(s=>[s.name, s.rarities.map(r=>r.name+':'+r.total)])`),
  [['Series 1', ['SSR:3']]]);

console.log('\ncards');
await ev(`document.querySelector('.tile[data-sub]').click()`);
await wait(200);
await ev(`document.getElementById('openAddCard').click()`);
await ev(`document.getElementById('fName').value = 'The Weeping Bride'`);
await ev(`document.getElementById('fNumber').value = '2'`);
await ev(`document.getElementById('fQty').value = '3'`);
await ev(`document.getElementById('saveCard').click()`);
await wait(400);
check('card saved with its fields',
  await ev(`(await import('/js/state.js')).data.collections[0].subcollections[0].cards.map(c=>[c.name,c.number,c.qty,c.rarity])`),
  [['The Weeping Bride', 2, 3, 'SSR']]);

console.log('\nphoto blobs');
await ev(`(async () => { const s = await import('/js/store.js'); await s.setBlob('card-photo:test', 'data:image/jpeg;base64,AAAA'); })()`);
check('blob reads back', await ev(`(await import('/js/store.js')).getBlob('card-photo:test')`), 'data:image/jpeg;base64,AAAA');
await navigate();
check('blob survives reload', await ev(`(await import('/js/store.js')).getBlob('card-photo:test')`), 'data:image/jpeg;base64,AAAA');

console.log('\nderived readings');
check('series progress counts one of three',
  await ev(`(async()=>{const st=await import('/js/state.js');const c=st.data.collections[0];const p=st.subProgress(c,c.subcollections[0]);return [p.owned,p.total,p.pct];})()`),
  [1, 3, 33]);
check('binder lays out every slot',
  await ev(`(async()=>{const st=await import('/js/state.js');const c=st.data.collections[0];const g=st.buildBinderSlots(c,c.subcollections[0],null);return g.map(x=>[x.rarity.name, x.slots.length, x.slots.filter(s=>s.card).length]);})()`),
  [['SSR', 3, 1]]);

console.log('\ndirty tracking');
check('everything is dirty before a first sync',
  await ev(`(async()=>{const l=await import('/js/storage/local.js');const d=await Promise.all(['collections','subcollections','cards'].map(s=>l.dirtyRows(s)));return d.map(x=>x.length);})()`),
  [1, 1, 1]);
await ev(`(async()=>{const l=await import('/js/storage/local.js');await l.markClean('cards',(await l.dirtyRows('cards')).map(r=>r.id));})()`);
await ev(`(async()=>{const s=await import('/js/store.js');await s.saveData();})()`);
check('a save that changes nothing re-dirties nothing',
  await ev(`(async()=>{const l=await import('/js/storage/local.js');return (await l.dirtyRows('cards')).length;})()`), 0);
await ev(`(async()=>{const st=await import('/js/state.js');const s=await import('/js/store.js');st.data.collections[0].subcollections[0].cards[0].qty=9;await s.saveData();})()`);
check('an edited row is marked dirty',
  await ev(`(async()=>{const l=await import('/js/storage/local.js');const d=await l.dirtyRows('cards');return d.map(r=>[r.name,r.qty,r.dirty]);})()`),
  [['The Weeping Bride', 9, 1]]);

console.log('\ndeletion');
await ev(`(async()=>{const st=await import('/js/state.js');const s=await import('/js/store.js');st.data.collections[0].subcollections[0].cards=[];await s.saveData();})()`);
check('delete writes a tombstone rather than dropping the row',
  await ev(`(async()=>{const i=await import('/js/lib/idb.js');const rows=await i.getAll('cards');return rows.map(r=>[r.name, !!r.deletedAt, r.dirty]);})()`),
  [['The Weeping Bride', true, 1]]);
await navigate();
check('tombstoned card is absent from the tree',
  await ev(`(await import('/js/state.js')).data.collections[0].subcollections[0].cards.length`), 0);

console.log('\nbackup');
await ev(`(async()=>{const st=await import('/js/state.js');const s=await import('/js/store.js');st.data.collections[0].subcollections[0].cards.push({id:'card1',name:'Restored',rarity:'SSR',number:1,qty:1,effect:'holo',condition:'Mint',notes:'',linkedSlots:[]});await s.saveData();})()`);
const backup = await ev(`(async()=>{const st=await import('/js/state.js');const s=await import('/js/store.js');return JSON.stringify({app:'the-ledger',version:2,data:st.data,photos:await s.collectAllPhotos()});})()`);
check('export contains the card', JSON.parse(backup).data.collections[0].subcollections[0].cards.map(c => c.name), ['Restored']);
await ev(`(async()=>{const i=await import('/js/lib/idb.js');await i.clearStores();})()`);
await navigate();
check('database is empty before restore', await ev(`(await import('/js/state.js')).data.collections.length`), 0);
await ev(`(async()=>{const s=await import('/js/store.js');const r=await import('/js/render.js');await s.restoreBackup(${JSON.stringify(JSON.parse(backup))});r.render();})()`);
await wait(500);
check('restore rebuilds the tree',
  await ev(`(async()=>{const st=await import('/js/state.js');const c=st.data.collections[0];return [c.name, c.subcollections[0].name, c.subcollections[0].cards.map(x=>x.name)];})()`),
  ['Paper Bride', 'Series 1', ['Restored']]);
await navigate();
check('restore is persisted',
  await ev(`(async()=>{const st=await import('/js/state.js');return st.data.collections[0].subcollections[0].cards.map(x=>[x.name,x.effect,x.condition]);})()`),
  [['Restored', 'holo', 'Mint']]);

process.exit(t.finish('storage') ? 0 : 1);
