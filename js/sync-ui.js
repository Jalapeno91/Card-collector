// The sync settings modal and the status pill in the sidebar.

import { el, showToast } from './ui.js';
import * as sb from './storage/supabase.js';
import * as sync from './storage/sync.js';
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
    if (status.state !== 'error') setLog(status.message);
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

  el('syncSignInBtn').onclick = async () => {
    const email = el('syncEmail').value.trim();
    const password = el('syncPassword').value;
    if (!email || !password){ setError('Enter an email and password.'); return; }
    setError(''); setLog('Signing in…');
    try{
      await sb.signIn(email, password);
      el('syncPassword').value = '';
      refreshModal();
      setLog('Signed in — syncing…');
      const result = await sync.sync();
      await reloadIfChanged(result);
    }catch(err){
      setLog('');
      setError(err.message);
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
