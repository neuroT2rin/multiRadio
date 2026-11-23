/**
 * services/stats.js — статистика прослушивания.
 *
 * Копит секунды по станции и жанру, пока идёт воспроизведение, и хранит
 * их отдельным ключом localStorage (не часть основного снимка состояния).
 * Не трогает DOM: UI подписан на событие store «stats».
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const store = MR.store;

  const KEY = MR.config.statsKey;

  let data = { totalSeconds: 0, stations: {}, genres: {} };
  let startedAt = 0;
  let activeStationId = null;
  let saveTimer = null;
  let tickTimer = null;

  function fresh() {
    return { totalSeconds: 0, stations: {}, genres: {} };
  }

  function normalize(raw) {
    const result = fresh();
    if (!raw || typeof raw !== "object") return result;

    const total = Number(raw.totalSeconds);
    if (Number.isFinite(total) && total > 0) result.totalSeconds = total;

    if (raw.stations && typeof raw.stations === "object") {
      Object.keys(raw.stations).forEach(function (id) {
        const entry = raw.stations[id];
        const seconds = Number(entry && entry.seconds);
        if (!Number.isFinite(seconds) || seconds <= 0) return;
        result.stations[id] = {
          seconds: seconds,
          lastAt: Number(entry.lastAt) || 0,
        };
      });
    }

    if (raw.genres && typeof raw.genres === "object") {
      Object.keys(raw.genres).forEach(function (name) {
        const seconds = Number(raw.genres[name]);
        if (!Number.isFinite(seconds) || seconds <= 0) return;
        result.genres[name] = seconds;
      });
    }

    return result;
  }

  function load() {
    data = normalize(MR.storage.get(KEY, null));
  }

  function genreOf(station) {
    if (!station || !station.genre) return "Без жанра";
    const head = station.genre.split("/")[0].trim();
    return head || "Без жанра";
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, 4000);
  }

  function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    MR.storage.set(KEY, data);
    store.emit("stats");
  }

  function commit(now) {
    if (!startedAt || !activeStationId) return;
    const seconds = (now - startedAt) / 1000;
    startedAt = now;
    if (seconds < 0.5) return;

    data.totalSeconds += seconds;

    const entry = data.stations[activeStationId] ||
      (data.stations[activeStationId] = { seconds: 0, lastAt: 0 });
    entry.seconds += seconds;
    entry.lastAt = now;

    const genre = genreOf(store.findStation(activeStationId));
    data.genres[genre] = (data.genres[genre] || 0) + seconds;

    scheduleSave();
  }

  function sync() {
    const playback = store.state.playback;

    if (playback.isPlaying && playback.stationId) {
      if (activeStationId && activeStationId !== playback.stationId) {
        commit(Date.now());
        startedAt = 0;
      }
      if (!startedAt) {
        activeStationId = playback.stationId;
        startedAt = Date.now();
      }
      return;
    }

    if (startedAt) {
      commit(Date.now());
      startedAt = 0;
      saveNow();
    }
    activeStationId = null;
  }

  /** Топ станций и жанров для панели. */
  function getSummary() {
    const stations = Object.keys(data.stations)
      .map(function (id) {
        const station = store.findStation(id);
        if (!station) return null;
        return {
          id: id,
          name: station.name,
          emoji: station.emoji,
          seconds: data.stations[id].seconds,
        };
      })
      .filter(Boolean)
      .sort(function (a, b) { return b.seconds - a.seconds; });

    const genres = Object.keys(data.genres)
      .map(function (name) { return { name: name, seconds: data.genres[name] }; })
      .filter(function (item) { return item.seconds >= 1; })
      .sort(function (a, b) { return b.seconds - a.seconds; });

    return {
      totalSeconds: data.totalSeconds,
      stations: stations.slice(0, 5),
      genres: genres.slice(0, 5),
      stationsTracked: stations.length,
    };
  }

  function reset() {
    data = fresh();
    startedAt = 0;
    activeStationId = null;
    MR.storage.remove(KEY);
    store.emit("stats");
  }

  function init() {
    load();

    store.on("playback", sync);

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        if (startedAt) commit(Date.now());
        saveNow();
      } else {
        sync();
      }
    });

    global.addEventListener("beforeunload", function () {
      if (startedAt) commit(Date.now());
      saveNow();
    });

    tickTimer = setInterval(function () {
      if (startedAt) {
        commit(Date.now());
        saveNow();
      }
    }, 30000);

    sync();
  }

  function dispose() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (startedAt) commit(Date.now());
    saveNow();
  }

  MR.stats = {
    init: init,
    dispose: dispose,
    getSummary: getSummary,
    reset: reset,
    saveNow: saveNow,
  };
})(window);
