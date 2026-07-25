// The sync engine, driven against an in-page fake Supabase: push, pull, column
// mapping, photo objects, soft deletes in both directions, and offline queueing.

import { connect } from './harness.mjs';

const t = await connect();
const { ev, navigate, check } = t;

await navigate();
await t.resetDatabase();
await navigate();

// A stand-in for PostgREST, GoTrue and Storage, small enough to reason about.
await ev(`(() => {
  const server = { tables: { collections: [], subcollections: [], cards: [] }, objects: {}, requests: [] };
  window.__server = server;
  window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    server.requests.push(method + ' ' + u.pathname);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (u.pathname.startsWith('/auth/v1/token')) {
      return json({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600, user: { id: 'user-1', email: 'me@example.com' } });
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      const table = u.pathname.split('/')[3];
      if (method === 'POST') {
        JSON.parse(init.body).forEach(row => {
          const i = server.tables[table].findIndex(r => r.id === row.id && r.user_id === row.user_id);
          if (i >= 0) server.tables[table][i] = row; else server.tables[table].push(row);
        });
        return new Response('', { status: 201 });
      }
      const since = (u.searchParams.get('updated_at') || '').replace('gt.', '');
      return json(server.tables[table].filter(r => !since || String(r.updated_at) > since));
    }
    if (u.pathname.startsWith('/storage/v1/object/')) {
      const path = u.pathname.replace('/storage/v1/object/card-photos/', '');
      if (method === 'POST') { server.objects[path] = init.body; return json({ Key: path }); }
      if (method === 'DELETE') { delete server.objects[path]; return json({}); }
      if (!server.objects[path]) return new Response('', { status: 404 });
      return new Response(server.objects[path], { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  return 1;
})()`);

console.log('\nauth');
await ev(`(async () => {
  const sb = await import('/js/storage/supabase.js');
  sb.setConfig('https://test.supabase.co', 'anon-key');
  await sb.signIn('me@example.com', 'pw');
  return 1;
})()`);
check('signs in and keeps the session', await ev(`(await import('/js/storage/supabase.js')).currentUser().email`), 'me@example.com');

console.log('\npush');
await ev(`(async () => {
  const st = await import('/js/state.js');
  const s = await import('/js/store.js');
  st.data.collections.push({ id:'c1', name:'Paper Bride', publisher:'Panini', color:'#b8594d', hasLogo:false, subcollections:[
    { id:'s1', name:'Series 1', totalInSet:null, rarities:[{id:'r1',name:'SSR',color:'#8ab6ff',total:3}], hasBoxPhoto:false, cards:[
      { id:'k1', name:'The Weeping Bride', rarity:'SSR', number:2, qty:3, effect:'holo', condition:'Mint', notes:'n', linkedSlots:[] }
    ]}
  ]});
  await s.setBlob('card-photo:k1', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  st.data.collections[0].subcollections[0].cards[0].hasPhoto = true;
  await s.saveData();
  return 1;
})()`);

const push = await ev(`(async () => (await import('/js/storage/sync.js')).sync())()`);
check('pushes every row and the photo', [push.pushedRows, push.pushedBlobs], [3, 1]);
check('all three tables land', await ev(`[__server.tables.collections.length, __server.tables.subcollections.length, __server.tables.cards.length]`), [1, 1, 1]);
check('card columns are snake_case', await ev(`Object.keys(__server.tables.cards[0]).sort().join(',')`),
  'back_photo_updated_at,condition,created_at,deleted_at,effect,has_back_photo,has_photo,id,linked_slots,name,notes,number,photo_updated_at,qty,rarity,subcollection_id,updated_at,user_id');
check('card values map correctly',
  await ev(`(({name,qty,number,effect,rarity,subcollection_id,user_id,has_photo}) => [name,qty,number,effect,rarity,subcollection_id,user_id,has_photo])(__server.tables.cards[0])`),
  ['The Weeping Bride', 3, 2, 'holo', 'SSR', 's1', 'user-1', true]);
