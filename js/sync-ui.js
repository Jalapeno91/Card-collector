// The sync settings modal and the status pill in the sidebar.

import { el, showToast } from './ui.js';
import * as sb from './storage/supabase.js';
import * as sync from './storage/sync.js';
import * as local from './storage/local.js';
import { loadData } from './store.js';
import { openConfirm } from './modals/confirm.js';
import { render } from './render.js';

function setError(msg){
  const box = el('syncError');
  box.textContent = msg || '';
  box.style.display = msg ? '' : 'none';
}

function setLog(msg){
  el('syncLog').textContent = msg || '';
}

function refreshModal(){
  const { url, anonKey } = sb.getConfig();
  el('syncUrl').value = url;
  el('syncKey').value = anonKey;

  const configured = sb.isConfigured();
  const signedIn = sb.isSignedIn();
  el('syncAuthSection').style.display = configured ? '' : 'none';
  el('syncDisconnectBtn').style.display = configured ? 'inline-block' : 'none';
  el('syncSignedIn').style.display = signedIn ? '' : 'none';
  el('syncSignedOut').style.display = signedIn ? 'none' : '';

  const user = sb.currentUser();
  el('syncEmailLabel').textContent = user ? (user.email || 'your account') : '';
}

// Applies whatever the engine last reported to the sidebar pill.
function paintStatus(status){
  const btn = el('syncStatusBtn');
  if (!btn) return;
  btn.dataset.state = status.state;
  el('syncLabel').textContent = status.message;
  btn.title = status.error ? `${status.message} — ${status.error}` : status.message;
  if (el('syncOverlay').classList.contains('open')){
    setError(status.error || '');
    if (status.state !== 'error'){
      setLog(status.note ? `${status.message} — ${status.note}` : status.message);
    }
  }
}

// Pulls the freshly synced rows back into the view.
async function reloadIfChanged(result){
  if (result && result.changed){
    await loadData();
    render();
  }
}

function openSyncModal(){
  refreshModal();
  setError('');
  setLog('');
  el('syncOverlay').classList.add('open');
}

export function initSyncUi(){
  sync.onStatus(paintStatus);
  sync.setAfterSync(reloadIfChanged);
  sync.refreshStatus();

  el('syncStatusBtn').onclick = openSyncModal;
  el('syncClose').onclick = () => el('syncOverlay').classList.remove('open');

  el('syncSaveBtn').onclick = () => {
    const url = el('syncUrl').value.trim();
    const key = el('syncKey').value.trim();
    if (url && !/^https?:\/\//i.test(url)){
      setError('The project URL should start with https://');
      return;
    }
    sb.setConfig(url, key);
    sync.refreshStatus();
    refreshModal();
    setError('');
    showToast(url && key ? 'Sync settings saved' : 'Sync settings cleared');
  };

  el('syncPasswordReveal').onclick = () => {
    const input = el('syncPassword');
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    el('syncPasswordReveal').textContent = shown ? 'show' : 'hide';
    el('syncPasswordReveal').setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
  };

  el('syncSignInBtn').onclick = async () => {
    const email = el('syncEmail').value.trim();
    const password = el('syncPassword').value;
    if (!email || !password){ setError('Enter an email and password.'); return; }
    setError(''); setLog('Signing in…');
    try{
      await sb.signIn(email, password);
      el('syncPassword').value = '';
      // The pull watermark belongs to whichever account was signed in before,
      // so a different one must start from the beginning or it would see
      // nothing that predates the switch.
      await sync.resetSyncWatermark();
      refreshModal();
      setLog('Signed in — syncing…');
      const result = await sync.sync();
      await reloadIfChanged(result);
    }catch(err){
      setLog('');
      setError(err.message === 'Invalid login credentials'
        ? 'Invalid login credentials — that is also what you get when no account exists for this email yet. Check Authentication → Users in Supabase, or use Create account.'
        : err.message);
    }
  };

  el('syncSignUpBtn').onclick = async () => {
    const email = el('syncEmail').value.trim();
    const password = el('syncPassword').value;
    if (!email || !password){ setError('Enter an email and password.'); return; }
    setError(''); setLog('Creating your account…');
    try{
      const { needsConfirmation } = await sb.signUp(email, password);
      el('syncPassword').value = '';
      await sync.resetSyncWatermark();
      refreshModal();
      if (needsConfirmation){
        setLog('Account created. Confirm the link in your email, then sign in.');
        return;
      }
      setLog('Account created — syncing…');
      const result = await sync.sync();
      await reloadIfChanged(result);
    }catch(err){
      setLog('');
      setError(err.message);
    }
  };

  el('syncSignOutBtn').onclick = () => {
    sb.signOut();
    refreshModal();
    sync.refreshStatus();
    setLog('Signed out. Your collection stays on this device.');
  };

  el('syncNowBtn').onclick = async () => {
    setError(''); setLog('Syncing…');
    const result = await sync.sync();
    await reloadIfChanged(result);
    if (result && result.error) setError(result.error.message || String(result.error));
  };

  el('syncReuploadBtn').onclick = () => {
    openConfirm(
      'Re-upload everything from this device?',
      'Every collection, series, card and photo on this device is marked as new and pushed to the server. Where the server has a different version of the same thing, this device wins. Anything the server has that this device has never seen is left alone.',
      async () => {
        setError(''); setLog('Marking everything for upload…');
        try{
          await local.markAllDirty();
          setLog('Uploading…');
          const result = await sync.sync();
          if (result && result.error) throw result.error;
          await reloadIfChanged(result);
          setLog(`Uploaded ${result.pushedRows || 0} record(s) and ${result.pushedBlobs || 0} photo(s).`);
          showToast('Re-upload complete');
        }catch(err){
          setLog('');
          setError(err.message || String(err));
        }
      },
      { okLabel: 'Re-upload', okColor: 'var(--accent)' }
    );
  };

  el('syncDisconnectBtn').onclick = () => {
    openConfirm(
      'Disconnect sync?',
      'This forgets the project details and signs you out on this device. Your collection stays here, and nothing is deleted from the server.',
      async () => {
        sb.clearConfig();
        await sync.resetSyncWatermark();
        refreshModal();
        sync.refreshStatus();
        el('syncOverlay').classList.remove('open');
        showToast('Sync disconnected');
      },
      { okLabel: 'Disconnect', okColor: 'var(--rose)' }
    );
  };

  el('syncOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'syncOverlay') el('syncOverlay').classList.remove('open');
  });
}
