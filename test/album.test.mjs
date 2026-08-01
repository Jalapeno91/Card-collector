// Turning a page in the Album.
//
// The point of most of these checks is that a finished turn *keeps* what is
// already on screen instead of rebuilding it. A rebuild re-reads every photo
// from IndexedDB, and the pockets show only their backing gradient until those
// come back — a flash of the whole spread a moment after the movement stopped.

import { connect } from './harness.mjs';

const t = await connect();
const { ev, wait, navigate, check, resetDatabase, send } = t;

// Pin a desktop-width window. Below 800px the album shows one page at a time
// and the spine collapses to nothing, so a default-sized headless window would
// quietly test the phone layout instead of the open book.
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TURN_SETTLE = 1000;  // TURN_MS in js/album.js is 620, plus its safety net

await navigate();
await resetDatabase();
await navigate();

// 18 cards fills two leaves exactly, so there is a spread to turn on to.
await ev(`(async()=>{
  const st = await import('/js/state.js');
  const s  = await import('/js/store.js');
  st.setData({ collections: [{
    id:'c1', name:'Paper Bride', color:'#b8594d', subcollections:[{
      id:'s1', name:'Series One',
      rarities:[{name:'Common',color:'#8899aa',total:18}],
      cards: Array.from({length:18},(_,i)=>({
        id:'k'+i, name:'Card '+(i+1), number:i+1, qty:1, rarity:'Common',
        effect:'matte', condition:'Mint', notes:'', linkedSlots:[],
        hasPhoto:true, hasBackPhoto:true,
      }))
    }]
  }]});
  await s.saveData();
  for (let i=0;i<18;i++){
    await s.setBlob(s.photoKey('k'+i), ${JSON.stringify(PNG)});
    await s.setBlob(s.photoBackKey('k'+i), ${JSON.stringify(PNG)});
  }
  st.nav.collectionId='c1'; st.nav.subId='s1'; st.view.mode='album'; st.view.albumSpread=0;
  (await import('/js/render.js')).render();
  return 1;
})()`);
await wait(700);

/* ── the open book ──────────────────────────────────────────────────────── */

check('the album is drawn as a book', await ev(`
  [!!document.querySelector('.album-book'), document.querySelectorAll('.album-spine i').length]`), [true, 3]);
check('nine pockets to a page', await ev(`document.querySelectorAll('.album-right .sleeve').length`), 9);
check('the first spread opens on the inside cover', await ev(`!!document.querySelector('.album-left .album-cover')`), true);
check('the pager knows where it is', await ev(`document.querySelector('#albumPager span').textContent.trim()`), 'Page 1 of 2');
check('and there is nowhere back to go', await ev(`
  [document.getElementById('albumFirst').disabled, document.getElementById('albumPrev').disabled]`), [true, true]);

/* ── the hinge ──────────────────────────────────────────────────────────── */

// A page is half the book wide, so it has to pivot on the middle of the spine
// to land on the opposite page. Hinging on its own edge leaves it a spine's
// width out, and it snaps sideways as the turn ends.
await ev(`(()=>{ document.getElementById('albumNext').click(); return 1; })()`);
check('a leaf turning forward hinges on the middle of the spine', await ev(`
  getComputedStyle(document.querySelector('.album-turn')).transformOrigin.split(' ')[0]`), '-13px');

// Tag the face that will be left towards the reader, so we can tell later
// whether it was moved into place or thrown away and built again.
await ev(`(()=>{
  document.querySelector('.album-turn-face.b .album-leaf').dataset.tag = 'carried';
  return 1;
})()`);
check('the page being turned on to is already underneath', await ev(`
  document.querySelectorAll('.album-right .sleeve').length`), 9);

await wait(TURN_SETTLE);

/* ── what the finished turn leaves behind ───────────────────────────────── */

