/**
 * services/health.js — проверка станций на откликаемость.
 *
 * Источник считается живым, если браузер смог загрузить его метаданные.
 * Проверка идёт без crossOrigin: нам важна именно воспроизводимость,
 * а не поддержка CORS. Результаты и прогресс публикуются в store —
 * полоса прогресса в шапке подписана на health:progress.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const store = MR.store;
  const config = MR.config;
  const utils = MR.utils;

  let running = false;
  let lastFinishedAt = 0;
  let intervalId = null;
  let startTimer = null;

  /** Автопроверки выполняются, только если пользователь их не выключил. */
  function autoCheckEnabled() {
    return store.state.ui.autoHealthCheck !== false;
  }

  /**
   * Проверяет один адрес через <audio preload="metadata">.
   * Это точнее, чем HEAD: подтверждает, что поток реально декодируется.
   */
  function probeUrl(url) {
    return new Promise(function (resolve) {
      if (!utils.isHttpUrl(url)) {
        resolve({ ok: false, reason: "invalid-url" });
        return;
      }

      let audio = null;
      let finished = false;
      let timer = null;

      function finish(ok, reason) {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (audio) {
          try {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
          } catch (error) {
            /* элемент уже мог быть удалён */
          }
        }
        audio = null;
        resolve({ ok: ok, reason: reason || null });
      }

      try {
        audio = new Audio();
        audio.preload = "metadata";
        audio.muted = true;
        audio.volume = 0;
        audio.addEventListener("loadedmetadata", function () { finish(true, "metadata"); });
        audio.addEventListener("canplay", function () { finish(true, "canplay"); });
        audio.addEventListener("error", function () { finish(false, "media-error"); });

        timer = setTimeout(function () { finish(false, "timeout"); }, config.health.probeTimeoutMs);
        audio.src = url;
        audio.load();
      } catch (error) {
        finish(false, "exception");
      }
    });
  }

  /** Пул воркеров: не больше N одновременных проверок. */
  async function runPool(tasks, limit) {
    let cursor = 0;
    const workers = new Array(Math.min(limit, tasks.length)).fill(null).map(async function () {
      while (cursor < tasks.length) {
        const index = cursor;
        cursor += 1;
        try {
          await tasks[index]();
        } catch (error) {
          console.warn("[MultiRadio] Ошибка проверки источника:", error);
        }
      }
    });
    await Promise.all(workers);
  }

  async function run(options) {
    const manual = Boolean(options && options.manual);

    if (running) {
      if (manual) {
        store.emit("notice", { level: "info", message: "Проверка уже идёт — дождитесь результата." });
      }
      return { ok: false, reason: "busy" };
    }

    const stations = store.state.stations.slice();

    if (stations.length === 0) {
      if (manual) {
        store.emit("notice", { level: "info", message: "Нет станций для проверки." });
      }
      return { ok: false, reason: "empty" };
    }

    const offline = global.navigator ? global.navigator.onLine === false : false;
    const startedAt = Date.now();
    const playback = store.state.playback;

    running = true;

    let totalUrls = 0;
    stations.forEach(function (station) {
      totalUrls += store.getStationUrls(station).length;
    });

    if (offline) {
      const results = {};
      stations.forEach(function (station) {
        const urls = store.getStationUrls(station);
        results[station.id] = {
          sources: urls.map(function () { return { ok: false, reason: "offline" }; }),
          checkedAt: Date.now(),
        };
      });
      store.setHealthBatch(results);
      store.setHealthProgress({
        running: false,
        done: totalUrls,
        total: totalUrls,
        stationsDone: stations.length,
        stationsTotal: stations.length,
        startedAt: startedAt,
        finishedAt: Date.now(),
      });
      running = false;
      lastFinishedAt = Date.now();
      if (manual) {
        store.emit("notice", { level: "warning", message: "Сеть недоступна — проверка отложена." });
      }
      return { ok: false, reason: "offline" };
    }

    let done = 0;
    let stationsDone = 0;
    const perStation = new Map();
    /** Одинаковые адреса разных станций проверяем один раз. */
    const uniqueUrls = new Map();
    /** Адрес, который сейчас звучит, повторно не запрашиваем: второй запрос
     *  к тому же потоку может оборвать вещание (ограничение сервера/браузера). */
    const playingUrl = playback.isPlaying && playback.url ? playback.url : "";

    stations.forEach(function (station) {
      const urls = store.getStationUrls(station);
      const entry = {
        station: station,
        urls: urls,
        results: new Array(urls.length).fill(null),
        remaining: urls.length,
      };
      perStation.set(station.id, entry);

      urls.forEach(function (url, index) {
        if (url === playingUrl) {
          entry.results[index] = { ok: true, reason: "now-playing" };
          entry.remaining -= 1;
          return;
        }
        if (!uniqueUrls.has(url)) uniqueUrls.set(url, url);
      });

      if (entry.remaining === 0 && urls.length > 0) {
        stationsDone += 1;
        store.setHealth(station.id, {
          sources: entry.results.map(function (result) {
            return result || { ok: false, reason: "no-url" };
          }),
          checkedAt: Date.now(),
        });
      }
    });

    const totalToProbe = uniqueUrls.size;

    store.setHealthProgress({
      running: true,
      done: 0,
      total: totalToProbe,
      stationsDone: 0,
      stationsTotal: stations.length,
      startedAt: startedAt,
      finishedAt: 0,
    });

    // Станции без адресов завершаем сразу — их нечем проверять.
    perStation.forEach(function (entry, stationId) {
      if (entry.urls.length > 0) return;
      stationsDone += 1;
      store.setHealth(stationId, {
        sources: [],
        checkedAt: Date.now(),
      });
    });

    const tasks = [];

    uniqueUrls.forEach(function (url) {
      tasks.push(async function () {
        const result = await probeUrl(url);
        done += 1;

        perStation.forEach(function (entry, stationId) {
          let matched = false;
          entry.urls.forEach(function (stationUrl, index) {
            if (stationUrl !== url) return;
            entry.results[index] = result;
            entry.remaining -= 1;
            matched = true;
          });
          if (!matched) return;

          if (entry.remaining === 0) {
            stationsDone += 1;
            store.setHealth(stationId, {
              sources: entry.results.map(function (result) {
                return result || { ok: false, reason: "no-url" };
              }),
              checkedAt: Date.now(),
            });
          }
        });

        store.setHealthProgress({
          done: done,
          total: totalToProbe,
          stationsDone: stationsDone,
        });
      });
    });

    await runPool(tasks, config.health.concurrency);

    const results = {};
    perStation.forEach(function (entry, stationId) {
      results[stationId] = {
        sources: entry.results.map(function (result) {
          return result || { ok: false, reason: "no-url" };
        }),
        checkedAt: Date.now(),
      };
    });

    store.setHealthBatch(results);
    store.setHealthProgress({
      running: false,
      done: totalToProbe,
      total: totalToProbe,
      stationsDone: stations.length,
      stationsTotal: stations.length,
      startedAt: startedAt,
      finishedAt: Date.now(),
    });

    running = false;
    lastFinishedAt = Date.now();

    if (manual) {
      const summary = store.getHealthSummary();
      store.emit("notice", {
        level: summary.offline === summary.total ? "warning" : "success",
        message: "Проверка завершена: " + summary.online + " онлайн, " +
          summary.fallbackOnly + " только через резерв, " + summary.offline + " недоступно.",
      });
    }

    return { ok: true, summary: store.getHealthSummary() };
  }

  function schedule() {
    intervalId = setInterval(function () {
      if (!autoCheckEnabled()) return;
      if (document.visibilityState === "hidden") return;
      if (running) return;
      run({ manual: false });
    }, config.health.intervalMs);
  }

  function init() {
    // Небольшая задержка, чтобы интерфейс успел отрисоваться.
    startTimer = setTimeout(function () {
      if (!autoCheckEnabled()) return;
      run({ manual: false });
    }, 250);

    schedule();

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible" || running) return;
      if (!autoCheckEnabled()) return;
      if (Date.now() - lastFinishedAt > config.health.intervalMs) {
        run({ manual: false });
      }
    });
  }

  function dispose() {
    if (intervalId) clearInterval(intervalId);
    if (startTimer) clearTimeout(startTimer);
    intervalId = null;
    startTimer = null;
  }

  MR.health = {
    init: init,
    run: run,
    dispose: dispose,
    get isRunning() { return running; },
  };
})(window);
