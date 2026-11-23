/**
 * core/storage.js — безопасная обёртка над localStorage.
 *
 * В file:// или приватном режиме localStorage может быть недоступен.
 * В этом случае данные живут в памяти: приложение продолжает работать,
 * просто не переживает перезагрузку.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const memory = new Map();
  let available = false;

  try {
    const probe = "__multiradio_probe__";
    global.localStorage.setItem(probe, "1");
    global.localStorage.removeItem(probe);
    available = true;
  } catch (error) {
    available = false;
  }

  function readRaw(key) {
    if (available) {
      try {
        return global.localStorage.getItem(key);
      } catch (error) {
        return null;
      }
    }
    return memory.has(key) ? memory.get(key) : null;
  }

  function writeRaw(key, raw) {
    if (available) {
      try {
        global.localStorage.setItem(key, raw);
        return true;
      } catch (error) {
        // Переполнение квоты или запрет записи — уходим в память.
        memory.set(key, raw);
        console.warn("[MultiRadio] localStorage недоступен для записи:", error);
        return false;
      }
    }
    memory.set(key, raw);
    return true;
  }

  function get(key, fallback) {
    const raw = readRaw(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.warn("[MultiRadio] Повреждённые данные в хранилище:", key);
      remove(key);
      return fallback;
    }
  }

  function set(key, value) {
    try {
      return writeRaw(key, JSON.stringify(value));
    } catch (error) {
      console.warn("[MultiRadio] Не удалось сохранить данные:", error);
      return false;
    }
  }

  function remove(key) {
    memory.delete(key);
    if (!available) return;
    try {
      global.localStorage.removeItem(key);
    } catch (error) {
      /* ничего не делаем */
    }
  }

  function size(key) {
    const raw = readRaw(key);
    if (!raw) return 0;
    if (typeof global.Blob === "function") {
      try {
        return new global.Blob([raw]).size;
      } catch (error) {
        /* fallback ниже */
      }
    }
    return raw.length * 2;
  }

  MR.storage = {
    get: get,
    set: set,
    remove: remove,
    size: size,
    isAvailable: function () { return available; },
  };
})(window);
