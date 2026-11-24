/**
 * services/recordings.js — архив записей эфира в IndexedDB.
 *
 * Записи хранятся только в браузере пользователя: никуда не загружаются.
 * На `file://` IndexedDB может быть недоступен (SecurityError,
 * InvalidStateError, запрет на opaque origin). В этом случае модуль молча
 * переключается на массив в памяти: записи живут до перезагрузки страницы,
 * а `isPersistent()` возвращает `false`, чтобы UI показал подсказку.
 *
 * Все операции возвращают Promise и не выбрасывают исключений наружу:
 * ошибки quota/abort/недоступного хранилища превращаются в результат.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;

  const DB_NAME = "multiradio:recordings";
  const DB_VERSION = 1;
  const STORE = "recordings";
  const INDEX = "createdAt";
  /** Если open() молчит дольше — считаем IndexedDB недоступным. */
  const OPEN_TIMEOUT_MS = 2000;

  let dbPromise = null;
  let database = null;
  let persistent = false;
  let fallback = false;
  let memory = [];

  function markFallback() {
    fallback = true;
    persistent = false;
  }

  function byNewest(a, b) {
    return (Number(b && b.createdAt) || 0) - (Number(a && a.createdAt) || 0);
  }

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve) {
      let settled = false;
      let timer = null;
      let request = null;

      function settle(value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        resolve(value);
      }

      function fail() {
        markFallback();
        settle(null);
      }

      if (!global.indexedDB) {
        fail();
        return;
      }

      try {
        request = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        fail();
        return;
      }

      // На файловом протоколе некоторые браузеры вообще не отвечают на open().
      timer = setTimeout(fail, OPEN_TIMEOUT_MS);

      request.onupgradeneeded = function () {
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: "id" });
            store.createIndex(INDEX, INDEX, { unique: false });
          }
        } catch (error) {
          // Без индекса тоже можно жить: сортируем список после getAll().
        }
      };

      request.onsuccess = function () {
        const db = request.result;

        if (settled) {
          // Уже ушли в fallback по таймауту — лишнее соединение закрываем.
          try { db.close(); } catch (error) { /* соединение уже закрыто */ }
          return;
        }

        try {
          db.onversionchange = function () {
            try { db.close(); } catch (error) { /* noop */ }
            database = null;
            dbPromise = null;
          };
        } catch (error) {
          // Старые реализации не дают повесить onversionchange — не критично.
        }

        database = db;
        persistent = true;
        settle(db);
      };

      request.onerror = fail;
      request.onblocked = fail;
    });

    return dbPromise;
  }

  /**
   * Выполняет работу с objectStore. Если хранилища нет — work(null)
   * работает с массивом в памяти.
   */
  function withStore(mode, work) {
    return openDb().then(function (db) {
      if (!db) return work(null);

      let transaction;
      try {
        transaction = db.transaction(STORE, mode);
      } catch (error) {
        markFallback();
        return work(null);
      }

      return work(transaction.objectStore(STORE), transaction);
    });
  }

  /** Приводит запись к единой схеме; id создаётся, если его не передали. */
  function normalize(entry) {
    const source = entry || {};
    const createdAt = Number(source.createdAt) || Date.now();
    const blob = source.blob || null;

    return {
      id: String(source.id || utils.uid("rec")),
      stationId: String(source.stationId || ""),
      stationName: String(source.stationName || "Радио").slice(0, 80),
      createdAt: createdAt,
      durationMs: Math.max(0, Math.round(Number(source.durationMs) || 0)),
      mimeType: String(source.mimeType || "audio/webm"),
      size: Math.max(0, Math.round(Number(source.size) || (blob && blob.size) || 0)),
      blob: blob,
    };
  }

  /** Сохранение фрагмента. Результат: { ok, entry?, error?, quota? }. */
  function save(entry) {
    const record = normalize(entry);

    if (!record.blob || !record.blob.size) {
      return Promise.resolve({ ok: false, error: "empty" });
    }

    return withStore("readwrite", function (store, transaction) {
      if (!store) {
        memory.push(record);
        return { ok: true, entry: record, persistent: false };
      }

      return new Promise(function (resolve) {
        let settled = false;

        function settle(result) {
          if (settled) return;
          settled = true;
          resolve(result);
        }

        transaction.oncomplete = function () {
          settle({ ok: true, entry: record, persistent: true });
        };

        transaction.onabort = function () {
          const error = transaction.error;
          const name = (error && error.name) || "abort";
          settle({
            ok: false,
            error: name,
            quota: name === "QuotaExceededError",
            entry: record,
          });
        };

        try {
          store.put(record);
        } catch (error) {
          settle({
            ok: false,
            error: error.name || "error",
            quota: error.name === "QuotaExceededError",
          });
        }
      });
    }).catch(function (error) {
      return { ok: false, error: (error && error.name) || "error" };
    });
  }

  /** Список записей, свежие первыми. */
  function list() {
    return withStore("readonly", function (store) {
      if (!store) return memory.slice().sort(byNewest);

      return new Promise(function (resolve) {
        let request;
        try {
          request = store.getAll();
        } catch (error) {
          resolve(memory.slice().sort(byNewest));
          return;
        }

        request.onsuccess = function () {
          const items = Array.isArray(request.result) ? request.result : [];
          resolve(items.sort(byNewest));
        };

        request.onerror = function () {
          markFallback();
          resolve(memory.slice().sort(byNewest));
        };
      });
    }).catch(function () {
      return memory.slice().sort(byNewest);
    });
  }

  /** Одна запись по id или null. */
  function get(id) {
    const key = String(id);

    return withStore("readonly", function (store) {
      if (!store) {
        const found = memory.find(function (item) { return item.id === key; });
        return found || null;
      }

      return new Promise(function (resolve) {
        let request;
        try {
          request = store.get(key);
        } catch (error) {
          resolve(null);
          return;
        }

        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  /** Удаление записи. Результат: { ok, error? }. */
  function remove(id) {
    const key = String(id);
    memory = memory.filter(function (item) { return item.id !== key; });

    return withStore("readwrite", function (store, transaction) {
      if (!store) return { ok: true };

      return new Promise(function (resolve) {
        let settled = false;

        function settle(result) {
          if (settled) return;
          settled = true;
          resolve(result);
        }

        transaction.oncomplete = function () { settle({ ok: true }); };
        transaction.onabort = function () {
          settle({
            ok: false,
            error: (transaction.error && transaction.error.name) || "abort",
          });
        };

        try {
          store.delete(key);
        } catch (error) {
          settle({ ok: false, error: error.name || "error" });
        }
      });
    }).catch(function (error) {
      return { ok: false, error: (error && error.name) || "error" };
    });
  }

  /** Полная очистка архива. Результат: { ok, error? }. */
  function clear() {
    memory = [];

    return withStore("readwrite", function (store, transaction) {
      if (!store) return { ok: true };

      return new Promise(function (resolve) {
        let settled = false;

        function settle(result) {
          if (settled) return;
          settled = true;
          resolve(result);
        }

        transaction.oncomplete = function () { settle({ ok: true }); };
        transaction.onabort = function () {
          settle({
            ok: false,
            error: (transaction.error && transaction.error.name) || "abort",
          });
        };

        try {
          store.clear();
        } catch (error) {
          settle({ ok: false, error: error.name || "error" });
        }
      });
    }).catch(function (error) {
      return { ok: false, error: (error && error.name) || "error" };
    });
  }

  /** true — записи переживут перезагрузку страницы. */
  function isPersistent() {
    return openDb().then(function () { return persistent && !fallback; });
  }

  /** Есть ли в браузере IndexedDB (без открытия базы). */
  function supported() {
    return Promise.resolve(Boolean(global.indexedDB) && !fallback);
  }

  /** Расширение файла по MIME-типу записи. */
  function extensionFor(mimeType) {
    const type = String(mimeType || "");
    if (type.indexOf("ogg") !== -1) return "ogg";
    if (type.indexOf("mp4") !== -1 || type.indexOf("m4a") !== -1) return "m4a";
    if (type.indexOf("mpeg") !== -1) return "mp3";
    if (type.indexOf("wav") !== -1) return "wav";
    return "webm";
  }

  function stamp(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const pad = function (value) { return value < 10 ? "0" + value : String(value); };
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
      "-" + pad(date.getHours()) + pad(date.getMinutes());
  }

  /**
   * Имя файла для скачивания: multiradio-<станция>-<дата>.<ext>.
   * Чистая функция — используется UI и тестами.
   */
  function fileName(entry) {
    const source = entry || {};
    const station = source.stationName || source.stationId || "radio";
    return "multiradio-" + utils.slugify(station) + "-" +
      stamp(source.createdAt) + "." + extensionFor(source.mimeType);
  }

  MR.recordings = {
    supported: supported,
    save: save,
    list: list,
    get: get,
    remove: remove,
    clear: clear,
    isPersistent: isPersistent,
    fileName: fileName,
  };
})(window);