check('rarities travel as JSON', await ev(`__server.tables.subcollections[0].rarities.map(r=>r.name+':'+r.total)`), ['SSR:3']);
check('publisher is pushed', await ev(`__server.tables.collections[0].publisher`), 'Panini');
check('photo lands in the owner folder', await ev(`Object.keys(__server.objects)`), ['user-1/card-photo__k1']);
check('pushed rows are marked clean',
  await ev(`(async()=>{const l=await import('/js/storage/local.js');const d=await Promise.all(['collections','subcollections','cards'].map(s=>l.dirtyRows(s)));return d.map(x=>x.length);})()`),
  [0, 0, 0]);

console.log('\npull');
await ev(`(() => {
  const later = new Date(Date.now() + 60000).toISOString();
  __server.tables.cards.push({ id:'k2', user_id:'user-1', subcollection_id:'s1', name:'From The Phone', rarity:'SSR', number:1, qty:1,
    effect:'shiny', condition:'NM', notes:'added elsewhere', linked_slots:[], has_photo:false, has_back_photo:false,
    photo_updated_at:null, back_photo_updated_at:null, created_at:later, updated_at:later, deleted_at:null });
  return 1;
})()`);
const pull = await ev(`(async () => (await import('/js/storage/sync.js')).sync())()`);
check('pull reports the change', [pull.appliedRows, pull.changed], [1, true]);
await ev(`(async () => { const s = await import('/js/store.js'); const r = await import('/js/render.js'); await s.loadData(); r.render(); return 1; })()`);
check('a card added elsewhere appears here',
  await ev(`(async()=>{const st=await import('/js/state.js');return st.data.collections[0].subcollections[0].cards.map(c=>[c.name,c.effect,c.condition]).sort();})()`),
  [['From The Phone', 'shiny', 'NM'], ['The Weeping Bride', 'holo', 'Mint']]);

console.log('\nphoto download');
await ev(`(() => {
  const later = new Date(Date.now() + 120000).toISOString();
  __server.objects['user-1/card-photo__k2'] = new Blob([new Uint8Array([255,216,255,224])], { type:'image/jpeg' });
  const row = __server.tables.cards.find(r => r.id === 'k2');
  row.has_photo = true; row.photo_updated_at = later; row.updated_at = later;
  return 1;
})()`);
const pull2 = await ev(`(async () => (await import('/js/storage/sync.js')).sync())()`);
check('a photo referenced but missing gets fetched', pull2.fetchedBlobs, 1);
check('fetched photo is stored as a data URL',
  await ev(`(async()=>{const s=await import('/js/store.js');const v=await s.getBlob('card-photo:k2');return !!v && v.startsWith('data:image/jpeg;base64,');})()`), true);

console.log('\ndeletion');
await ev(`(async () => {
  const st = await import('/js/state.js'); const s = await import('/js/store.js');
  const sub = st.data.collections[0].subcollections[0];
  sub.cards = sub.cards.filter(c => c.id !== 'k1');
  await s.saveData();
  return 1;
})()`);
await ev(`(async () => (await import('/js/storage/sync.js')).sync())()`);
check('a local delete soft-deletes on the server', await ev(`!!__server.tables.cards.find(r=>r.id==='k1').deleted_at`), true);
check('unrelated rows are untouched', await ev(`!__server.tables.cards.find(r=>r.id==='k2').deleted_at`), true);

await ev(`(() => {
  const later = new Date(Date.now() + 180000).toISOString();
  const row = __server.tables.cards.find(r => r.id === 'k2');
  row.deleted_at = later; row.updated_at = later;
  return 1;
})()`);
await ev(`(async () => { const sy = await import('/js/storage/sync.js'); await sy.sync(); const s = await import('/js/store.js'); await s.loadData(); return 1; })()`);
check('a remote delete removes the card here',
  await ev(`(async()=>{const st=await import('/js/state.js');return st.data.collections[0].subcollections[0].cards.length;})()`), 0);

