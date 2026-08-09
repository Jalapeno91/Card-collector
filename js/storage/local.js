// Local-first store.
//
// The app works with a nested tree (collections → subcollections → cards)
// because that is what every render function expects. On disk we keep flat
// rows with per-row `updatedAt`/`deletedAt`/`dirty`, which is what sync needs:
// it lets two devices merge card-by-card instead of clobbering whole documents.
//
// The bridge between the two is `saveTree`, which diffs the tree against a
// shadow snapshot of what was last persisted and only stamps rows that
// actually changed.

import * as idb from '../lib/idb.js';

export const ROW_STORES = ['collections', 'subcollections', 'cards'];

// key → ISO stamp of the last local write, so the tree diff can record when a
// photo changed without every caller having to thread that through.
const blobStamps = new Map();

// store → Map(id → JSON of comparable fields), rebuilt on load.
let shadow = { collections: new Map(), subcollections: new Map(), cards: new Map() };

const now = () => new Date().toISOString();

/* ── row ⇄ tree ─────────────────────────────────────────────────────────── */

function collectionRow(c){
  return {
    id: c.id,
    name: c.name,
    publisher: c.publisher || '',
    color: c.color,
    hasLogo: !!c.hasLogo,
    createdAt: c.createdAt || now(),
    logoUpdatedAt: blobStamps.get(logoKey(c.id)) || null,
  };
}

function subcollectionRow(s, collectionId, position){
  return {
    id: s.id,
    collectionId,
    name: s.name,
    totalInSet: s.totalInSet ?? null,
    // Rarities are re-shaped here (rather than stored verbatim) so a stray
    // field left over from an older build never lingers in what gets synced,
    // and so `hasSharedBack`/`sharedBackUpdatedAt` always reflect the blob
    // that is actually on disk right now rather than whatever the in-memory
    // tree happened to be carrying.
    rarities: (s.rarities || []).map(r => ({
      id: r.id,
      name: r.name,
      color: r.color,
      total: r.total ?? null,
      namePrefix: r.namePrefix || '',
      defaultEffect: r.defaultEffect || 'matte',
      sharedBack: !!r.sharedBack,
      hasSharedBack: !!r.hasSharedBack,
      sharedBackUpdatedAt: blobStamps.get(rarityBackPhotoKey(s.id, r.id)) || null,
    })),
    hasBoxPhoto: !!s.hasBoxPhoto,
    position,
    createdAt: s.createdAt || now(),
    boxPhotoUpdatedAt: blobStamps.get(boxPhotoKey(s.id)) || null,
  };
}

function cardRow(c, subcollectionId){
  return {
    id: c.id,
    subcollectionId,
    name: c.name,
    rarity: c.rarity || '',
    number: c.number ?? null,
    qty: Number(c.qty || 0),
    effect: c.effect || 'matte',
    condition: c.condition || '',
    notes: c.notes || '',
    linkedSlots: c.linkedSlots || [],
    hasPhoto: !!c.hasPhoto,
    hasBackPhoto: !!c.hasBackPhoto,
    shape: c.shape || null,
    createdAt: c.createdAt || now(),
    photoUpdatedAt: blobStamps.get(photoKey(c.id)) || null,
    backPhotoUpdatedAt: blobStamps.get(photoBackKey(c.id)) || null,
  };
}

function flattenTree(tree){
  const out = { collections: [], subcollections: [], cards: [] };
  (tree.collections || []).forEach(c => {
    out.collections.push(collectionRow(c));
    (c.subcollections || []).forEach((s, i) => {
      out.subcollections.push(subcollectionRow(s, c.id, i));
      (s.cards || []).forEach(card => out.cards.push(cardRow(card, s.id)));
    });
  });
  return out;
}

