// The app-facing storage facade. Views and modals talk to this and never to
// IndexedDB or Supabase directly.

import { setData, getData } from './state.js';
import * as local from './storage/local.js';
import * as sync from './storage/sync.js';

export async function loadData(){
  setData(await local.loadTree());
}

// Every mutation path ends here: persist the tree, then let sync catch up in
// the background. Saving never waits on the network.
export async function saveData(){
  await local.saveTree(getData());
  sync.scheduleSync();
}

export {
  getBlob, setBlob, deleteBlob,
  logoKey, boxPhotoKey, photoKey, photoBackKey,
} from './storage/local.js';

/* ── backup / restore ───────────────────────────────────────────────────── */

export async function collectAllPhotos(){
  const tree = getData();
  const keys = [];
  tree.collections.forEach(c => {
    if (c.hasLogo) keys.push(local.logoKey(c.id));
    (c.subcollections||[]).forEach(s => {
      if (s.hasBoxPhoto) keys.push(local.boxPhotoKey(s.id));
      (s.cards||[]).forEach(card => {
        if (card.hasPhoto) keys.push(local.photoKey(card.id));
        if (card.hasBackPhoto) keys.push(local.photoBackKey(card.id));
      });
    });
  });
  const photos = {};
  for (const key of keys){
    const value = await local.getBlob(key);
    if (value) photos[key] = value;
  }
  return photos;
}

// Replaces everything local with the contents of a backup file. The restored
// rows are written as fresh local edits, so they win the last-write-wins
// comparison and propagate to the other devices on the next sync.
export async function restoreBackup(parsed){
  await local.replaceAll({ collections: [], subcollections: [], cards: [] }, []);
  await local.loadTree(); // resets the diff shadow to empty

  const photos = parsed.photos || {};
  for (const key of Object.keys(photos)){
    await local.setBlob(key, photos[key]);
  }

  setData(parsed.data);
  await local.saveTree(getData());
  await loadData();
  sync.scheduleSync(500);
}