console.log('\na photo the server does not have');
// The failure this guards against: a row arrives claiming a photo whose upload
// never landed. Storage answers 400/not_found, and treating that as fatal used
// to block every future sync on the device — including unrelated changes.
await ev(`(() => {
  const later = new Date(Date.now() + 240000).toISOString();
  __server.tables.cards.push({ id:'k9', user_id:'user-1', subcollection_id:'s1', name:'Photo Never Uploaded', rarity:'SSR',
    number:3, qty:1, effect:'matte', condition:'', notes:'', linked_slots:[], has_photo:true, has_back_photo:false,
    photo_updated_at:later, back_photo_updated_at:null, created_at:later, updated_at:later, deleted_at:null });
  // No object is placed in __server.objects for it, and Storage reports the
  // absence the way Supabase actually does.
  const inner = window.fetch;
  window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.includes('/storage/v1/object/') && (init.method || 'GET').toUpperCase() === 'GET'
        && !__server.objects[u.pathname.replace('/storage/v1/object/card-photos/','')]) {
      return new Response(JSON.stringify({ statusCode:'404', error:'not_found', message:'Object not found' }),
        { status: 400, headers: { 'Content-Type':'application/json' } });
    }
    return inner(url, init);
  };
  return 1;
})()`);
const withMissing = await ev(`(async () => { const r = await (await import('/js/storage/sync.js')).sync(); return { ...r, error: r.error ? String(r.error.message || r.error) : null }; })()`);
check('sync survives a photo that is not there', withMissing.error, null);
check('the absence is counted, not thrown', withMissing.missingBlobs, 1);
check('status stays healthy', await ev(`(async()=>(await import('/js/storage/sync.js')).getStatus().state)()`), 'synced');
await ev(`(async () => { const s = await import('/js/store.js'); await s.loadData(); return 1; })()`);
check('the card itself still arrives',
  await ev(`(async()=>{const st=await import('/js/state.js');return st.data.collections[0].subcollections[0].cards.some(c=>c.name==='Photo Never Uploaded');})()`), true);
// And once the photo does land, a later sync picks it up.
await ev(`(() => { __server.objects['user-1/card-photo__k9'] = new Blob([new Uint8Array([255,216,255,224])], { type:'image/jpeg' }); return 1; })()`);
const late = await ev(`(async () => (await import('/js/storage/sync.js')).sync())()`);
check('a late-arriving photo is picked up afterwards', late.fetchedBlobs, 1);

console.log('\nre-upload from this device');
await ev(`(async () => {
  const st = await import('/js/state.js'); const s = await import('/js/store.js');
  st.data.collections[0].subcollections[0].cards.push({ id:'k3', name:'Kept Locally', rarity:'SSR', number:2, qty:1,
    effect:'matte', condition:'', notes:'', linkedSlots:[] });
  await s.saveData();
  const sy = await import('/js/storage/sync.js');
  await sy.sync();
  return 1;
})()`);
// Simulate the server losing everything, as happens when the account is deleted
// and recreated: the local rows are clean, so an ordinary sync pushes nothing.
await ev(`(() => { __server.tables.collections = []; __server.tables.subcollections = []; __server.tables.cards = []; __server.objects = {}; return 1; })()`);
const idle = await ev(`(async () => (await import('/js/storage/sync.js')).sync())()`);
check('an ordinary sync pushes nothing when rows are clean', idle.pushedRows, 0);
check('server really is empty', await ev(`__server.tables.cards.length`), 0);
await ev(`(async () => { const l = await import('/js/storage/local.js'); await l.markAllDirty(); return 1; })()`);
const reup = await ev(`(async () => (await import('/js/storage/sync.js')).sync())()`);
check('re-upload pushes every row again', reup.pushedRows >= 3, true);
check('re-upload pushes the photos again', reup.pushedBlobs >= 1, true);
// Tombstones ride along too, so deletions made here are not forgotten by the
// server — only the live rows should read back as present.
check('the locally-kept cards are back on the server',
  await ev(`__server.tables.cards.filter(c=>!c.deleted_at).map(c=>c.name).sort()`),
  ['Kept Locally', 'Photo Never Uploaded']);
check('deletions are re-uploaded as tombstones, not resurrected',
  await ev(`__server.tables.cards.filter(c=>c.deleted_at).map(c=>c.name).sort()`), ['From The Phone', 'The Weeping Bride']);

console.log('\noffline');
await ev(`(Object.defineProperty(navigator,'onLine',{value:false,configurable:true}), 1)`);
const off = await ev(`(async () => (await import('/js/storage/sync.js')).sync())()`);
check('offline is a skip, not a failure', [off.skipped, off.changed], ['offline', false]);
check('status reflects being offline', await ev(`(async()=>(await import('/js/storage/sync.js')).getStatus().state)()`), 'offline');

process.exit(t.finish('sync') ? 0 : 1);