function hydrateTree(rows){
  const live = arr => arr.filter(r => !r.deletedAt);
  const subsByColl = new Map();
  live(rows.subcollections)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.createdAt).localeCompare(String(b.createdAt)))
    .forEach(s => {
      if (!subsByColl.has(s.collectionId)) subsByColl.set(s.collectionId, []);
      subsByColl.get(s.collectionId).push(s);
    });

  const cardsBySub = new Map();
  live(rows.cards).forEach(c => {
    if (!cardsBySub.has(c.subcollectionId)) cardsBySub.set(c.subcollectionId, []);
    cardsBySub.get(c.subcollectionId).push(c);
  });

  const collections = live(rows.collections).map(c => ({
    id: c.id,
    name: c.name,
    publisher: c.publisher || '',
    color: c.color,
    hasLogo: !!c.hasLogo,
    createdAt: c.createdAt,
    subcollections: (subsByColl.get(c.id) || []).map(s => ({
      id: s.id,
      name: s.name,
      totalInSet: s.totalInSet ?? null,
      rarities: s.rarities || [],
      hasBoxPhoto: !!s.hasBoxPhoto,
      createdAt: s.createdAt,
      cards: (cardsBySub.get(s.id) || []).map(c => ({
        id: c.id,
        name: c.name,
        rarity: c.rarity,
        number: c.number ?? null,
        qty: Number(c.qty || 0),
        effect: c.effect || 'matte',
        condition: c.condition || '',
        notes: c.notes || '',
        linkedSlots: c.linkedSlots || [],
        hasPhoto: !!c.hasPhoto,
        hasBackPhoto: !!c.hasBackPhoto,
        shape: c.shape || null,
        createdAt: c.createdAt,
      })),
    })),
  }));

  return { collections };
}