check('the turn advances the spread', await ev(`(await import('/js/state.js')).view.albumSpread`), 1);
check('the turning layer is gone', await ev(`!!document.querySelector('.album-turn')`), false);
check('the leaf that turned was moved into the book, not rebuilt', await ev(`
  document.querySelector('.album-left .album-leaf').dataset.tag`), 'carried');
check('so its photos never left the page', await ev(`
  [...document.querySelectorAll('.album-left .pocket-face[data-face]')]
    .every(f => f.style.backgroundImage && f.style.backgroundImage !== 'none')`), true);
check('the left page is the leaf just turned, seen from behind', await ev(`
  [...document.querySelectorAll('.album-left .sleeve')].map(s=>s.dataset.id)`),
  ['k2','k1','k0','k5','k4','k3','k8','k7','k6']);  // columns reversed: it is the reverse of the page
check('the right page is the next leaf, seen from the front', await ev(`
  [...document.querySelectorAll('.album-right .sleeve')].map(s=>s.dataset.id)`),
  ['k9','k10','k11','k12','k13','k14','k15','k16','k17']);
check('both pages still carry their photos', await ev(`
  [...document.querySelectorAll('.album-side .pocket-face[data-face]')]
    .every(f => f.style.backgroundImage && f.style.backgroundImage !== 'none')`), true);

check('the pager caught up', await ev(`document.querySelector('#albumPager span').textContent.trim()`), 'Page 2 of 2');
check('and both ends are now reachable', await ev(`
  [document.getElementById('albumPrev').disabled, document.getElementById('albumNext').disabled]`), [false, false]);
check('a card on the moved page still opens', await ev(`
  typeof document.querySelector('.album-left .sleeve[data-id]').onclick`), 'function');
check('and one on the page underneath does too', await ev(`
  typeof document.querySelector('.album-right .sleeve[data-id]').onclick`), 'function');

/* ── and back again ─────────────────────────────────────────────────────── */

await ev(`(()=>{ document.getElementById('albumPrev').click(); return 1; })()`);
check('a leaf turning back hinges on the spine too', await ev(`(()=>{
  const o = getComputedStyle(document.querySelector('.album-turn')).transformOrigin.split(' ')[0];
  const w = document.querySelector('.album-turn').getBoundingClientRect().width;
  return Math.round(parseFloat(o) - w);  // 13px past its right edge
})()`), 13);
await ev(`(()=>{ const l=document.querySelector('.album-turn-face.b .album-leaf'); if(l) l.dataset.tag='carried-back'; return 1; })()`);
await wait(TURN_SETTLE);

check('turning back returns to the first spread', await ev(`(await import('/js/state.js')).view.albumSpread`), 0);
check('that leaf was moved into place as well', await ev(`
  document.querySelector('.album-right .album-leaf').dataset.tag`), 'carried-back');
check('the inside cover is showing again', await ev(`!!document.querySelector('.album-left .album-cover')`), true);
check('the pager went back with it', await ev(`document.querySelector('#albumPager span').textContent.trim()`), 'Page 1 of 2');

/* ── jumping, which does not animate ────────────────────────────────────── */

await ev(`(()=>{ document.getElementById('albumLast').click(); return 1; })()`);
await wait(400);
check('Last jumps to the end of the album', await ev(`(await import('/js/state.js')).view.albumSpread`), 2);
check('the end lays the last backs against the cover', await ev(`
  [!!document.querySelector('.album-right .album-cover'), document.querySelector('#albumPager span').textContent.trim()]`),
  [true, 'End of the album']);
check('and there is nowhere further to go', await ev(`
  [document.getElementById('albumNext').disabled, document.getElementById('albumLast').disabled]`), [true, true]);

await ev(`(()=>{ document.getElementById('albumFirst').click(); return 1; })()`);
await wait(400);
check('First comes back to the start', await ev(`(await import('/js/state.js')).view.albumSpread`), 0);
check('a jump leaves no turning layer behind either', await ev(`!!document.querySelector('.album-turn')`), false);

process.exit(t.finish('album') ? 0 : 1);
