// Offline shell for The Ledger.
//
// Collection data never passes through here — it lives in IndexedDB and syncs
// over the network directly. This only makes sure the app itself still opens
// when there is no signal.

// Bump on every release. The activate step deletes caches that don't match, so
// changing this is what forces a device onto the new files.
const VERSION = 'ledger-2026-08-01.3';
const SHELL = [
  './',
  'index.html',
  'css/ledger.css',
  'js/main.js',
  'js/ui.js',
  'js/state.js',
  'js/store.js',
  'js/render.js',
  'js/viewer.js',
  'js/album.js',
  'js/backup.js',
  'js/sync-ui.js',
  'js/scan.js',
  'js/lib/idb.js',
  'js/lib/scan-detect.js',
  'js/storage/local.js',
  'js/storage/sync.js',
  'js/storage/supabase.js',
  'js/modals/collection.js',
  'js/modals/series.js',
  'js/modals/card.js',
  'js/modals/confirm.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll is all-or-nothing; adding one at a time means a single missing
      // file can't leave the app with no cache at all.
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Supabase traffic must always hit the network — a cached reply would mean
  // syncing against stale data.
  if (url.hostname.endsWith('.supabase.co')) return;

  // App shell: serve from cache, refresh in the background.
  if (url.origin === location.origin){
    event.respondWith(
      caches.match(request).then(cached => {
        const network = fetch(request).then(res => {
          if (res && res.ok){
            const copy = res.clone();
            caches.open(VERSION).then(cache => cache.put(request, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Fonts: cache on first use so later offline loads keep their typography.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'){
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(cache => cache.put(request, copy));
        return res;
      }).catch(() => cached))
    );
  }
});
