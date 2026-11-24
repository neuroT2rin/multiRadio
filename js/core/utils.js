/**
 * core/utils.js — небольшие чистые функции без побочных эффектов.
 * Загружается первым и не зависит от других модулей.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});

  const TRANSLIT = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
    з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c",
    ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
    я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g",
  };

  const PLURALS = {
    station: ["станция", "станции", "станций"],
    group: ["группа", "группы", "групп"],
    source: ["источник", "источника", "источников"],
    check: ["проверка", "проверки", "проверок"],
    record: ["запись", "записи", "записей"],
  };

  /** Первый элемент по селектору. */
  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  /** Все элементы по селектору в виде массива. */
  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  /**
   * Создаёт DOM-элемент без innerHTML (защита от XSS).
   * el('button', { class: 'btn', text: 'Ок', onClick: fn }, 'доп. текст', childNode)
   */
  function el(tag, props) {
    const node = document.createElement(tag);
    const options = props || {};

    Object.keys(options).forEach(function (key) {
      const value = options[key];
      if (value === undefined || value === null || value === false) return;

      if (key === "class" || key === "className") {
        node.className = value;
      } else if (key === "text") {
        node.textContent = value;
      } else if (key === "dataset") {
        Object.assign(node.dataset, value);
      } else if (key === "style" && typeof value === "object") {
        Object.assign(node.style, value);
      } else if (key === "attrs") {
        Object.keys(value).forEach(function (attr) {
          node.setAttribute(attr, String(value[attr]));
        });
      } else if (key.slice(0, 2) === "on" && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node) {
        node[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    });

    append(node, Array.prototype.slice.call(arguments, 2));
    return node;
  }

  /** Добавляет детей в узел, разворачивая массивы и пропуская пустые значения. */
  function append(node, children) {
    const list = Array.isArray(children) ? children : [children];
    list.forEach(function (child) {
      if (child === undefined || child === null || child === false) return;
      if (Array.isArray(child)) {
        append(node, child);
      } else if (child instanceof global.Node) {
        node.appendChild(child);
      } else {
        node.appendChild(document.createTextNode(String(child)));
      }
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function uid(prefix) {
    const random =
      global.crypto && typeof global.crypto.randomUUID === "function"
        ? global.crypto.randomUUID().replace(/-/g, "").slice(0, 10)
        : Math.random().toString(36).slice(2, 12);
    return (prefix ? prefix + "-" : "") + random;
  }

  /** Транслитерирует название в безопасный id: «Наше Радио» → «nashe-radio». */
  function slugify(text) {
    const source = String(text || "").toLowerCase();
    let result = "";
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      result += Object.prototype.hasOwnProperty.call(TRANSLIT, char) ? TRANSLIT[char] : char;
    }
    result = result
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return result || "station";
  }

  /** Проверяет, что строка — абсолютный http(s)-URL. */
  function isHttpUrl(value) {
    if (typeof value !== "string" || !value.trim()) return false;
    try {
      const url = new URL(value.trim());
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  /** Разбирает список URL из строки: перевод строки, запятая, точка с запятой. */
  function parseUrlList(text) {
    const seen = Object.create(null);
    return String(text || "")
      .split(/[\s,;]+/)
      .map(function (item) { return item.trim(); })
      .filter(function (item) {
        if (!item || seen[item]) return false;
        seen[item] = true;
        return true;
      });
  }

  /** Приводит битрейт к целому кбит/с: «320 kbps» → 320, пусто/мусор → 0. */
  function normalizeBitrate(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    }
    const match = String(value === undefined || value === null ? "" : value).match(/\d+/);
    const parsed = match ? parseInt(match[0], 10) : 0;
    return parsed > 0 ? parsed : 0;
  }

  /** Битрейт для интерфейса: 320 → «320 kbps», 0 → «— kbps». */
  function formatBitrate(bitrate) {
    const value = normalizeBitrate(bitrate);
    return value ? value + " kbps" : "— kbps";
  }

  function pluralRu(count, kind) {
    const forms = PLURALS[kind] || PLURALS.station;
    const n = Math.abs(Number(count) || 0);
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
    return forms[2];
  }

  /** Миллисекунды → «01:23:45». */
  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map(function (part) {
      return String(part).padStart(2, "0");
    }).join(":");
  }

  /** Относительное время: «только что», «5 мин назад», «2 ч назад». */
  function formatRelative(timestamp, now) {
    if (!timestamp) return "—";
    const diff = Math.max(0, (now || Date.now()) - timestamp);
    if (diff < 45 * 1000) return "только что";
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "меньше минуты назад";
    if (minutes < 60) return minutes + " мин назад";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + " ч назад";
    return new Date(timestamp).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 Б";
    if (bytes < 1024) return bytes + " Б";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
    return (bytes / (1024 * 1024)).toFixed(2) + " МБ";
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      const context = this;
      clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(context, args);
      }, wait);
    };
  }

  function prefersReducedMotion() {
    return Boolean(
      global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  MR.utils = {
    qs: qs,
    qsa: qsa,
    el: el,
    append: append,
    clamp: clamp,
    uid: uid,
    slugify: slugify,
    isHttpUrl: isHttpUrl,
    parseUrlList: parseUrlList,
    pluralRu: pluralRu,
    formatDuration: formatDuration,
    formatRelative: formatRelative,
    formatBytes: formatBytes,
    normalizeBitrate: normalizeBitrate,
    formatBitrate: formatBitrate,
    debounce: debounce,
    prefersReducedMotion: prefersReducedMotion,
  };
})(window);
