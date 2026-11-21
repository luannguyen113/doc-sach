// IndexedDB tối giản: kv (cài đặt, bộ nhớ đệm thư viện, token), progress, sessions, covers, files (dự phòng khi không có OPFS).
const DB_NAME = 'docsach';
const VERSION = 1;
const STORES = ['kv', 'progress', 'covers', 'files'];
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  set: (store, key, value) => run(store, 'readwrite', (s) => (store === 'sessions' ? s.put(value) : s.put(value, key))),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
  async entries(store) {
    const [keys, values] = await Promise.all([this.keys(store), this.all(store)]);
    return keys.map((k, i) => [k, values[i]]);
  },
};
