// A small, hand-rolled Supabase client covering exactly what the ledger uses:
// email/password auth, PostgREST reads and upserts, and Storage object I/O.
//
// Written against the REST API rather than @supabase/supabase-js so the app
// stays buildless and dependency-free — there is nothing to npm install and
// nothing third-party to vendor into the repo.

const CFG_URL = 'ledger-sync-url';
const CFG_KEY = 'ledger-sync-key';
const CFG_SESSION = 'ledger-sync-session';

export const BUCKET = 'card-photos';

/* ── configuration ──────────────────────────────────────────────────────── */

export function getConfig(){
  return {
    url: (localStorage.getItem(CFG_URL) || '').replace(/\/+$/, ''),
    anonKey: localStorage.getItem(CFG_KEY) || '',
  };
}

export function setConfig(url, anonKey){
  localStorage.setItem(CFG_URL, (url || '').trim().replace(/\/+$/, ''));
  localStorage.setItem(CFG_KEY, (anonKey || '').trim());
}

export function isConfigured(){
  const { url, anonKey } = getConfig();
  return !!(url && anonKey);
}

export function clearConfig(){
  [CFG_URL, CFG_KEY, CFG_SESSION].forEach(k => localStorage.removeItem(k));
}

/* ── session ────────────────────────────────────────────────────────────── */

export function getSession(){
  try{ return JSON.parse(localStorage.getItem(CFG_SESSION) || 'null'); }
  catch(e){ return null; }
}

function setSession(s){
  if (s) localStorage.setItem(CFG_SESSION, JSON.stringify(s));
  else localStorage.removeItem(CFG_SESSION);
}

export function isSignedIn(){
  const s = getSession();
  return !!(s && s.access_token);
}

export function currentUser(){
  const s = getSession();
  return s ? s.user : null;
}

function storeSession(payload){
  if (!payload || !payload.access_token) throw new Error('The server did not return a session.');
  setSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    // expires_in is seconds from now; keep an absolute stamp so a sleeping
    // device wakes up knowing whether its token is stale.
    expires_at: Date.now() + (Number(payload.expires_in || 3600) * 1000),
    user: payload.user ? { id: payload.user.id, email: payload.user.email } : null,
  });
  return getSession();
}

async function readError(res, fallback){
  let detail = '';
  try{
    const body = await res.json();
    detail = body.error_description || body.msg || body.message || body.error || body.hint || '';
  }catch(e){ /* non-JSON error body — the status alone will have to do */ }
  return new Error(detail || `${fallback} (HTTP ${res.status})`);
}

/* ── auth ───────────────────────────────────────────────────────────────── */

export async function signIn(email, password){
  const { url, anonKey } = getConfig();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await readError(res, 'Sign in failed');
  return storeSession(await res.json());
}

export async function signUp(email, password){
  const { url, anonKey } = getConfig();
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await readError(res, 'Could not create the account');
  const body = await res.json();
  // With "confirm email" enabled the project returns a user but no session.
  if (!body.access_token) return { needsConfirmation: true, session: null };
  return { needsConfirmation: false, session: storeSession(body) };
}

export function signOut(){
  setSession(null);
}

async function refreshSession(){
  const s = getSession();
  if (!s || !s.refresh_token) throw new Error('Signed out — sign in again to resume syncing.');
  const { url, anonKey } = getConfig();
  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  if (!res.ok){
    setSession(null);
    throw new Error('Your session expired — sign in again to resume syncing.');
  }
  return storeSession(await res.json());
}

async function accessToken(){
  let s = getSession();
  if (!s) throw new Error('Not signed in.');
  // Refresh a minute early so a request never races the expiry.
  if (!s.expires_at || Date.now() > s.expires_at - 60_000) s = await refreshSession();
  return s.access_token;
}

// Performs a request, refreshing the token once if the server rejects it.
async function authed(path, init = {}, retry = true){
  const { url, anonKey } = getConfig();
  const token = await accessToken();
  const res = await fetch(url + path, {
    ...init,
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if ((res.status === 401 || res.status === 403) && retry){
    await refreshSession();
    return authed(path, init, false);
  }
  return res;
}

/* ── PostgREST ──────────────────────────────────────────────────────────── */

export async function selectSince(table, since){
  const params = new URLSearchParams({ select: '*' });
  if (since) params.set('updated_at', `gt.${since}`);
  const res = await authed(`/rest/v1/${table}?${params}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw await readError(res, `Could not read ${table}`);
  return res.json();
}

// Returns the rows as the server stored them. Worth the larger reply: the
// server decides updated_at, and the device needs to record what it chose.
export async function upsert(table, rows){
  if (!rows.length) return [];
  const res = await authed(`/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw await readError(res, `Could not save ${table}`);
  try{ return await res.json(); }
  catch(e){ return []; }
}

/* ── Storage ────────────────────────────────────────────────────────────── */

// Object keys carry a colon ("card-photo:x1a2b"), which is awkward in a URL
// path, so it becomes a double underscore on the way to the bucket.
export function objectPath(userId, key){
  return `${userId}/${key.replace(/:/g, '__')}`;
}

export async function uploadObject(path, blob){
  const res = await authed(`/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'true' },
    body: blob,
  });
  if (!res.ok) throw await readError(res, 'Could not upload a photo');
}

// Storage reports a missing object as 400 with a not_found body about as often
// as it reports a plain 404, so both have to count as "simply isn't there".
async function isMissing(res){
  if (res.status === 404) return true;
  if (res.status !== 400) return false;
  const text = await res.clone().text().catch(() => '');
  return /not[_\s-]?found/i.test(text);
}

// Returns null when the object does not exist. A photo can legitimately be
// missing — a row may reference one whose upload has not landed yet — and that
// must never be treated as a failure, or one absent photo would block all
// syncing indefinitely.
export async function downloadObject(path){
  const res = await authed(`/storage/v1/object/${BUCKET}/${path}`);
  if (await isMissing(res)) return null;
  if (!res.ok) throw await readError(res, 'Could not download a photo');
  return res.blob();
}

export async function removeObject(path){
  const res = await authed(`/storage/v1/object/${BUCKET}/${path}`, { method: 'DELETE' });
  // A photo that is already gone is a success as far as the caller cares.
  if (!res.ok && !(await isMissing(res))) throw await readError(res, 'Could not remove a photo');
}
