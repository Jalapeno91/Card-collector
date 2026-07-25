// Export/import of the whole archive as a single JSON file.
//
// The format is deliberately unchanged from the original single-file version of
// the app, so a backup taken there imports here untouched — that is the
// migration path off the old artifact build.

import { el, showToast } from './ui.js';
import { data, nav } from './state.js';
import { collectAllPhotos, restoreBackup, loadData } from './store.js';
import { openConfirm } from './modals/confirm.js';
import { render } from './render.js';

export async function exportBackup(){
  showToast('Preparing backup…');
  const photos = await collectAllPhotos();
  const payload = { app:'the-ledger', version:2, exportedAt: new Date().toISOString(), data, photos };
  const blob = new Blob([JSON.stringify(payload)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url; a.download = `card-ledger-backup-${stamp}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Backup downloaded');
}

async function performRestore(parsed){
  try{
    await restoreBackup(parsed);
  }catch(e){
    showToast('Restore failed — the backup may be corrupt');
    return;
  }
  nav.collectionId = null;
  nav.subId = null;
  await loadData();
  render();
  showToast('Backup restored');
}

export function initBackup(){
  el('exportBackupBtn').onclick = exportBackup;
  el('importBackupBtn').onclick = () => el('importBackupInput').click();
  el('importBackupInput').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      let parsed;
      try{ parsed = JSON.parse(ev.target.result); }
      catch(err){ showToast('That file is not a valid backup'); e.target.value=''; return; }
      if (!parsed || !parsed.data || !Array.isArray(parsed.data.collections)){
        showToast('That file is not a valid backup'); e.target.value=''; return;
      }
      openConfirm(
        'Restore this backup?',
        `This replaces everything currently in the app — collections, series, cards, and photos — with the contents of this file${parsed.exportedAt ? ' (exported '+new Date(parsed.exportedAt).toLocaleDateString()+')' : ''}. This can't be undone.`,
        () => performRestore(parsed),
        { okLabel: 'Restore backup', okColor: 'var(--accent)' }
      );
      e.target.value = '';
    };
    reader.onerror = () => showToast('Could not read that file');
    reader.readAsText(file);
  };
}
