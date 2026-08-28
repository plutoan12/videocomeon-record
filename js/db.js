/* IndexedDB storage for recordings (kept local to the browser). */
(function () {
  'use strict';

  const DB_NAME = 'videocomeon-recorder';
  const DB_VERSION = 1;
  const STORE = 'videos';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  window.VideoDB = {
    /* item: {name, blob, mimeType, duration, width, height, createdAt, thumb} */
    add(item) {
      return tx('readwrite', (store) => store.add(item));
    },
    put(item) {
      return tx('readwrite', (store) => store.put(item));
    },
    remove(id) {
      return tx('readwrite', (store) => store.delete(id));
    },
    get(id) {
      return open().then((db) => new Promise((resolve, reject) => {
        const req = db.transaction(STORE).objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      }));
    },
    all() {
      return open().then((db) => new Promise((resolve, reject) => {
        const req = db.transaction(STORE).objectStore(STORE).getAll();
        req.onsuccess = () => {
          const items = req.result || [];
          items.sort((a, b) => b.createdAt - a.createdAt);
          resolve(items);
        };
        req.onerror = () => reject(req.error);
      }));
    },
  };
})();
