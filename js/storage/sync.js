// The sync engine.
//
// Model: local-first, last-write-wins per row. Every row carries `updatedAt`;
// when the same row changed on two devices, the later stamp wins and the other
// edit is dropped. That is the honest trade for a personal, single-user app —
// it is not a CRDT, and simultaneous edits to *the same card* on two devices
// will not merge field-by-field. Edits to different cards always both survive,
// which is the case that actually happens (add cards on the phone, tidy them
// up on the laptop).

import * as local from './local.js';
import * as sb from './supabase.js';

/* ── column mapping ─────────────────────────────────────────────────────── */

const MAPS = {
  collections: {
    id: 'id',
    name: 'name',
    publisher: 'publisher',
    color: 'color',
    hasLogo: 'has_logo',
    createdAt: 'created_at',
    logoUpdatedAt: 'logo_updated_at',
    updatedAt: 'updated_at',
    deletedAt: 'deleted_at',
  },
  subcollections: {
    id: 'id',
    collectionId: 'collection_id',
    name: 'name',
    totalInSet: 'total_in_set',
    rarities: 'rarities',
    hasBoxPhoto: 'has_box_photo',
    position: 'position',
    createdAt: 'created_at',
    boxPhotoUpdatedAt: 'box_photo_updated_at',
    updatedAt: 'updated_at',
    deletedAt: 'deleted_at',
  },
  cards: {
    id: 'id',
    subcollectionId: 'subcollection_id',
    name: 'name',
    rarity: 'rarity',
    number: 'number',
    qty: 'qty',
    effect: 'effect',
    condition: 'condition',
    notes: 'notes',
    linkedSlots: 'linked_slots',
    hasPhoto: 'has_photo',
    hasBackPhoto: 'has_back_photo',
    shape: 'shape',
    createdAt: 'created_at',
    photoUpdatedAt: 'photo_updated_at',
    backPhotoUpdatedAt: 'back_photo_updated_at',
    updatedAt: 'updated_at',
    deletedAt: 'deleted_at',
  },
};

// Defaults keep a sparse tombstone (which may carry nothing but an id) from
// tripping a NOT NULL column on the way up.
const DEFAULTS = {
  collections: { name: '', publisher: '', color: '#c9a227', has_logo: false },
  subcollections: { name: '', rarities: [], has_box_photo: false, position: 0 },
  cards: { name: '', rarity: '', qty: 0, effect: 'matte', condition: '', notes: '', linked_slots: [], has_photo: false, has_back_photo: false },
};

function toRemote(table, row, userId){
  const map = MAPS[table];
  const out = { ...DEFAULTS[table], user_id: userId };
  for (const [localKey, col] of Object.entries(map)){
    if (row[localKey] !== undefined) out[col] = row[localKey];
  }
  if (!out.created_at) out.created_at = row.updatedAt || new Date().toISOString();
  return out;
}

function fromRemote(table, row){
  const map = MAPS[table];
  const out = {};
  for (const [localKey, col] of Object.entries(map)){
    out[localKey] = row[col] ?? null;
  }
  out.deletedAt = row.deleted_at || null;
  return out;
}

/* ── data URL ⇄ Blob ────────────────────────────────────────────────────── */

