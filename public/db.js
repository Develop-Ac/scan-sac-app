// IndexedDB do Escaner Fiscal:
//  - captures : scans capturados aguardando ANÁLISE (imagem crua + cantos detectados)
//  - pending  : documentos já analisados aguardando ENVIO (falha de sync)
//  - history  : cache local do que já foi enviado (exibição offline)
(function () {
  'use strict';

  const DB_NAME = 'escaner-fiscal';
  const DB_VERSION = 3;
  const STORES = { captures: 'captures', pending: 'pending', history: 'history' };

  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.captures))
          db.createObjectStore(STORES.captures, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORES.pending))
          db.createObjectStore(STORES.pending, { keyPath: 'clientId' });
        if (!db.objectStoreNames.contains(STORES.history))
          db.createObjectStore(STORES.history, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(store, mode);
          let result;
          Promise.resolve(fn(t.objectStore(store))).then((r) => (result = r));
          t.oncomplete = () => resolve(result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        }),
    );
  }
  const req2p = (r) =>
    new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });

  function makeStore(name, sortFn) {
    return {
      add: (item) => tx(name, 'readwrite', (s) => req2p(s.put(item))),
      get: (key) => tx(name, 'readonly', (s) => req2p(s.get(key))),
      all: () =>
        tx(name, 'readonly', (s) => req2p(s.getAll()).then((r) => r || [])).then((items) =>
          sortFn ? items.sort(sortFn) : items,
        ),
      remove: (key) => tx(name, 'readwrite', (s) => req2p(s.delete(key))),
      count: () => tx(name, 'readonly', (s) => req2p(s.count()).then((n) => n || 0)),
    };
  }

  // capturas: ordem de captura (createdAt asc) — analisa da primeira p/ a última
  window.CaptureQueue = makeStore(STORES.captures, (a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  // pendentes: mais recentes primeiro
  window.PendingQueue = makeStore(STORES.pending, (a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  // histórico: mais recentes primeiro
  window.SentDocs = makeStore(
    STORES.history,
    (a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''),
  );
})();
