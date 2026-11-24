/**
 * services/share.js — ссылки для передачи станции или группы.
 *
 * Ссылка выглядит как `index.html#share=<base64url>` и не требует сервера:
 * payload — это UTF-8 JSON, закодированный в base64url без внешних библиотек.
 * Получатель открывает ссылку, видит предпросмотр и решает, добавлять ли данные.
 *
 * Безопасность: версия payload проверяется, источники допускаются только
 * http(s), число источников и длина ссылки ограничены, никакой код из ссылки
 * не выполняется.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;
  const config = MR.config;

  /** Версия формата. Ссылки другой версии игнорируются. */
  const VERSION = 1;
  /** Больше этого payload не принимаем и предупреждаем при генерации. */
  const MAX_PAYLOAD_LENGTH = 12000;
  /** Сколько станций максимум может быть в ссылке на группу. */
  const MAX_GROUP_STATIONS = 100;

  /* ------------------------------------------------------------------------
     base64url ↔ UTF-8 JSON

     encodeURIComponent превращает строку в ASCII-последовательность %XX,
     которую можно скормить btoa. Обратное преобразование делает atob.
     ------------------------------------------------------------------------ */

  function toBase64(binary) {
    if (typeof global.btoa === "function") return global.btoa(binary);
    if (typeof Buffer !== "undefined") return Buffer.from(binary, "binary").toString("base64");
    throw new Error("Кодирование base64 недоступно");
  }

  function fromBase64(base64) {
    if (typeof global.atob === "function") return global.atob(base64);
    if (typeof Buffer !== "undefined") return Buffer.from(base64, "base64").toString("binary");
    throw new Error("Декодирование base64 недоступно");
  }

  /** Объект → компактная base64url-строка. */
  function encode(payload) {
    const json = JSON.stringify(payload);
    if (typeof json !== "string") throw new Error("Не удалось закодировать данные");

    const binary = encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });

    return toBase64(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  /** base64url-строка → объект. Бросает понятную ошибку при повреждении. */
  function decode(text) {
    if (typeof text !== "string" || !text) throw new Error("Пустая ссылка");

    let base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) base64 += "=";

    let binary;
    try {
      binary = fromBase64(base64);
    } catch (error) {
      throw new Error("Ссылка повреждена");
    }

    let json = "";
    try {
      json = decodeURIComponent(Array.prototype.map.call(binary, function (char) {
        return "%" + ("00" + char.charCodeAt(0).toString(16)).slice(-2);
      }).join(""));
    } catch (error) {
      throw new Error("Ссылка повреждена");
    }

    try {
      return JSON.parse(json);
    } catch (error) {
      throw new Error("Ссылка повреждена");
    }
  }

  /* ------------------------------------------------------------------------
     Валидация payload
     ------------------------------------------------------------------------ */

  function cleanText(value, maxLength) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, maxLength);
  }

  function fail(error) {
    return { ok: false, error: error };
  }

  function validateStationNode(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fail("Станция в ссылке повреждена");
    }

    const name = cleanText(raw.name, config.limits.stationNameLength);
    if (!name) return fail("В ссылке нет названия станции");

    const list = Array.isArray(raw.sources) ? raw.sources : [];
    if (!list.length) return fail("В ссылке нет источников у станции «" + name + "»");
    if (list.length > config.audio.maxSources) {
      return fail("У станции «" + name + "» слишком много источников");
    }

    const seen = Object.create(null);
    const sources = [];

    list.forEach(function (item) {
      const url = typeof item === "string"
        ? item.trim()
        : (item && typeof item === "object" && typeof item.url === "string" ? item.url.trim() : "");

      if (!utils.isHttpUrl(url)) {
        throw new ShareError("Недопустимый адрес источника у станции «" + name + "»");
      }
      if (seen[url]) return;
      seen[url] = true;

      const rawBitrate = item && typeof item === "object" ? utils.normalizeBitrate(item.bitrate) : 0;
      const bitrate = rawBitrate
        ? utils.clamp(rawBitrate, config.audio.minBitrate, config.audio.maxBitrate)
        : 0;

      sources.push({ url: url, bitrate: bitrate });
    });

    if (!sources.length) return fail("В ссылке нет источников у станции «" + name + "»");

    return {
      ok: true,
      value: {
        name: name,
        genre: cleanText(raw.genre, config.limits.genreLength) || "Без жанра",
        emoji: cleanText(raw.emoji, config.limits.emojiLength) || "📻",
        sources: sources,
      },
    };
  }

  /** Служебная ошибка внутри валидации одного источника. */
  function ShareError(message) {
    this.name = "ShareError";
    this.message = message;
  }
  ShareError.prototype = Object.create(Error.prototype);
  ShareError.prototype.constructor = ShareError;

  /**
   * Проверяет и нормализует payload.
   * @returns {{ok: boolean, payload?: object, error?: string}}
   */
  function validate(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return fail("Ссылка не содержит данных");
    }
    if (Number(payload.v) !== VERSION) {
      return fail("Неподдерживаемая версия ссылки");
    }

    try {
      if (payload.type === "station") {
        const station = validateStationNode(payload.station);
        if (!station.ok) return station;
        return { ok: true, payload: { v: VERSION, type: "station", station: station.value } };
      }

      if (payload.type === "group") {
        const name = cleanText(payload.group && payload.group.name, config.limits.groupNameLength);
        if (!name) return fail("В ссылке нет названия группы");

        const list = Array.isArray(payload.stations) ? payload.stations : [];
        if (!list.length) return fail("В группе «" + name + "» нет станций");
        if (list.length > MAX_GROUP_STATIONS) {
          return fail("В группе «" + name + "» слишком много станций");
        }

        const seenNames = Object.create(null);
        const stations = [];
        for (let i = 0; i < list.length; i += 1) {
          const station = validateStationNode(list[i]);
          if (!station.ok) return station;
          const key = station.value.name.toLowerCase();
          if (seenNames[key]) continue;
          seenNames[key] = true;
          stations.push(station.value);
        }

        if (!stations.length) return fail("В группе «" + name + "» нет станций");
        return { ok: true, payload: { v: VERSION, type: "group", group: { name: name }, stations: stations } };
      }
    } catch (error) {
      if (error instanceof ShareError) return fail(error.message);
      throw error;
    }

    return fail("Неизвестный тип ссылки");
  }

  /** base64url payload → проверенный объект. */
  function parsePayload(text) {
    if (typeof text !== "string" || !text) return fail("Пустая ссылка");
    if (text.length > MAX_PAYLOAD_LENGTH) return fail("Ссылка слишком длинная");

    let data;
    try {
      data = decode(text);
    } catch (error) {
      return fail(error.message || "Ссылка повреждена");
    }
    return validate(data);
  }

  /* ------------------------------------------------------------------------
     Сборка ссылок
     ------------------------------------------------------------------------ */

  /** Адрес текущей страницы без hash и без query (работает и для file://). */
  function baseUrl() {
    const location = global.location;
    if (!location || !location.href) return "";
    return String(location.href).split("#")[0].split("?")[0];
  }

  function stationNode(station) {
    return {
      name: station.name,
      genre: station.genre,
      emoji: station.emoji,
      sources: (Array.isArray(station.sources) ? station.sources : []).map(function (source) {
        return { url: source.url, bitrate: source.bitrate };
      }),
    };
  }

  /** payload для станции из state. */
  function payloadFromStation(station) {
    return {
      v: VERSION,
      type: "station",
      station: stationNode(station),
    };
  }

  /** payload для группы из state: состав берётся из stationIds. */
  function payloadFromGroup(group) {
    const store = MR.store;
    const stations = (Array.isArray(group.stationIds) ? group.stationIds : [])
      .map(function (stationId) { return store ? store.findStation(stationId) : null; })
      .filter(Boolean)
      .map(stationNode);

    return {
      v: VERSION,
      type: "group",
      group: { name: group.name },
      stations: stations,
    };
  }

  /** payload → абсолютная ссылка на текущую страницу. */
  function buildLink(payload) {
    const check = validate(payload);
    if (!check.ok) throw new Error(check.error);
    return baseUrl() + "#share=" + encode(check.payload);
  }

  function buildStationLink(station) {
    if (!station) throw new Error("Станция не найдена");
    return buildLink(payloadFromStation(station));
  }

  function buildGroupLink(group) {
    if (!group) throw new Error("Группа не найдена");
    const payload = payloadFromGroup(group);
    if (!payload.stations.length) throw new Error("В группе нет станций");
    return buildLink(payload);
  }

  /* ------------------------------------------------------------------------
     Чтение location
     ------------------------------------------------------------------------ */

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }

  /** Достаёт сырой payload из #share= (или ?share=). */
  function readShareParam() {
    const location = global.location;
    if (!location) return "";

    const hash = typeof location.hash === "string" ? location.hash : "";
    const hashMatch = /(?:^#|&)share=([^&]*)/.exec(hash);
    if (hashMatch) return safeDecode(hashMatch[1]);

    const search = typeof location.search === "string" ? location.search : "";
    const searchMatch = /(?:^\?|&)share=([^&]*)/.exec(search);
    if (searchMatch) return safeDecode(searchMatch[1]);

    return "";
  }

  /**
   * Разбирает ссылку из адресной строки.
   * @returns {{ok: boolean, payload?: object, error?: string}}
   */
  function parseLocation() {
    const raw = readShareParam();
    if (!raw) return fail("В ссылке нет данных для импорта");
    return parsePayload(raw);
  }

  /** Убирает #share из адресной строки, чтобы перезагрузка не импортировала снова. */
  function clearLocation() {
    const location = global.location;
    if (!location) return;

    const href = String(location.href || "");
    const base = href.split("#")[0].split("?")[0];
    const history = global.history;

    if (history && typeof history.replaceState === "function") {
      // Абсолютный URL работает на http(s); file:// в Chrome его запрещает.
      try {
        history.replaceState(null, "", base);
        return;
      } catch (error) {
        // переходим к относительным вариантам
      }
      try {
        history.replaceState(null, "", location.pathname || "./");
        return;
      } catch (error) {
        // ниже — только hash
      }
      try {
        history.replaceState(null, "", "#");
        return;
      } catch (error) {
        // остаётся мягкий откат
      }
    }

    try {
      if (location.hash) location.hash = "";
    } catch (error) {
      // адресную строку изменить нельзя — импорт просто повторится
    }
  }

  /* ------------------------------------------------------------------------
     Применение payload
     ------------------------------------------------------------------------ */

  function firstError(errors) {
    const keys = Object.keys(errors || {});
    if (!keys.length) return "";
    return errors[keys[0]] || "";
  }

  function findExistingStation(station) {
    const store = MR.store;
    if (!store) return null;

    const name = station.name.toLowerCase();
    const urls = station.sources.map(function (source) { return source.url; });

    return store.state.stations.find(function (item) {
      if (item.name.toLowerCase() === name) return true;
      return (item.sources || []).some(function (source) {
        return urls.indexOf(source.url) !== -1;
      });
    }) || null;
  }

  function applyStation(station) {
    const existing = findExistingStation(station);
    if (existing) {
      return {
        ok: false,
        duplicate: true,
        type: "station",
        name: existing.name,
        error: "Станция «" + existing.name + "» уже есть в списке.",
      };
    }

    const result = MR.store.addStation({
      name: station.name,
      genre: station.genre,
      emoji: station.emoji,
      sources: station.sources,
      groupId: "",
    });

    if (!result.ok) {
      return {
        ok: false,
        type: "station",
        name: station.name,
        error: firstError(result.errors) || "Не удалось добавить станцию.",
      };
    }

    return {
      ok: true,
      type: "station",
      name: result.station.name,
      stationId: result.station.id,
      message: "Станция «" + result.station.name + "» добавлена.",
    };
  }

  function applyGroup(data) {
    const store = MR.store;
    const stationIds = [];
    let reused = 0;
    let added = 0;
    let lastError = "";

    data.stations.forEach(function (station) {
      const existing = findExistingStation(station);
      if (existing) {
        reused += 1;
        if (stationIds.indexOf(existing.id) === -1) stationIds.push(existing.id);
        return;
      }

      const created = store.addStation({
        name: station.name,
        genre: station.genre,
        emoji: station.emoji,
        sources: station.sources,
        groupId: "",
      });

      if (created.ok) {
        added += 1;
        stationIds.push(created.station.id);
      } else {
        lastError = firstError(created.errors) || lastError;
      }
    });

    if (!stationIds.length) {
      return {
        ok: false,
        type: "group",
        name: data.group.name,
        error: lastError || "Не удалось добавить станции из ссылки.",
      };
    }

    const groupName = data.group.name;
    const existingGroup = store.state.groups.find(function (group) {
      return group.name.toLowerCase() === groupName.toLowerCase();
    });

    if (existingGroup) {
      const union = existingGroup.stationIds.slice();
      stationIds.forEach(function (stationId) {
        if (union.indexOf(stationId) === -1) union.push(stationId);
      });

      const updated = store.updateGroup(existingGroup.id, {
        name: existingGroup.name,
        stationIds: union,
      });

      if (!updated.ok) {
        return {
          ok: false,
          type: "group",
          name: existingGroup.name,
          error: firstError(updated.errors) || "Не удалось обновить группу.",
        };
      }

      return {
        ok: true,
        type: "group",
        name: existingGroup.name,
        groupId: existingGroup.id,
        stationsAdded: added,
        stationsReused: reused,
        merged: true,
        message: "Станции добавлены в группу «" + existingGroup.name + "».",
      };
    }

    const createdGroup = store.addGroup({ name: groupName, stationIds: stationIds });
    if (!createdGroup.ok) {
      return {
        ok: false,
        type: "group",
        name: groupName,
        error: firstError(createdGroup.errors) || "Не удалось добавить группу.",
      };
    }

    return {
      ok: true,
      type: "group",
      name: createdGroup.group.name,
      groupId: createdGroup.group.id,
      stationsAdded: added,
      stationsReused: reused,
      merged: false,
      message: "Группа «" + createdGroup.group.name + "» добавлена · станций: " +
        createdGroup.group.stationIds.length + ".",
    };
  }

  /**
   * Добавляет данные из payload через действия стора.
   * Дубликаты по имени или URL не создаются.
   * @returns {{ok: boolean, type: string, message?: string, error?: string, duplicate?: boolean}}
   */
  function apply(payload) {
    const check = validate(payload);
    if (!check.ok) return { ok: false, type: "", error: check.error };
    if (!MR.store) return { ok: false, type: "", error: "Хранилище недоступно" };

    return check.payload.type === "station"
      ? applyStation(check.payload.station)
      : applyGroup(check.payload);
  }

  /* ------------------------------------------------------------------------
     Копирование в буфер
     ------------------------------------------------------------------------ */

  function fallbackCopy(text) {
    if (!global.document || !global.document.body) return false;
    let area = null;
    try {
      area = global.document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      global.document.body.appendChild(area);
      area.select();
      const ok = typeof global.document.execCommand === "function"
        ? global.document.execCommand("copy")
        : false;
      return Boolean(ok);
    } catch (error) {
      return false;
    } finally {
      if (area && area.parentNode) area.parentNode.removeChild(area);
    }
  }

  /** Копирует текст. @returns {Promise<boolean>} */
  function copy(text) {
    const value = String(text === null || text === undefined ? "" : text);
    const navigator = global.navigator;

    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(value).then(
        function () { return true; },
        function () { return fallbackCopy(value); }
      );
    }

    return Promise.resolve(fallbackCopy(value));
  }

  /* ------------------------------------------------------------------------
     Модальное окно #modal-share
     ------------------------------------------------------------------------ */

  let modal = null;
  let title = null;
  let subtitle = null;
  let preview = null;
  let warning = null;
  let linkRow = null;
  let linkInput = null;
  let hint = null;
  let copyButton = null;
  let addButton = null;
  let cancelButton = null;

  /** "link" — показываем готовую ссылку, "import" — предпросмотр входящей. */
  let mode = "link";
  let currentPayload = null;

  function el(tag, props) {
    const dom = MR.dom;
    if (!dom || typeof dom.el !== "function") return null;
    return dom.el.apply(null, arguments);
  }

  function sourceListNode(sources) {
    const max = sources.reduce(function (value, source) {
      return Math.max(value, Number(source.bitrate) || 0);
    }, 0);

    const items = sources.map(function (source) {
      const bitrate = Number(source.bitrate) || 0;
      return el("li", { class: "share-source" },
        el("span", { class: "share-source__url", text: source.url }),
        el("span", {
          class: "share-source__bitrate" + (bitrate && bitrate === max ? " is-best" : ""),
          text: utils.formatBitrate(bitrate),
        })
      );
    });

    return el("ul", { class: "share-preview__list" }, items);
  }

  function renderStationPreview(station) {
    return [
      el("p", { class: "share-preview__name", text: station.emoji + " " + station.name }),
      el("p", { class: "share-preview__meta", text: station.genre }),
      sourceListNode(station.sources),
    ];
  }

  function renderGroupPreview(payload) {
    const stations = payload.stations;
    const count = stations.length;

    const items = stations.map(function (station) {
      const max = station.sources.reduce(function (value, source) {
        return Math.max(value, Number(source.bitrate) || 0);
      }, 0);
      return el("li", { class: "share-station" },
        el("span", { class: "share-station__name", text: station.emoji + " " + station.name }),
        el("span", { class: "share-station__bitrate", text: utils.formatBitrate(max) })
      );
    });

    return [
      el("p", { class: "share-preview__name", text: "Группа «" + payload.group.name + "»" }),
      el("p", {
        class: "share-preview__meta",
        text: count + " " + utils.pluralRu(count, "station"),
      }),
      el("ul", { class: "share-preview__list" }, items),
    ];
  }

  function renderPreview(payload) {
    if (!preview) return;
    preview.innerHTML = "";

    const nodes = payload.type === "group"
      ? renderGroupPreview(payload)
      : renderStationPreview(payload.station);

    nodes.forEach(function (node) {
      if (node) preview.appendChild(node);
    });
  }

  function openModal(options) {
    if (!modal) return;
    const opts = options || {};
    MR.modal.open(modal, {
      initialFocus: opts.initialFocus,
      onClose: function () {
        // Входящая ссылка не должна импортироваться повторно при перезагрузке.
        if (mode === "import") clearLocation();
        currentPayload = null;
      },
    });
  }

  function openLinkModal(payload) {
    if (!modal) return;

    const check = validate(payload);
    if (!check.ok) {
      MR.toast.error(check.error || "Не удалось создать ссылку.");
      return;
    }

    let link;
    try {
      link = buildLink(check.payload);
    } catch (error) {
      MR.toast.error("Не удалось создать ссылку.");
      return;
    }

    const data = check.payload;
    const isGroup = data.type === "group";
    const name = isGroup ? data.group.name : data.station.name;
    const tooLong = link.length > MAX_PAYLOAD_LENGTH;

    mode = "link";
    currentPayload = null;

    title.textContent = isGroup ? "Ссылка на группу" : "Ссылка на станцию";
    subtitle.textContent = isGroup ? "Группа «" + name + "»" : "Станция «" + name + "»";
    renderPreview(data);

    if (linkInput) linkInput.value = link;
    if (linkRow) linkRow.hidden = false;
    if (copyButton) copyButton.hidden = false;
    if (addButton) addButton.hidden = true;
    if (cancelButton) cancelButton.textContent = "Закрыть";

    if (warning) {
      warning.hidden = !tooLong;
      warning.textContent = tooLong
        ? "Ссылка получилась очень длинной — некоторые мессенджеры могут её обрезать. " +
          "Попробуйте передать станции по одной."
        : "";
    }

    if (hint) {
      hint.textContent = isGroup
        ? "Отправьте ссылку — получатель сможет добавить группу."
        : "Отправьте ссылку — получатель сможет добавить станцию.";
    }

    openModal({ initialFocus: linkInput });
  }

  function openImportModal(payload) {
    if (!modal) return;

    const isGroup = payload.type === "group";
    const name = isGroup ? payload.group.name : payload.station.name;

    mode = "import";
    currentPayload = payload;

    title.textContent = isGroup ? "Вам передали группу" : "Вам передали станцию";
    subtitle.textContent = isGroup ? "Группа «" + name + "»" : "Станция «" + name + "»";
    renderPreview(payload);

    if (linkRow) linkRow.hidden = true;
    if (linkInput) linkInput.value = "";
    if (copyButton) copyButton.hidden = true;
    if (addButton) addButton.hidden = false;
    if (cancelButton) cancelButton.textContent = "Отмена";
    if (warning) {
      warning.hidden = true;
      warning.textContent = "";
    }
    if (hint) {
      hint.textContent = "Данные добавляются только после нажатия «Добавить». " +
        "Существующие станции не дублируются.";
    }

    openModal({ initialFocus: addButton });
  }

  function handleAdd() {
    if (!currentPayload) return;

    const result = apply(currentPayload);

    if (!result.ok) {
      if (result.duplicate) {
        MR.toast.info(result.error || "Это уже есть в списке.", { timeout: 3400 });
        MR.modal.close(modal);
        return;
      }
      MR.toast.error(result.error || "Не удалось добавить данные из ссылки.");
      return;
    }

    MR.toast.success(result.message || "Добавлено.", { timeout: 3200 });
    MR.modal.close(modal);
  }

  function handleCopy() {
    const value = linkInput ? linkInput.value : "";
    copy(value).then(function (ok) {
      if (ok) {
        MR.toast.success("Ссылка скопирована");
      } else {
        MR.toast.error("Не удалось скопировать. Выделите ссылку и скопируйте вручную.");
      }
    });
  }

  /**
   * Esc закрывает только окно ссылки: иначе вместе с ним закрылась бы
   * форма станции/группы, из которой окно открыли.
   */
  function handleKeydown(event) {
    if (event.key !== "Escape" || !modal || modal.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    MR.modal.close(modal, { reason: "escape" });
  }

  /** Разбирает адресную строку и показывает предпросмотр. @returns {boolean} */
  function processLocation() {
    const parsed = parseLocation();
    if (!parsed.ok) return false;
    openImportModal(parsed.payload);
    return true;
  }

  function shareStation(stationId) {
    const station = MR.store.findStation(stationId);
    if (!station) {
      MR.toast.error("Станция не найдена.");
      return;
    }
    openLinkModal(payloadFromStation(station));
  }

  function shareGroup(groupId) {
    const group = MR.store.getGroup(groupId);
    if (!group) {
      MR.toast.error("Группа не найдена.");
      return;
    }
    if (!group.stationIds.length) {
      MR.toast.warning("В группе нет станций — ссылку создать не из чего.");
      return;
    }
    openLinkModal(payloadFromGroup(group));
  }

  function init() {
    const dom = MR.dom;
    if (!dom) return;

    modal = dom.$("#modal-share");
    if (!modal) return;

    title = dom.$("#share-title");
    subtitle = dom.$("#share-subtitle");
    preview = dom.$("#share-preview");
    warning = dom.$("#share-warning");
    linkRow = dom.$("#share-link-row");
    linkInput = dom.$("#share-link");
    hint = dom.$("#share-hint");
    copyButton = dom.$("#share-copy");
    addButton = dom.$("#share-add");
    cancelButton = dom.$("#share-cancel");

    MR.commands.registerMany({
      "station:share": function (payload) {
        const stationId = payload && payload.dataset ? payload.dataset.stationId : "";
        shareStation(stationId);
      },
      "group:share": function (payload) {
        const groupId = payload && payload.dataset ? payload.dataset.groupId : "";
        shareGroup(groupId);
      },
    });

    if (copyButton) copyButton.addEventListener("click", handleCopy);
    if (addButton) addButton.addEventListener("click", handleAdd);

    document.addEventListener("keydown", handleKeydown, true);
  }

  MR.share = {
    // Чистые функции — используются тестами без DOM.
    encode: encode,
    decode: decode,
    validate: validate,
    parsePayload: parsePayload,

    buildLink: buildLink,
    buildStationLink: buildStationLink,
    buildGroupLink: buildGroupLink,

    parseLocation: parseLocation,
    apply: apply,
    clearLocation: clearLocation,
    copy: copy,

    // Интерфейс.
    init: init,
    processLocation: processLocation,
    openStationLink: function (stationId) { shareStation(stationId); },
    openGroupLink: function (groupId) { shareGroup(groupId); },
    get isOpen() { return Boolean(modal) && !modal.hidden; },
    MAX_PAYLOAD_LENGTH: MAX_PAYLOAD_LENGTH,
  };
})(window);
