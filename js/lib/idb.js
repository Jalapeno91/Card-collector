// Minimal promise wrapper over IndexedDB — just the handful of operations the
// ledger needs, so we don't pull in a dependency for six lines of ceremony.

const DB_NAME = 'the-ledger';
const DB_VERSION = 1;

export const STORES = ['collections', 'subcollections', 'cards', 'blobs', 'meta'];

let dbPromise = null;

function openDb(){
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections', { keyPath:'id' });
      if (!db.objectStoreNames.contains('subcollections')){
        const s = db.createObjectStore('subcollections', { keyPath:'id' });
        s.createIndex('collectionId', 'collectionId', { unique:false });
      }
      if (!db.objectStoreNames.contains('cards')){
        const s = db.createObjectStore('cards', { keyPath:'id' });
        s.createIndex('subcollectionId', 'subcollectionId', { unique:false });
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath:'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath:'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The database is open in another tab and blocking an upgrade.'));
  });
  return dbPromise;
}

function run(storeNames, mode, fn){
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    result = fn(storeNames.map(n => tx.objectStore(n)), tx);
    // `fn` may return a promise-like of its own value; unwrap it before commit.
    if (result && typeof result.then === 'function'){
      result.then(v => { result = v; }, reject);
    }
  }));
}

function reqAsPromise(req){
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, key){
  const db = await openDb();
  return reqAsPromise(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function getAll(store){
  const db = await openDb();
  return reqAsPromise(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function put(store, value){
  return run([store], 'readwrite', ([s]) => { s.put(value); });
}

export async function putMany(store, values){
  if (!values.length) return;
  return run([store], 'readwrite', ([s]) => { values.forEach(v => s.put(v)); });
}

export async function del(store, key){
  return run([store], 'readwrite', ([s]) => { s.delete(key); });
}

export async function clearStores(names = STORES){
  return run(names, 'readwrite', stores => { stores.forEach(s => s.clear()); });
}

export async function getMeta(key, fallback = null){
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value){
  return put('meta', { key, value });
}