function dataUrlToBlob(dataUrl){
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/* ── status ─────────────────────────────────────────────────────────────── */

const listeners = new Set();
let status = { state: 'off', message: 'Sync off', error: null, at: null };

export function onStatus(fn){
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

function setStatus(state, message, error = null, note = null){
  status = { state, message, error, note, at: new Date().toISOString() };
  listeners.forEach(fn => { try{ fn(status); }catch(e){ /* a broken listener must not stall a sync */ } });
}

export function getStatus(){ return status; }

export function refreshStatus(){
  if (!sb.isConfigured()) return setStatus('off', 'Sync off');
  if (!sb.isSignedIn()) return setStatus('error', 'Sign in to sync');
  if (!navigator.onLine) return setStatus('offline', 'Offline — changes queued');
  setStatus('synced', 'Sync ready');
}

/* ── push ───────────────────────────────────────────────────────────────── */

async function pushRows(userId){
  let pushed = 0;
  // Parent-first so a freshly created series never lands before its collection.
  for (const table of local.ROW_STORES){
    const rows = await local.dirtyRows(table);
    if (!rows.length) continue;
    // Chunked to keep any single request small enough to survive a flaky phone
    // connection.
    for (let i = 0; i < rows.length; i += 200){
      const chunk = rows.slice(i, i + 200);
      const stored = await sb.upsert(table, chunk.map(r => toRemote(table, r, userId)));
      // Adopt the server's stamp for what we just sent, so this device agrees
      // with the server about when the row changed and does not treat its own
      // upload as an incoming change on the next pull.
      const stamps = new Map();
      (stored || []).forEach(r => { if (r && r.id && r.updated_at) stamps.set(r.id, r.updated_at); });
      await local.markClean(table, chunk.map(r => r.id), stamps);
      pushed += chunk.length;
    }
  }
  return pushed;
}

async function pushBlobs(userId){
  const blobs = await local.dirtyBlobs();
  let pushed = 0;
  for (const b of blobs){
    const path = sb.objectPath(userId, b.key);
    if (b.deleted){
      await sb.removeObject(path);
      await local.dropBlobRecord(b.key);
    } else {
      await sb.uploadObject(path, dataUrlToBlob(b.dataUrl));
      await local.markBlobClean(b.key);
    }
    pushed++;
  }
  return pushed;
}

/* ── pull ───────────────────────────────────────────────────────────────── */

// Rows are stamped when their transaction starts but only become visible when
// it commits, so a row can appear with a stamp fractionally older than one this
// device has already seen. Asking for a little before the watermark covers that
// gap; re-delivered rows are recognised as unchanged and cost nothing.
const PULL_OVERLAP_MS = 30 * 1000;

function overlapped(since){
  if (!since) return null;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return since;
  return new Date(t - PULL_OVERLAP_MS).toISOString();
}

// A watermark set while devices stamped their own changes may sit in the
// future, which would keep hiding genuine edits even once the server takes
// over the stamping. Each device therefore starts from the beginning once, on
// its first sync after this release. Re-downloading is cheap and silent: rows
// that have not changed are recognised and skipped.
const PULL_SCHEME = 2;

async function ensurePullScheme(){
  const scheme = await local.meta.get('pullScheme', 1);
  if (scheme >= PULL_SCHEME) return;
  await local.meta.set('lastPulledAt', null);
  await local.meta.set('pullScheme', PULL_SCHEME);
}

async function pullRows(){
  await ensurePullScheme();
  const since = await local.meta.get('lastPulledAt', null);
  let applied = 0;
  let high = since;

  for (const table of local.ROW_STORES){
    const remote = await sb.selectSince(table, overlapped(since));
    for (const r of remote){
      if (!high || String(r.updated_at) > String(high)) high = r.updated_at;
      if (await local.applyRemoteRow(table, fromRemote(table, r))) applied++;
    }
  }

  // The watermark only ever holds a stamp the server wrote, so it stays on the
  // server's clock and no device's clock can push it out of reach of another's.
  if (high && high !== since) await local.meta.set('lastPulledAt', high);
  return applied;
}

// Reconciles photo blobs against the row flags: download anything referenced
// but missing or stale, drop anything the rows say is gone.
async function pullBlobs(userId){
  const rows = await local.loadRows();
  const wanted = [];

  rows.collections.forEach(c => {
    if (c.deletedAt) return;
    wanted.push({ key: local.logoKey(c.id), has: c.hasLogo, stamp: c.logoUpdatedAt });
  });
  rows.subcollections.forEach(s => {
    if (s.deletedAt) return;
    wanted.push({ key: local.boxPhotoKey(s.id), has: s.hasBoxPhoto, stamp: s.boxPhotoUpdatedAt });
    (s.rarities || []).forEach(r => {
      wanted.push({ key: local.rarityBackPhotoKey(s.id, r.id), has: r.hasSharedBack, stamp: r.sharedBackUpdatedAt });
    });
  });
  rows.cards.forEach(c => {
    if (c.deletedAt) return;
    wanted.push({ key: local.photoKey(c.id), has: c.hasPhoto, stamp: c.photoUpdatedAt });
    wanted.push({ key: local.photoBackKey(c.id), has: c.hasBackPhoto, stamp: c.backPhotoUpdatedAt });
  });

  let fetched = 0;
  let missing = 0;
  for (const { key, has, stamp } of wanted){
    const localStamp = await local.localBlobStamp(key);
    if (!has){
      if (localStamp) await local.dropBlobRecord(key);
      continue;
    }
    if (localStamp && (!stamp || String(localStamp) >= String(stamp))) continue;
    try{
      const blob = await sb.downloadObject(sb.objectPath(userId, key));
      // Not there yet — the device that owns it may not have finished
      // uploading. Leave it; a later sync will pick it up.
      if (!blob){ missing++; continue; }
      await local.putBlobFromRemote(key, await blobToDataUrl(blob), stamp || new Date().toISOString());
      fetched++;
    }catch(err){
      // One unreadable photo must not abort the sync and strand every other
      // change behind it.
      missing++;
    }
  }
  return { fetched, missing };
}

/* ── orchestration ──────────────────────────────────────────────────────── */

let running = null;
let queuedTimer = null;

// Runs a full round trip. Returns { changed } so the caller knows whether the
// on-screen tree needs rebuilding.
export async function sync({ silent = false } = {}){
  if (!sb.isConfigured()){ setStatus('off', 'Sync off'); return { changed: false, skipped: 'not-configured' }; }
  if (!sb.isSignedIn()){ setStatus('error', 'Sign in to sync'); return { changed: false, skipped: 'signed-out' }; }
  if (!navigator.onLine){ setStatus('offline', 'Offline — changes queued'); return { changed: false, skipped: 'offline' }; }
  if (running) return running;

  running = (async () => {
    if (!silent) setStatus('syncing', 'Syncing…');
    try{
      const user = sb.currentUser();
      if (!user || !user.id) throw new Error('No signed-in user.');

      // Photos go up before the rows that reference them. The reverse order
      // lets an interrupted sync leave a card on the server claiming a photo
      // that was never uploaded, which every other device would then hunt for
      // in vain.
      const pushedBlobs = await pushBlobs(user.id);
      const pushedRows = await pushRows(user.id);
      const appliedRows = await pullRows();
      const { fetched: fetchedBlobs, missing } = await pullBlobs(user.id);

      const changed = appliedRows > 0 || fetchedBlobs > 0;
      const moved = pushedRows + pushedBlobs + appliedRows + fetchedBlobs;
      setStatus('synced',
        moved ? `Synced · ${moved} change${moved === 1 ? '' : 's'}` : 'Up to date',
        null,
        missing ? `${missing} photo${missing === 1 ? '' : 's'} not uploaded yet` : null);
      return { changed, pushedRows, pushedBlobs, appliedRows, fetchedBlobs, missingBlobs: missing };
    }catch(err){
      setStatus('error', 'Sync failed', err.message || String(err));
      return { changed: false, error: err };
    }finally{
      running = null;
    }
  })();

  return running;
}

// Coalesces the bursts of saves a single edit produces into one round trip.
export function scheduleSync(delay = 2000){
  if (!sb.isConfigured() || !sb.isSignedIn()) return;
  clearTimeout(queuedTimer);
  queuedTimer = setTimeout(() => { sync({ silent: true }).then(afterSync); }, delay);
}

// Set by main.js so a pull that brought in remote changes can refresh the view.
let afterSync = () => {};
export function setAfterSync(fn){ afterSync = fn; }

export function startAutoSync(){
  window.addEventListener('online', () => { refreshStatus(); sync().then(afterSync); });
  window.addEventListener('offline', refreshStatus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync({ silent: true }).then(afterSync);
  });
  // A slow background poll is enough for a two-device personal app; realtime
  // subscriptions would be the upgrade if this ever feels stale.
  setInterval(() => {
    if (document.visibilityState === 'visible') sync({ silent: true }).then(afterSync);
  }, 5 * 60 * 1000);
}

export async function resetSyncWatermark(){
  await local.meta.set('lastPulledAt', null);
}
