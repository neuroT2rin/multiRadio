/**
 * core/state.js — единое состояние приложения, действия и события.
 *
 * Правила:
 *  • Никакого DOM. Модуль можно тестировать в Node.
 *  • UI не меняет state напрямую — только через действия стора.
 *  • Каждое изменение публикует событие (см. MR.store.on).
 *  • Группы — единственный источник истины о принадлежности станции:
 *    stationIds внутри группы. Станция состоит максимум в одной группе.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;
  const storage = MR.storage;
  const config = MR.config;
  const defaults = MR.defaults;

  const listeners = new Map();
  let saveTimer = null;
  let initialized = false;

  /** @type {ReturnType<typeof createInitialState>} */
  let state = createInitialState();

  function createInitialState() {
    return {
      stations: [],
      favorites: new Set(),
      groups: [],

      filters: { favoritesOnly: false, groupId: null, query: "" },
      view: "stations",

      playback: {
        status: "idle",
        stationId: null,
        urlIndex: 0,
        url: "",
        sourceLabel: "",
        isPlaying: false,
        error: null,
      },

      volume: 0.8,
      muted: false,

      eqGains: defaults.eqBands.map(function () { return 0; }),
      eqPreset: "flat",

      /** id → { primary:{ok,latencyMs,reason}, fallbacks:[...], checkedAt } */
      health: {},
      healthProgress: {
        running: false,
        done: 0,
        total: 0,
        stationsDone: 0,
        stationsTotal: 0,
        finishedAt: 0,
      },

      network: { online: true, status: "checking", effectiveType: "", downlink: null },

      ui: {
        bgEnabled: true,
        mode: "spectrum",
        miniMode: "wave",
        stationView: "list",
        theme: "dark",
        compatMode: false,
      },

      loadedAt: Date.now(),
    };
  }

  /* ------------------------------------------------------------------------
     События
     ------------------------------------------------------------------------ */

  /**
   * Подписка на событие.
   * @returns {() => void} функция отписки
   */
  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return function off() {
      const set = listeners.get(event);
      if (set) set.delete(handler);
    };
  }

  function emit(event, detail) {
    const set = listeners.get(event);
    if (!set || set.size === 0) return;
    Array.from(set).forEach(function (handler) {
      try {
        handler(detail);
      } catch (error) {
        console.error("[MultiRadio] Ошибка обработчика «" + event + "»:", error);
      }
    });
  }

  function emitAll() {
    [
      "stations", "favorites", "groups", "filters", "view",
      "playback", "volume", "eq", "health", "health:progress",
      "network", "ui",
    ].forEach(function (event) { emit(event); });
  }

  /* ------------------------------------------------------------------------
     Нормализация данных (используется при загрузке и импорте)
     ------------------------------------------------------------------------ */

  function cleanText(value, maxLength) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, maxLength);
  }

  function cleanEmoji(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return Array.from(text).slice(0, 8).join("") || "📻";
  }

  function uniqueId(base, used) {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = base + "-" + suffix;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  }

  function isValidId(value) {
    return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value);
  }

  function normalizeStation(raw, usedIds) {
    if (!raw || typeof raw !== "object") return null;

    const name = cleanText(raw.name, config.limits.stationNameLength);
    const primary = typeof raw.primary === "string" ? raw.primary.trim() : "";

    if (!name || !utils.isHttpUrl(primary)) return null;

    const baseId = isValidId(raw.id) ? raw.id : utils.slugify(name);
    const id = uniqueId(baseId, usedIds);

    const seen = Object.create(null);
    const fallbacks = (Array.isArray(raw.fallbacks) ? raw.fallbacks : [])
      .map(function (url) { return typeof url === "string" ? url.trim() : ""; })
      .filter(function (url) {
        if (!utils.isHttpUrl(url) || url === primary || seen[url]) return false;
        seen[url] = true;
        return true;
      })
      .slice(0, config.audio.maxFallbacks);

    return {
      id: id,
      name: name,
      genre: cleanText(raw.genre, config.limits.genreLength) || "Без жанра",
      bitrate: cleanText(raw.bitrate, config.limits.bitrateLength) || "—",
      emoji: cleanEmoji(raw.emoji),
      primary: primary,
      fallbacks: fallbacks,
    };
  }

  function normalizeGroup(raw, stationIds, usedIds, usedNames) {
    if (!raw || typeof raw !== "object") return null;

    let name = cleanText(raw.name, config.limits.groupNameLength);
    if (!name) return null;

    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = cleanText(raw.name, config.limits.groupNameLength) + " (" + suffix + ")";
      suffix += 1;
    }
    usedNames.add(name.toLowerCase());

    const baseId = isValidId(raw.id) ? raw.id : utils.uid("group");
    const id = uniqueId(baseId, usedIds);

    const seen = new Set();
    const members = (Array.isArray(raw.stationIds) ? raw.stationIds : [])
      .filter(function (sid) {
        if (typeof sid !== "string" || !stationIds.has(sid) || seen.has(sid)) return false;
        seen.add(sid);
        return true;
      });

    return { id: id, name: name, stationIds: members };
  }

  function cloneDefaultStations() {
    const used = new Set();
    return (defaults.stations || [])
      .map(function (raw) { return normalizeStation(raw, used); })
      .filter(Boolean);
  }

  /** Убирает станции из нескольких групп сразу (защита от рассинхрона). */
  function dedupeMembership(groups) {
    const assigned = new Set();
    groups.forEach(function (group) {
      group.stationIds = group.stationIds.filter(function (sid) {
        if (assigned.has(sid)) return false;
        assigned.add(sid);
        return true;
      });
    });
  }

  /**
   * Загружает данные из сохранённого снимка или старого формата v1.
   * Не публикует события — это делает вызывающая сторона.
   */
  function hydrate(data) {
    const payload = data && typeof data === "object" ? data : {};

    /* --- Станции --- */
    const usedStationIds = new Set();
    let stations = [];
    if (Array.isArray(payload.stations)) {
      payload.stations.forEach(function (raw) {
        const station = normalizeStation(raw, usedStationIds);
        if (station) stations.push(station);
      });
    } else {
      stations = cloneDefaultStations();
    }

    const stationIds = new Set(stations.map(function (s) { return s.id; }));

    /* --- Группы + миграция stationGroups из v1 --- */
    const usedGroupIds = new Set();
    const usedGroupNames = new Set();
    const groupIdMap = new Map();
    const groups = [];

    (Array.isArray(payload.groups) ? payload.groups : []).forEach(function (raw) {
      const group = normalizeGroup(raw, stationIds, usedGroupIds, usedGroupNames);
      if (!group) return;
      if (raw && typeof raw.id === "string") groupIdMap.set(raw.id, group.id);
      groups.push(group);
    });

    if (payload.stationGroups && typeof payload.stationGroups === "object") {
      Object.keys(payload.stationGroups).forEach(function (sid) {
        if (!stationIds.has(sid)) return;
        const rawGroupId = payload.stationGroups[sid];
        const groupId = groupIdMap.get(rawGroupId) || rawGroupId;
        if (!usedGroupIds.has(groupId)) return;
        const group = groups.find(function (g) { return g.id === groupId; });
        if (!group) return;
        if (!groups.some(function (g) { return g.stationIds.indexOf(sid) !== -1; })) {
          group.stationIds.push(sid);
        }
      });
    }

    dedupeMembership(groups);

    /* --- Избранное --- */
    const favorites = new Set(
      (Array.isArray(payload.favorites) ? payload.favorites : [])
        .filter(function (id) { return typeof id === "string" && stationIds.has(id); })
    );

    /* --- Громкость и эквалайзер --- */
    let volume = 0.8;
    if (typeof payload.volume === "number" && Number.isFinite(payload.volume)) {
      volume = payload.volume > 1 && payload.volume <= 100 ? payload.volume / 100 : payload.volume;
      volume = utils.clamp(volume, 0, 1);
    }

    const bandCount = defaults.eqBands.length;
    let gains = new Array(bandCount).fill(0);
    let preset = "flat";

    if (payload.eq && Array.isArray(payload.eq.gains)) {
      gains = payload.eq.gains.slice(0, bandCount).map(function (value) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? utils.clamp(numeric, -20, 20) : 0;
      });
      while (gains.length < bandCount) gains.push(0);
    } else if (Array.isArray(payload.equalizer)) {
      // Формат v1: [{ frequency, type, gain }]
      gains = new Array(bandCount).fill(0);
      payload.equalizer.slice(0, bandCount).forEach(function (band, index) {
        const numeric = Number(band && band.gain);
        gains[index] = Number.isFinite(numeric) ? utils.clamp(numeric, -20, 20) : 0;
      });
    }

    if (payload.eq && typeof payload.eq.preset === "string" && defaults.eqPresets[payload.eq.preset]) {
      preset = payload.eq.preset;
    } else {
      preset = defaults.findPreset(gains) || "custom";
    }

    /* --- Вид --- */
    const ui = payload.ui && typeof payload.ui === "object" ? payload.ui : {};
    const view = config.views.indexOf(payload.view) !== -1 ? payload.view : "stations";
    const mode = config.visualizerModes.indexOf(ui.mode) !== -1 ? ui.mode : "spectrum";
    const miniMode = config.miniVisualizerModes.indexOf(ui.miniMode) !== -1 ? ui.miniMode : "wave";
    const stationView = config.stationViews.indexOf(ui.stationView) !== -1 ? ui.stationView : "list";
    const theme = config.themes.indexOf(ui.theme) !== -1 ? ui.theme : "dark";

    state.stations = stations;
    state.groups = groups;
    state.favorites = favorites;
    state.volume = volume;
    state.muted = Boolean(payload.muted);
    state.eqGains = gains;
    state.eqPreset = preset;
    state.view = view;
    state.ui = {
      bgEnabled: ui.bgEnabled !== false,
      mode: mode,
      miniMode: miniMode,
      stationView: stationView,
      theme: theme,
      compatMode: Boolean(ui.compatMode),
    };
    state.filters = { favoritesOnly: false, groupId: null, query: "" };
    state.health = {};
    state.healthProgress = {
      running: false, done: 0, total: 0,
      stationsDone: 0, stationsTotal: 0, finishedAt: 0,
    };
    state.playback = {
      status: "idle", stationId: null, urlIndex: 0,
      url: "", sourceLabel: "", isPlaying: false, error: null,
    };

    return {
      stations: stations.length,
      groups: groups.length,
      favorites: favorites.size,
    };
  }

  function init() {
    const saved = storage.get(config.storageKey, null);
    if (saved && typeof saved === "object") {
      hydrate(saved);
    } else {
      hydrate({});
    }
    initialized = true;
    return initialized;
  }

  /* ------------------------------------------------------------------------
     Сохранение
     ------------------------------------------------------------------------ */

  function serialize() {
    return {
      app: "MultiRadio",
      version: 2,
      savedAt: new Date().toISOString(),
      stations: state.stations.map(function (station) {
        return {
          id: station.id,
          name: station.name,
          genre: station.genre,
          bitrate: station.bitrate,
          emoji: station.emoji,
          primary: station.primary,
          fallbacks: station.fallbacks.slice(),
        };
      }),
      favorites: Array.from(state.favorites),
      groups: state.groups.map(function (group) {
        return { id: group.id, name: group.name, stationIds: group.stationIds.slice() };
      }),
      volume: state.volume,
      muted: state.muted,
      eq: { gains: state.eqGains.slice(), preset: state.eqPreset },
      view: state.view,
      ui: {
        bgEnabled: state.ui.bgEnabled,
        mode: state.ui.mode,
        miniMode: state.ui.miniMode,
        stationView: state.ui.stationView,
        theme: state.ui.theme,
        compatMode: state.ui.compatMode,
      },
    };
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    return storage.set(config.storageKey, serialize());
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      storage.set(config.storageKey, serialize());
    }, 300);
  }

  /* ------------------------------------------------------------------------
     Селекторы
     ------------------------------------------------------------------------ */

  const findStation = function (id) {
    return state.stations.find(function (station) { return station.id === id; }) || null;
  };

  const getStationIndex = function (id) {
    return state.stations.findIndex(function (station) { return station.id === id; });
  };

  const getCurrentStation = function () {
    return findStation(state.playback.stationId);
  };

  const getGroup = function (id) {
    return state.groups.find(function (group) { return group.id === id; }) || null;
  };

  const getGroupOfStation = function (stationId) {
    return state.groups.find(function (group) {
      return group.stationIds.indexOf(stationId) !== -1;
    }) || null;
  };

  function getVisibleStations() {
    const query = state.filters.query.trim().toLowerCase();
    return state.stations.filter(function (station) {
      if (state.filters.favoritesOnly && !state.favorites.has(station.id)) return false;
      if (state.filters.groupId) {
        const group = getGroup(state.filters.groupId);
        if (!group || group.stationIds.indexOf(station.id) === -1) return false;
      }
      if (query) {
        const haystack = (station.name + " " + station.genre).toLowerCase();
        if (haystack.indexOf(query) === -1) return false;
      }
      return true;
    });
  }

  const getStationUrls = function (station) {
    if (!station) return [];
    return [station.primary].concat(station.fallbacks || []);
  };

  function getHealth(stationId) {
    return state.health[stationId] || null;
  }

  function getHealthSummary() {
    const entries = Object.keys(state.health).map(function (id) { return state.health[id]; });
    return {
      total: state.stations.length,
      checked: entries.length,
      online: entries.filter(function (h) {
        return h.primary && h.primary.ok;
      }).length,
      fallbackOnly: entries.filter(function (h) {
        return !(h.primary && h.primary.ok) && (h.fallbacks || []).some(function (item) { return item.ok; });
      }).length,
      offline: entries.filter(function (h) {
        return !(h.primary && h.primary.ok) && !(h.fallbacks || []).some(function (item) { return item.ok; });
      }).length,
    };
  }

  /* ------------------------------------------------------------------------
     Станции
     ------------------------------------------------------------------------ */

  function validateStationInput(input, excludeId) {
    const source = input || {};
    const errors = {};

    const name = cleanText(source.name, config.limits.stationNameLength);
    if (!name) {
      errors.name = "Введите название станции";
    } else if (state.stations.some(function (station) {
      return station.id !== excludeId &&
        station.name.toLowerCase() === name.toLowerCase();
    })) {
      errors.name = "Станция с таким названием уже есть";
    }

    const primary = typeof source.primary === "string" ? source.primary.trim() : "";
    if (!primary) {
      errors.primary = "Введите адрес основного потока";
    } else if (!utils.isHttpUrl(primary)) {
      errors.primary = "Нужен полный http(s)-адрес";
    } else if (state.stations.some(function (station) {
      return station.id !== excludeId && station.primary === primary;
    })) {
      errors.primary = "Этот поток уже добавлен у другой станции";
    }

    const fallbackList = Array.isArray(source.fallbacks)
      ? utils.parseUrlList(source.fallbacks.join(" "))
      : utils.parseUrlList(source.fallbacks);
    const invalidFallbacks = fallbackList.filter(function (url) { return !utils.isHttpUrl(url); });
    if (invalidFallbacks.length) {
      errors.fallbacks = "Проверьте адрес: " + invalidFallbacks.slice(0, 2).join(", ");
    } else if (fallbackList.length > config.audio.maxFallbacks) {
      errors.fallbacks = "Не больше " + config.audio.maxFallbacks + " резервных адресов";
    }

    const genre = cleanText(source.genre, config.limits.genreLength);
    const bitrate = cleanText(source.bitrate, config.limits.bitrateLength);
    const emoji = cleanText(source.emoji, config.limits.emojiLength);
    const groupId = source.groupId ? String(source.groupId) : "";

    if (groupId && !getGroup(groupId)) {
      errors.groupId = "Группа не найдена";
    }

    return {
      ok: Object.keys(errors).length === 0,
      errors: errors,
      value: {
        name: name,
        primary: primary,
        genre: genre || "Без жанра",
        bitrate: bitrate || "—",
        emoji: cleanEmoji(emoji),
        fallbacks: fallbackList.filter(function (url) {
          return utils.isHttpUrl(url) && url !== primary;
        }).slice(0, config.audio.maxFallbacks),
        groupId: groupId,
      },
    };
  }

  function addStation(input) {
    if (state.stations.length >= config.limits.stations) {
      return { ok: false, errors: { general: "Достигнут лимит станций" } };
    }

    const check = validateStationInput(input);
    if (!check.ok) return check;

    const used = new Set(state.stations.map(function (station) { return station.id; }));
    const station = {
      id: uniqueId(utils.slugify(check.value.name), used),
      name: check.value.name,
      genre: check.value.genre,
      bitrate: check.value.bitrate,
      emoji: check.value.emoji,
      primary: check.value.primary,
      fallbacks: check.value.fallbacks,
    };

    state.stations.push(station);

    if (check.value.groupId) {
      moveStationToGroup(station.id, check.value.groupId, false);
    }

    emit("stations");
    if (check.value.groupId) emit("groups");
    save();
    return { ok: true, station: station, errors: {} };
  }

  function updateStation(id, input) {
    const index = getStationIndex(id);
    if (index === -1) {
      return { ok: false, errors: { general: "Станция не найдена" } };
    }

    const check = validateStationInput(input, id);
    if (!check.ok) return check;

    const previous = state.stations[index];
    const next = {
      id: previous.id,
      name: check.value.name,
      genre: check.value.genre,
      bitrate: check.value.bitrate,
      emoji: check.value.emoji,
      primary: check.value.primary,
      fallbacks: check.value.fallbacks.slice(),
    };

    state.stations[index] = next;

    const currentGroup = getGroupOfStation(id);
    const targetGroupId = check.value.groupId || null;
    if ((currentGroup ? currentGroup.id : null) !== targetGroupId) {
      moveStationToGroup(id, targetGroupId, false);
      emit("groups");
    }

    emit("stations");
    save();

    return {
      ok: true,
      station: next,
      errors: {},
      streamChanged: previous.primary !== next.primary ||
        previous.fallbacks.join("\n") !== next.fallbacks.join("\n"),
    };
  }

  function removeStation(id) {
    const station = findStation(id);
    if (!station) return false;

    state.stations = state.stations.filter(function (item) { return item.id !== id; });
    state.favorites.delete(id);
    delete state.health[id];
    state.groups.forEach(function (group) {
      group.stationIds = group.stationIds.filter(function (sid) { return sid !== id; });
    });

    if (state.playback.stationId === id) {
      setPlayback({
        status: "idle",
        stationId: null,
        urlIndex: 0,
        url: "",
        sourceLabel: "",
        isPlaying: false,
        error: null,
      });
    }

    emit("stations");
    emit("favorites");
    emit("groups");
    emit("health");
    save();
    return true;
  }

  /* ------------------------------------------------------------------------
     Избранное
     ------------------------------------------------------------------------ */

  function toggleFavorite(stationId) {
    if (!findStation(stationId)) return false;
    if (state.favorites.has(stationId)) {
      state.favorites.delete(stationId);
    } else {
      state.favorites.add(stationId);
    }
    emit("favorites");
    emit("stations");
    save();
    return state.favorites.has(stationId);
  }

  function clearFavorites() {
    if (state.favorites.size === 0) return;
    state.favorites.clear();
    emit("favorites");
    emit("stations");
    save();
  }

  /* ------------------------------------------------------------------------
     Группы
     ------------------------------------------------------------------------ */

  function validateGroupInput(input, excludeId) {
    const source = input || {};
    const errors = {};
    const name = cleanText(source.name, config.limits.groupNameLength);

    if (!name) {
      errors.name = "Введите название группы";
    } else if (state.groups.some(function (group) {
      return group.id !== excludeId &&
        group.name.toLowerCase() === name.toLowerCase();
    })) {
      errors.name = "Группа с таким названием уже есть";
    }

    const requested = Array.isArray(source.stationIds) ? source.stationIds : [];
    const seen = new Set();
    const stationIds = requested.filter(function (sid) {
      if (typeof sid !== "string" || seen.has(sid) || !findStation(sid)) return false;
      seen.add(sid);
      return true;
    });

    return { ok: Object.keys(errors).length === 0, errors: errors, value: { name: name, stationIds: stationIds } };
  }

  /**
   * Внутреннее перемещение станции. Без событий и сохранения.
   */
  function moveStationToGroup(stationId, groupId, shouldSave) {
    state.groups.forEach(function (group) {
      group.stationIds = group.stationIds.filter(function (sid) { return sid !== stationId; });
    });
    if (groupId) {
      const target = getGroup(groupId);
      if (target) target.stationIds.push(stationId);
    }
    if (shouldSave) save();
  }

  function assignStationToGroup(stationId, groupId) {
    if (!findStation(stationId)) return false;
    if (groupId && !getGroup(groupId)) return false;
    moveStationToGroup(stationId, groupId || null, false);
    emit("groups");
    emit("stations");
    save();
    return true;
  }

  function removeStationFromGroup(stationId, groupId) {
    const group = getGroup(groupId);
    if (!group) return false;
    const before = group.stationIds.length;
    group.stationIds = group.stationIds.filter(function (sid) { return sid !== stationId; });
    if (group.stationIds.length === before) return false;
    emit("groups");
    emit("stations");
    save();
    return true;
  }

  function addGroup(input) {
    if (state.groups.length >= config.limits.groups) {
      return { ok: false, errors: { general: "Достигнут лимит групп" } };
    }

    const check = validateGroupInput(input);
    if (!check.ok) return check;

    const used = new Set(state.groups.map(function (group) { return group.id; }));
    const group = {
      id: uniqueId(utils.uid("group"), used),
      name: check.value.name,
      stationIds: check.value.stationIds.slice(),
    };

    // Станции, добавленные в новую группу, покидают прежние.
    state.groups.forEach(function (existing) {
      existing.stationIds = existing.stationIds.filter(function (sid) {
        return group.stationIds.indexOf(sid) === -1;
      });
    });

    state.groups.push(group);
    emit("groups");
    emit("stations");
    save();
    return { ok: true, group: group, errors: {} };
  }

  function updateGroup(id, input) {
    const group = getGroup(id);
    if (!group) return { ok: false, errors: { general: "Группа не найдена" } };

    const check = validateGroupInput(input, id);
    if (!check.ok) return check;

    const nextIds = new Set(check.value.stationIds);
    state.groups.forEach(function (other) {
      if (other.id === id) return;
      other.stationIds = other.stationIds.filter(function (sid) { return !nextIds.has(sid); });
    });

    group.name = check.value.name;
    group.stationIds = check.value.stationIds.slice();

    emit("groups");
    emit("stations");
    save();
    return { ok: true, group: group, errors: {} };
  }

  function deleteGroup(id) {
    const group = getGroup(id);
    if (!group) return false;

    state.groups = state.groups.filter(function (item) { return item.id !== id; });

    if (state.filters.groupId === id) {
      state.filters.groupId = null;
      emit("filters");
    }

    emit("groups");
    emit("stations");
    save();
    return true;
  }

  function setFilters(patch) {
    const next = Object.assign({}, state.filters, patch || {});

    state.filters.favoritesOnly = Boolean(next.favoritesOnly);
    state.filters.query = cleanText(next.query, 60);
    state.filters.groupId = next.groupId && getGroup(next.groupId) ? next.groupId : null;

    emit("filters");
    return state.filters;
  }

  function clearFilters() {
    state.filters = { favoritesOnly: false, groupId: null, query: "" };
    emit("filters");
    return state.filters;
  }

  /* ------------------------------------------------------------------------
     Воспроизведение
     ------------------------------------------------------------------------ */

  function setPlayback(patch) {
    state.playback = Object.assign({}, state.playback, patch || {});
    emit("playback", state.playback);
    return state.playback;
  }

  /* ------------------------------------------------------------------------
     Громкость и эквалайзер
     ------------------------------------------------------------------------ */

  function setVolume(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return state.volume;
    state.volume = utils.clamp(numeric, 0, 1);
    emit("volume");
    save();
    return state.volume;
  }

  function toggleMute() {
    state.muted = !state.muted;
    emit("volume");
    save();
    return state.muted;
  }

  function setEqGain(index, gain) {
    if (index < 0 || index >= state.eqGains.length) return;
    const numeric = Number(gain);
    const value = Number.isFinite(numeric) ? utils.clamp(numeric, -20, 20) : 0;
    if (state.eqGains[index] === value) return;

    state.eqGains = state.eqGains.slice();
    state.eqGains[index] = value;
    state.eqPreset = defaults.findPreset(state.eqGains) || "custom";

    emit("eq");
    save();
    return state.eqGains;
  }

  function applyEqPreset(key) {
    const preset = defaults.eqPresets[key];
    if (!preset) return false;

    state.eqGains = preset.gains.slice();
    state.eqPreset = key;
    emit("eq");
    save();
    return true;
  }

  function setEqGains(gains) {
    if (!Array.isArray(gains)) return false;
    const bandCount = defaults.eqBands.length;
    state.eqGains = new Array(bandCount).fill(0).map(function (_, index) {
      const numeric = Number(gains[index]);
      return Number.isFinite(numeric) ? utils.clamp(numeric, -20, 20) : 0;
    });
    state.eqPreset = defaults.findPreset(state.eqGains) || "custom";
    emit("eq");
    save();
    return true;
  }

  function resetEq() {
    return applyEqPreset("flat");
  }

  /* ------------------------------------------------------------------------
     Проверка станций
     ------------------------------------------------------------------------ */

  function setHealth(stationId, result) {
    if (!stationId || !result) return;
    state.health[stationId] = Object.assign({ checkedAt: Date.now() }, result);
    emit("health");
  }

  function setHealthBatch(results) {
    Object.keys(results || {}).forEach(function (stationId) {
      if (findStation(stationId)) {
        state.health[stationId] = Object.assign({ checkedAt: Date.now() }, results[stationId]);
      }
    });
    emit("health");
  }

  function setHealthProgress(patch) {
    state.healthProgress = Object.assign({}, state.healthProgress, patch || {});
    emit("health:progress", state.healthProgress);
  }

  /* ------------------------------------------------------------------------
     Сеть и интерфейс
     ------------------------------------------------------------------------ */

  function setNetwork(patch) {
    state.network = Object.assign({}, state.network, patch || {});
    emit("network");
  }

  function setView(view) {
    if (config.views.indexOf(view) === -1 || state.view === view) return state.view;
    state.view = view;
    emit("view");
    save();
    return state.view;
  }

  function setBgEnabled(enabled) {
    state.ui = Object.assign({}, state.ui, { bgEnabled: Boolean(enabled) });
    emit("ui");
    save();
    return state.ui.bgEnabled;
  }

  function toggleBg() {
    return setBgEnabled(!state.ui.bgEnabled);
  }

  function setVisualizerMode(mode) {
    if (config.visualizerModes.indexOf(mode) === -1) return state.ui.mode;
    state.ui = Object.assign({}, state.ui, { mode: mode });
    emit("ui");
    save();
    return mode;
  }

  function setMiniMode(mode) {
    if (config.miniVisualizerModes.indexOf(mode) === -1) return state.ui.miniMode;
    state.ui = Object.assign({}, state.ui, { miniMode: mode });
    emit("ui");
    save();
    return mode;
  }

  function setStationView(view) {
    if (config.stationViews.indexOf(view) === -1) return state.ui.stationView;
    state.ui = Object.assign({}, state.ui, { stationView: view });
    emit("ui");
    save();
    return view;
  }

  function setTheme(theme) {
    if (config.themes.indexOf(theme) === -1) return state.ui.theme;
    state.ui = Object.assign({}, state.ui, { theme: theme });
    emit("ui");
    save();
    return theme;
  }

  function setCompatMode(enabled) {
    state.ui = Object.assign({}, state.ui, { compatMode: Boolean(enabled) });
    emit("ui");
    save();
    return state.ui.compatMode;
  }

  /* ------------------------------------------------------------------------
     Импорт / экспорт / сброс
     ------------------------------------------------------------------------ */

  function exportData() {
    return serialize();
  }

  /**
   * Слияние импорта с текущим состоянием: станции добавляются без дублей
   * по имени, группы объединяются по имени, избранное дополняется.
   * Настройки звука/вида остаются текущими.
   */
  function mergeImport(data) {
    const idMap = new Map();
    const rawStations = Array.isArray(data.stations) ? data.stations : [];
    let stationsAdded = 0;
    let stationsSkipped = 0;

    rawStations.forEach(function (raw) {
      if (!raw || typeof raw !== "object") return;

      const result = addStation({
        name: raw.name,
        emoji: raw.emoji,
        genre: raw.genre,
        bitrate: raw.bitrate,
        primary: raw.primary,
        fallbacks: Array.isArray(raw.fallbacks) ? raw.fallbacks : [],
        groupId: "",
      });

      if (result.ok) {
        stationsAdded += 1;
        if (raw.id) idMap.set(raw.id, result.station.id);
        return;
      }

      stationsSkipped += 1;
      const existing = state.stations.find(function (station) {
        return station.name.toLowerCase() === String(raw.name || "").trim().toLowerCase();
      });
      if (existing && raw.id) idMap.set(raw.id, existing.id);
    });

    const rawGroups = Array.isArray(data.groups) ? data.groups : [];
    let groupsAdded = 0;
    let groupsMerged = 0;

    rawGroups.forEach(function (raw) {
      if (!raw || typeof raw !== "object") return;
      const name = String(raw.name || "").trim();
      if (!name) return;

      const mappedIds = (Array.isArray(raw.stationIds) ? raw.stationIds : [])
        .map(function (stationId) { return idMap.get(stationId) || stationId; })
        .filter(function (stationId) { return Boolean(findStation(stationId)); });

      const existing = state.groups.find(function (group) {
        return group.name.toLowerCase() === name.toLowerCase();
      });

      if (existing) {
        const union = existing.stationIds.slice();
        mappedIds.forEach(function (stationId) {
          if (union.indexOf(stationId) === -1) union.push(stationId);
        });
        const updated = updateGroup(existing.id, { name: existing.name, stationIds: union });
        if (updated.ok) groupsMerged += 1;
        return;
      }

      const created = addGroup({ name: name, stationIds: mappedIds });
      if (created.ok) groupsAdded += 1;
    });

    const incomingFavorites = Array.isArray(data.favorites) ? data.favorites : [];
    let favoritesAdded = 0;
    incomingFavorites.forEach(function (stationId) {
      const mapped = idMap.get(stationId) || stationId;
      if (!findStation(mapped) || state.favorites.has(mapped)) return;
      state.favorites.add(mapped);
      favoritesAdded += 1;
    });
    if (favoritesAdded) emit("favorites");

    saveNow();
    emitAll();

    return {
      ok: true,
      mode: "merge",
      counts: {
        stations: stationsAdded,
        groups: groupsAdded + groupsMerged,
        groupsAdded: groupsAdded,
        groupsMerged: groupsMerged,
        favorites: favoritesAdded,
        skipped: stationsSkipped,
      },
    };
  }

  function importData(data, options) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "Файл не содержит объекта настроек" };
    }

    const version = Number(data.version);
    if (version !== 1 && version !== 2) {
      return { ok: false, error: "Неподдерживаемая версия файла: " + (data.version || "—") };
    }

    if (options && options.mode === "merge") {
      return mergeImport(data);
    }

    const counts = hydrate(data);
    saveNow();
    emitAll();

    return { ok: true, mode: "replace", counts: counts };
  }

  function resetAll() {
    storage.remove(config.storageKey);
    hydrate({});
    state.filters = { favoritesOnly: false, groupId: null, query: "" };
    state.view = "stations";
    state.healthProgress = {
      running: false, done: 0, total: 0,
      stationsDone: 0, stationsTotal: 0, finishedAt: 0,
    };
    emitAll();
    saveNow();
  }

  function restoreDefaultStations() {
    const stations = cloneDefaultStations();
    const ids = new Set(stations.map(function (station) { return station.id; }));

    state.stations = stations;
    state.favorites = new Set(
      Array.from(state.favorites).filter(function (id) { return ids.has(id); })
    );
    state.groups = state.groups.map(function (group) {
      return {
        id: group.id,
        name: group.name,
        stationIds: group.stationIds.filter(function (id) { return ids.has(id); }),
      };
    });
    state.health = {};

    if (state.playback.stationId && !ids.has(state.playback.stationId)) {
      setPlayback({
        status: "idle", stationId: null, urlIndex: 0,
        url: "", sourceLabel: "", isPlaying: false, error: null,
      });
    }

    emitAll();
    save();
  }

  /* ------------------------------------------------------------------------
     Публичный API
     ------------------------------------------------------------------------ */

  MR.store = {
    // Состояние только для чтения (по соглашению).
    state: state,
    get isInitialized() { return initialized; },

    init: init,
    on: on,
    emit: emit,
    save: save,
    saveNow: saveNow,
    serialize: serialize,
    hydrate: hydrate,

    findStation: findStation,
    getStationIndex: getStationIndex,
    getCurrentStation: getCurrentStation,
    getGroup: getGroup,
    getGroupOfStation: getGroupOfStation,
    getVisibleStations: getVisibleStations,
    getStationUrls: getStationUrls,
    getHealth: getHealth,
    getHealthSummary: getHealthSummary,

    addStation: addStation,
    updateStation: updateStation,
    removeStation: removeStation,
    validateStationInput: validateStationInput,

    toggleFavorite: toggleFavorite,
    clearFavorites: clearFavorites,

    addGroup: addGroup,
    updateGroup: updateGroup,
    deleteGroup: deleteGroup,
    assignStationToGroup: assignStationToGroup,
    removeStationFromGroup: removeStationFromGroup,
    validateGroupInput: validateGroupInput,

    setFilters: setFilters,
    clearFilters: clearFilters,

    setPlayback: setPlayback,
    setVolume: setVolume,
    toggleMute: toggleMute,
    setEqGain: setEqGain,
    setEqGains: setEqGains,
    applyEqPreset: applyEqPreset,
    resetEq: resetEq,

    setHealth: setHealth,
    setHealthBatch: setHealthBatch,
    setHealthProgress: setHealthProgress,

    setNetwork: setNetwork,
    setView: setView,
    setBgEnabled: setBgEnabled,
    toggleBg: toggleBg,
    setVisualizerMode: setVisualizerMode,
    setMiniMode: setMiniMode,
    setStationView: setStationView,
    setTheme: setTheme,
    setCompatMode: setCompatMode,

    exportData: exportData,
    importData: importData,
    resetAll: resetAll,
    restoreDefaultStations: restoreDefaultStations,
  };
})(window);