// Key order is not meaningful, but JSON.stringify preserves it, so two equal
// rows built by different code paths — or round-tripped through the server's
// JSON columns — would otherwise compare as different.
function stableStringify(value){
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object'){
    return '{' + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

// The fields a diff should notice. Sync bookkeeping is deliberately excluded so
// a pull that only refreshes `updatedAt` doesn't look like a local edit.
function comparable(row){
  const { updatedAt, deletedAt, dirty, ...rest } = row;
  return stableStringify(rest);
}

/* ── blob keys ──────────────────────────────────────────────────────────── */

export const logoKey = collId => 'collection-logo:' + collId;
export const boxPhotoKey = subId => 'box-photo:' + subId;
export const photoKey = cardId => 'card-photo:' + cardId;
export const photoBackKey = cardId => 'card-photo-back:' + cardId;
export const rarityBackPhotoKey = (subId, rarityId) => 'rarity-back-photo:' + subId + ':' + rarityId;

/* ── public API ─────────────────────────────────────────────────────────── */

export async function loadRows(){
  const [collections, subcollections, cards] = await Promise.all(
    ROW_STORES.map(s => idb.getAll(s))
  );
  return { collections, subcollections, cards };
}

export async function loadTree(){
  const rows = await loadRows();
  shadow = { collections: new Map(), subcollections: new Map(), cards: new Map() };
  ROW_STORES.forEach(store => {
    rows[store].forEach(r => { if (!r.deletedAt) shadow[store].set(r.id, comparable(r)); });
  });

  const blobs = await idb.getAll('blobs');
  blobStamps.clear();
  blobs.forEach(b => { if (!b.deleted) blobStamps.set(b.key, b.updatedAt); });

  return hydrateTree(rows);
}

// Diffs `tree` against the last persisted snapshot, writing only what moved.
// Rows that vanished from the tree become tombstones so the deletion can sync.
// Returns the number of rows touched.
export async function saveTree(tree){
  const next = flattenTree(tree);
  const stamp = now();
  let touched = 0;

  for (const store of ROW_STORES){
    const writes = [];
    const seen = new Set();

    for (const row of next[store]){
      seen.add(row.id);
      const before = shadow[store].get(row.id);
      const after = comparable(row);
      if (before === after) continue;
      writes.push({ ...row, updatedAt: stamp, deletedAt: null, dirty: 1 });
      shadow[store].set(row.id, after);
    }

    for (const id of [...shadow[store].keys()]){
      if (seen.has(id)) continue;
      const existing = await idb.get(store, id);
      writes.push({ ...(existing || { id }), id, updatedAt: stamp, deletedAt: stamp, dirty: 1 });
      shadow[store].delete(id);
    }

    if (writes.length){
      await idb.putMany(store, writes);
      touched += writes.length;
    }
  }

  return touched;
}

/* ── blobs (photos and logos, held as data URLs) ────────────────────────── */

export async function getBlob(key){
  const row = await idb.get('blobs', key);
  return row && !row.deleted ? row.dataUrl : null;
}

export async function setBlob(key, dataUrl){
  const stamp = now();
  await idb.put('blobs', { key, dataUrl, updatedAt: stamp, deleted: false, dirty: 1 });
  blobStamps.set(key, stamp);
}

export async function deleteBlob(key){
  const stamp = now();
  const existing = await idb.get('blobs', key);
  // Nothing was ever stored under this key, so there is nothing to tell the
  // server about either.
  if (!existing){ blobStamps.delete(key); return; }
  await idb.put('blobs', { key, dataUrl: null, updatedAt: stamp, deleted: true, dirty: 1 });
  blobStamps.delete(key);
}

// Used by the sync engine when the server hands us a photo we don't have.
export async function putBlobFromRemote(key, dataUrl, updatedAt){
  await idb.put('blobs', { key, dataUrl, updatedAt, deleted: false, dirty: 0 });
  blobStamps.set(key, updatedAt);
}

export async function localBlobStamp(key){
  const row = await idb.get('blobs', key);
  return row && !row.deleted ? row.updatedAt : null;
}

/* ── sync support ───────────────────────────────────────────────────────── */

export async function dirtyRows(store){
  const all = await idb.getAll(store);
  return all.filter(r => r.dirty);
}

export async function dirtyBlobs(){
  const all = await idb.getAll('blobs');
  return all.filter(b => b.dirty);
}

// `stamps` maps row id to the updated_at the server recorded. Adopting it keeps
// this device's idea of when a row changed identical to the server's.
export async function markClean(store, ids, stamps){
  if (!ids.length) return;
  const rows = [];
  for (const id of ids){
    const row = await idb.get(store, id);
    if (!row) continue;
    const stamp = stamps && stamps.get(id);
    rows.push({ ...row, dirty: 0, updatedAt: stamp || row.updatedAt });
  }
  await idb.putMany(store, rows);
}

export async function markBlobClean(key){
  const row = await idb.get('blobs', key);
  if (row) await idb.put('blobs', { ...row, dirty: 0 });
}

// Applies a row that came from the server. Local dirty edits win only when they
// are strictly newer, which is the last-write-wins rule the whole engine uses.
export async function applyRemoteRow(store, row){
  const local = await idb.get(store, row.id);
  if (local && local.dirty && String(local.updatedAt) > String(row.updatedAt)) return false;
  // Already holding exactly this row — usually one re-delivered by the pull's
  // overlap window. Writing it again would be reported as an incoming change
  // and reload the views for nothing.
  if (local && !local.dirty
      && String(local.updatedAt) === String(row.updatedAt)
      && comparable(local) === comparable(row)) return false;
  await idb.put(store, { ...row, dirty: 0 });
  return true;
}

export async function replaceAll(rows, blobs){
  await idb.clearStores(['collections', 'subcollections', 'cards', 'blobs']);
  for (const store of ROW_STORES){
    if (rows[store] && rows[store].length) await idb.putMany(store, rows[store]);
  }
  if (blobs && blobs.length) await idb.putMany('blobs', blobs);
}

export const meta = { get: idb.getMeta, set: idb.setMeta };
export { flattenTree, hydrateTree };

// Hard-removes a blob record without leaving a tombstone. Used by the pull
// path, where the removal came *from* the server and must not be echoed back.
export async function dropBlobRecord(key){
  await idb.del('blobs', key);
  blobStamps.delete(key);
}

// Marks every local row and photo as unsent, so the next sync pushes the whole
// device up. The escape hatch for "this device has the copy I want to keep" —
// after switching accounts, or recovering from a server-side mess.
//
// The stamps move forward too. Sending rows back up under their original dates
// used to leave them older than what the other device had already downloaded,
// so the other device ignored every one of them and the button did nothing.
export async function markAllDirty(){
  const stamp = now();
  for (const store of ROW_STORES){
    const rows = await idb.getAll(store);
    if (rows.length) await idb.putMany(store, rows.map(r => ({ ...r, dirty: 1, updatedAt: stamp })));
  }
  const blobs = await idb.getAll('blobs');
  if (blobs.length) await idb.putMany('blobs', blobs.map(b => ({ ...b, dirty: 1 })));
}
