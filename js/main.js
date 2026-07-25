// Entry point: wire the shell, load what's on this device, then let sync catch
// up in the background.

import { el } from './ui.js';
import { nav } from './state.js';
import { loadData } from './store.js';
import { render } from './render.js';
import { openAddCollection } from './modals/collection.js';
import { initViewer } from './viewer.js';
import { initBackup } from './backup.js';
import { initSyncUi } from './sync-ui.js';
import * as sync from './storage/sync.js';
import * as sb from './storage/supabase.js';

el('homeBtn').onclick = () => { nav.collectionId = null; nav.subId = null; render(); };
el('addCollBtn').onclick = openAddCollection;

// Escape closes whatever is on top.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const viewer = el('viewerOverlay');
  if (viewer.classList.contains('open')){ viewer.classList.remove('open'); return; }
  const open = [...document.querySelectorAll('.overlay.open')].pop();
  if (open) open.classList.remove('open');
});

/* ── install prompt ─────────────────────────────────────────────────────── */

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  el('installBtn').classList.add('visible');
});
el('installBtn').onclick = async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  el('installBtn').classList.remove('visible');
};
window.addEventListener('appinstalled', () => el('installBtn').classList.remove('visible'));

/* ── service worker ─────────────────────────────────────────────────────── */

if ('serviceWorker' in navigator && location.protocol !== 'file:'){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline support is a bonus; the app is fully usable without it.
    });
  });
}

/* ── boot ───────────────────────────────────────────────────────────────── */

initViewer();
initBackup();
initSyncUi();

await loadData();
render();

sync.startAutoSync();
if (sb.isConfigured() && sb.isSignedIn()){
  sync.sync().then(async (result) => {
    if (result && result.changed){ await loadData(); render(); }
  });
}
