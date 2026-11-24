/**
 * services/audio.js — движок воспроизведения.
 *
 * Отвечает за:
 *  • цепочку Web Audio: элемент → громкость → 10 полос EQ → анализатор → выход;
 *  • перебор источников станции (primary → fallbacks) при ошибке или таймауте;
 *  • режим совместимости: если поток не отдаёт CORS, Web Audio даёт тишину.
 *    Тогда звук идёт напрямую через <audio>, а эквалайзер/спектр отключаются.
 *
 * Модуль не работает с DOM интерфейса — только публикует состояние в store.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;
  const store = MR.store;
  const config = MR.config;
  const defaults = MR.defaults;

  let audioEl = null;
  let ctx = null;
  let sourceNode = null;
  let gainNode = null;
  let analyserNode = null;
  let filters = [];

  let compat = false;
  let graphReady = false;
  let graphFailed = false;
  let captureDestination = null;
  /** Пока слушаем буфер «машины времени», живой эфир беззвучен, но продолжает играть. */
  let bufferSilent = false;
  let intendedPlaying = false;
  let activeUrl = "";
  let currentToken = 0;
  let connectTimer = null;
  let syncingCompat = false;
  let noticeShown = false;

  /* ------------------------------------------------------------------------
     Элемент и Web Audio
     ------------------------------------------------------------------------ */

  function createElement() {
    if (audioEl) destroyElement();

    audioEl = new Audio();
    audioEl.preload = "none";
    // crossOrigin выставляется в ensureGraph() строго до первой загрузки:
    // без CORS поток нельзя пропустить через Web Audio, но с ним нельзя
    // и просто проиграть. Поэтому режим совместимости обходится без него.

    audioEl.addEventListener("playing", onPlaying);
    audioEl.addEventListener("pause", onPause);
    audioEl.addEventListener("waiting", onWaiting);
    audioEl.addEventListener("stalled", onWaiting);
    audioEl.addEventListener("error", onError);
    audioEl.addEventListener("ended", onEnded);
    audioEl.addEventListener("canplay", onCanPlay);

    applyVolume();
  }

  function destroyElement() {
    if (!audioEl) return;
    try {
      audioEl.pause();
      audioEl.removeAttribute("src");
      audioEl.load();
    } catch (error) {
      /* элемент уже мог быть уничтожен */
    }
    audioEl = null;
    activeUrl = "";
  }

  function ensureGraph() {
    if (compat || graphFailed) return false;
    if (graphReady) return true;

    const AudioContextClass = global.AudioContext || global.webkitAudioContext;
    if (!AudioContextClass) {
      markGraphFailed("Web Audio API недоступен: звук идёт напрямую, спектр и эквалайзер отключены.");
      return false;
    }

    try {
      ctx = new AudioContextClass();
      audioEl.crossOrigin = "anonymous";
      sourceNode = ctx.createMediaElementSource(audioEl);

      gainNode = ctx.createGain();
      gainNode.gain.value = store.state.muted ? 0 : store.state.volume;

      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.82;

      filters = defaults.eqBands.map(function (band) {
        const filter = ctx.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = band.freq;
        filter.Q.value = 1;
        filter.gain.value = 0;
        return filter;
      });

      let node = sourceNode;
      node.connect(gainNode);
      node = gainNode;
      filters.forEach(function (filter) {
        node.connect(filter);
        node = filter;
      });
      node.connect(analyserNode);
      analyserNode.connect(ctx.destination);

      MR.analyser.attach(analyserNode);
      graphReady = true;

      applyVolume();
      applyEq();
      resumeContext();
      return true;
    } catch (error) {
      console.error("[MultiRadio] Не удалось создать аудиограф:", error);
      markGraphFailed("Не удалось включить Web Audio: звук идёт напрямую, спектр недоступен.");
      return false;
    }
  }

  /**
   * Аварийный переход в режим совместимости.
   * ВАЖНО: после createMediaElementSource элемент нельзя вернуть к обычному
   * выводу, поэтому создаём новый <audio> без crossOrigin.
   */
  function markGraphFailed(message) {
    graphFailed = true;
    teardownGraph();
    notifyOnce("warning", message);

    if (!compat) {
      compat = true;
      syncingCompat = true;
      store.setCompatMode(true);
      syncingCompat = false;
      createElement();
    }
  }

  function teardownGraph() {
    MR.analyser.detach();
    try {
      if (sourceNode) sourceNode.disconnect();
      if (gainNode) gainNode.disconnect();
      if (analyserNode) analyserNode.disconnect();
      filters.forEach(function (filter) { filter.disconnect(); });
    } catch (error) {
      /* узлы уже могли быть отключены */
    }
    filters = [];
    sourceNode = null;
    gainNode = null;
    analyserNode = null;
    captureDestination = null;
    bufferSilent = false;
    graphReady = false;

    if (ctx) {
      const context = ctx;
      ctx = null;
      if (typeof context.close === "function") {
        context.close().catch(function () {});
      }
    }
  }

  function resumeContext() {
    if (!ctx) return;
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      ctx.resume().catch(function () {});
    }
  }

  function graphUsable() {
    return graphReady && !compat;
  }

  /** Временно глушит живой эфир под воспроизведение буфера. */
  function setBufferSilent(silent) {
    bufferSilent = Boolean(silent);
    applyVolume();
  }

  /**
   * Поток для записи эфира. В обычном режиме берём звук после анализатора,
   * чтобы запись совпадала с тем, что слышно (с эквалайзером). В режиме
   * совместимости пробуем captureStream() самого элемента (может быть
   * недоступен из-за CORS).
   */
  /**
   * PCM-ответвление для «тайм-машины»: отдаёт сырые сэмплы после анализатора,
   * не влияя на звук (второй путь уходит в gain=0). Возвращает объект с
   * disconnect() или null, если граф недоступен.
   */
  function createPCMTap(onSamples) {
    if (!graphUsable() || !sourceNode || !ctx) return null;
    if (typeof ctx.createScriptProcessor !== "function") return null;

    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;

    // Ответвляемся до GainNode: «машина времени» должна продолжать писать
    // живой эфир даже когда он беззвучен из-за прослушивания буфера.
    sourceNode.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);

    processor.onaudioprocess = function (event) {
      const input = event.inputBuffer;
      const left = input.getChannelData(0);
      const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;
      onSamples(left, right, ctx ? ctx.sampleRate : 44100);
    };

    let stopped = false;

    return {
      disconnect: function () {
        if (stopped) return;
        stopped = true;
        try {
          processor.onaudioprocess = null;
          sourceNode.disconnect(processor);
        } catch (error) {
          /* узел уже отключён */
        }
        try { processor.disconnect(); } catch (error) { /* noop */ }
        try { sink.disconnect(); } catch (error) { /* noop */ }
      },
    };
  }

  function getCaptureStream() {
    if (graphUsable() && analyserNode && ctx) {
      if (!captureDestination) {
        try {
          captureDestination = ctx.createMediaStreamDestination();
          analyserNode.connect(captureDestination);
        } catch (error) {
          captureDestination = null;
        }
      }
      return captureDestination ? captureDestination.stream : null;
    }

    if (compat && audioEl && typeof audioEl.captureStream === "function") {
      try {
        return audioEl.captureStream();
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  /* ------------------------------------------------------------------------
     Громкость и эквалайзер
     ------------------------------------------------------------------------ */

  function applyVolume() {
    const effective = store.state.muted || bufferSilent ? 0 : store.state.volume;

    if (gainNode && ctx) {
      try {
        gainNode.gain.setTargetAtTime(effective, ctx.currentTime, 0.03);
      } catch (error) {
        gainNode.gain.value = effective;
      }
    }

    if (audioEl) {
      // Если звук идёт через Web Audio, громкость задаёт GainNode,
      // иначе — сам элемент.
      audioEl.volume = graphUsable() ? 1 : effective;
    }
  }

  function applyEq() {
    if (!graphReady || !ctx) return;
    filters.forEach(function (filter, index) {
      const target = store.state.eqGains[index] || 0;
      try {
        filter.gain.setTargetAtTime(target, ctx.currentTime, 0.03);
      } catch (error) {
        filter.gain.value = target;
      }
    });
  }

  /* ------------------------------------------------------------------------
     Воспроизведение
     ------------------------------------------------------------------------ */

  /**
   * Подпись источника: лучший по битрейту запускается первым, остальные —
   * резерв по убыванию. index — позиция в порядке воспроизведения.
   */
  function sourceLabel(station, index) {
    if (!station) return "—";
    const sources = store.getPlaybackSources(station);
    const source = sources[index];
    if (!source) return "—";

    const bitrate = utils.formatBitrate(source.bitrate);
    const hasBitrate = bitrate !== "— kbps";
    if (index === 0) return hasBitrate ? bitrate + " · лучший источник" : "лучший источник";
    return (hasBitrate ? bitrate + " · " : "") +
      "резерв " + index + " из " + (sources.length - 1);
  }

  function startConnectTimer(station, urlIndex) {
    clearConnectTimer();
    connectTimer = setTimeout(function () {
      connectTimer = null;
      if (!intendedPlaying) return;
      if (store.state.playback.status === "playing") return;
      tryNext(station, urlIndex, "источник не ответил за " + Math.round(config.audio.connectTimeoutMs / 1000) + " с");
    }, config.audio.connectTimeoutMs);
  }

  function clearConnectTimer() {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function playStation(stationId, options) {
    const station = store.findStation(stationId);
    if (!station) return false;

    const sources = store.getPlaybackSources(station);
    if (!sources.length) {
      store.setPlayback({
        status: "error",
        stationId: stationId,
        isPlaying: false,
        bitrate: null,
        error: "У станции нет источников",
      });
      return false;
    }

    const requested = Number(options && options.urlIndex);
    const urlIndex = utils.clamp(Number.isFinite(requested) ? requested : 0, 0, sources.length - 1);
    const url = sources[urlIndex].url;

    intendedPlaying = true;
    currentToken += 1;
    clearConnectTimer();

    store.setPlayback({
      status: "connecting",
      stationId: stationId,
      urlIndex: urlIndex,
      url: url,
      bitrate: sources[urlIndex].bitrate || null,
      sourceLabel: sourceLabel(station, urlIndex),
      isPlaying: false,
      error: null,
    });

    if (!compat) ensureGraph();
    resumeContext();
    applyVolume();

    activeUrl = url;

    try {
      audioEl.pause();
      audioEl.src = url;
      audioEl.load();
    } catch (error) {
      console.warn("[MultiRadio] Не удалось назначить источник:", error);
    }

    startConnectTimer(station, urlIndex);

    const token = currentToken;
    const promise = audioEl.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch(function (error) {
        handlePlayRejection(error, token, station, urlIndex);
      });
    }

    return true;
  }

  function handlePlayRejection(error, token, station, urlIndex) {
    if (token !== currentToken || !intendedPlaying) return;

    const name = error && error.name;

    if (name === "AbortError") return;

    if (name === "NotAllowedError") {
      intendedPlaying = false;
      clearConnectTimer();
      store.setPlayback({
        status: "blocked",
        isPlaying: false,
        error: "Браузер требует нажатия для запуска звука",
      });
      return;
    }

    tryNext(station, urlIndex, "браузер не смог начать воспроизведение");
  }

  function tryNext(station, fromIndex, reason) {
    if (!intendedPlaying) return;

    clearConnectTimer();

    const sources = store.getPlaybackSources(station);
    const nextIndex = fromIndex + 1;

    if (nextIndex < sources.length) {
      store.setPlayback({
        status: "connecting",
        isPlaying: false,
        error: null,
        urlIndex: nextIndex,
        url: sources[nextIndex].url,
        bitrate: sources[nextIndex].bitrate || null,
        sourceLabel: sourceLabel(station, nextIndex),
      });

      setTimeout(function () {
        if (!intendedPlaying) return;
        if (store.state.playback.stationId !== station.id) return;
        playStation(station.id, { urlIndex: nextIndex });
      }, config.audio.retryDelayMs);
      return;
    }

    // Все адреса испробованы. Если Web Audio ещё включён, вероятная причина —
    // отсутствие CORS. Пробуем тот же поток в режиме совместимости.
    if (!compat && !graphFailed) {
      const wasPlaying = intendedPlaying;
      applyCompatMode(true, { restart: false });
      store.emit("notice", {
        level: "warning",
        message: "Поток не отдаёт CORS-заголовки. Включён режим совместимости: звук есть, эквалайзер и спектр недоступны.",
      });

      setTimeout(function () {
        if (!wasPlaying || !intendedPlaying) return;
        if (store.state.playback.stationId !== station.id) return;
        playStation(station.id, { urlIndex: 0 });
      }, 250);
      return;
    }

    intendedPlaying = false;
    store.setPlayback({
      status: "error",
      isPlaying: false,
      bitrate: null,
      error: reason || "все источники недоступны",
    });
    store.emit("notice", {
      level: "error",
      message: "«" + station.name + "»: все источники недоступны (" + (reason || "ошибка") + ").",
    });
  }

  function describeMediaError() {
    const error = audioEl && audioEl.error;
    if (!error) return "неизвестная ошибка";
    switch (error.code) {
      case 1: return "загрузка прервана";
      case 2: return "сетевая ошибка";
      case 3: return "ошибка декодирования";
      case 4: return "формат не поддерживается или поток заблокирован";
      default: return "ошибка медиа";
    }
  }

  /* ------------------------------------------------------------------------
     События аудиоэлемента
     ------------------------------------------------------------------------ */

  function onPlaying() {
    clearConnectTimer();
    if (!intendedPlaying) return;
    store.setPlayback({
      status: "playing",
      isPlaying: true,
      error: null,
    });
  }

  function onPause() {
    if (intendedPlaying) return; // пауза при переключении источника
    const status = store.state.playback.status;
    if (status === "playing" || status === "buffering") {
      store.setPlayback({ status: "paused", isPlaying: false });
    }
  }

  function onWaiting() {
    if (!intendedPlaying) return;
    if (store.state.playback.status === "playing") {
      store.setPlayback({ status: "buffering", isPlaying: true });
    }
  }

  function onCanPlay() {
    if (!intendedPlaying) return;
    if (store.state.playback.status === "connecting") {
      store.setPlayback({ status: "buffering", isPlaying: true });
    }
  }

  function onEnded() {
    clearConnectTimer();
    intendedPlaying = false;
    store.setPlayback({ status: "idle", isPlaying: false, bitrate: null });
  }

  function onError() {
    if (!intendedPlaying) return;

    // Событие могло прийти от предыдущего источника.
    if (activeUrl && audioEl && audioEl.currentSrc && audioEl.currentSrc !== activeUrl) {
      return;
    }

    const station = store.findStation(store.state.playback.stationId);
    if (!station) return;

    clearConnectTimer();
    tryNext(station, store.state.playback.urlIndex, describeMediaError());
  }

  /* ------------------------------------------------------------------------
     Режим совместимости
     ------------------------------------------------------------------------ */

  function applyCompatMode(enabled, options) {
    if (enabled === compat) return;

    const resumeId = store.state.playback.stationId;
    const resumeIndex = store.state.playback.urlIndex;
    const shouldRestart = Boolean(options && options.restart) && intendedPlaying;

    compat = enabled;

    syncingCompat = true;
    store.setCompatMode(enabled);
    syncingCompat = false;

    teardownGraph();
    createElement();
    applyVolume();

    if (shouldRestart && resumeId) {
      playStation(resumeId, { urlIndex: resumeIndex });
    }
  }

  function onUiChange() {
    if (syncingCompat) return;
    const desired = Boolean(store.state.ui.compatMode);
    if (desired === compat) return;

    applyCompatMode(desired, { restart: true });
    if (desired) {
      store.emit("notice", {
        level: "info",
        message: "Включён режим совместимости: звук без Web Audio, эквалайзер недоступен.",
      });
    }
  }

  /* ------------------------------------------------------------------------
     Публичное управление
     ------------------------------------------------------------------------ */

  function pause() {
    intendedPlaying = false;
    currentToken += 1;
    clearConnectTimer();
    if (audioEl) {
      try { audioEl.pause(); } catch (error) { /* noop */ }
    }
    if (store.state.playback.status !== "idle") {
      store.setPlayback({ status: "paused", isPlaying: false });
    }
  }

  function stop() {
    intendedPlaying = false;
    currentToken += 1;
    clearConnectTimer();

    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
      } catch (error) {
        /* noop */
      }
    }
    activeUrl = "";
    store.setPlayback({
      status: "idle",
      isPlaying: false,
      url: "",
      bitrate: null,
      sourceLabel: "",
      urlIndex: 0,
      error: null,
    });
  }

  function toggle() {
    const playback = store.state.playback;

    if (playback.isPlaying || playback.status === "connecting" || playback.status === "buffering") {
      pause();
      return;
    }

    const station = store.findStation(playback.stationId);
    if (!station) {
      if (store.state.stations.length === 0) {
        store.emit("notice", { level: "info", message: "Сначала добавьте хотя бы одну станцию." });
        return;
      }
      playStation(store.state.stations[0].id);
      return;
    }

    // Пауза на живом потоке: продолжаем с буфера, а не перезагружаем его.
    if (playback.status === "paused" && audioEl && audioEl.src) {
      intendedPlaying = true;
      resumeContext();
      const promise = audioEl.play();
      if (promise && typeof promise.catch === "function") {
        promise.catch(function (error) {
          handlePlayRejection(error, currentToken, station, playback.urlIndex);
        });
      }
      return;
    }

    playStation(station.id, {
      urlIndex: playback.status === "error" ? 0 : playback.urlIndex,
    });
  }

  function next() {
    const stations = store.state.stations;
    if (!stations.length) return;
    const index = stations.findIndex(function (station) {
      return station.id === store.state.playback.stationId;
    });
    const nextIndex = index === -1 ? 0 : (index + 1) % stations.length;
    playStation(stations[nextIndex].id);
  }

  function prev() {
    const stations = store.state.stations;
    if (!stations.length) return;
    const index = stations.findIndex(function (station) {
      return station.id === store.state.playback.stationId;
    });
    const prevIndex = index === -1 ? stations.length - 1 : (index - 1 + stations.length) % stations.length;
    playStation(stations[prevIndex].id);
  }

  function notifyOnce(level, message) {
    if (noticeShown) return;
    noticeShown = true;
    store.emit("notice", { level: level, message: message });
  }

  function init() {
    compat = Boolean(store.state.ui.compatMode);
    createElement();

    store.on("volume", applyVolume);
    store.on("eq", applyEq);
    store.on("ui", onUiChange);

    // Если станцию удалили, стор сбрасывает воспроизведение в idle —
    // останавливаем и звук, чтобы он не продолжал играть «в никуда».
    store.on("playback", function (playback) {
      const current = playback || store.state.playback;
      if (current.stationId === null && current.status === "idle" && intendedPlaying) {
        intendedPlaying = false;
        currentToken += 1;
        clearConnectTimer();
        if (audioEl) {
          try {
            audioEl.pause();
            audioEl.removeAttribute("src");
            audioEl.load();
          } catch (error) {
            /* noop */
          }
        }
        activeUrl = "";
      }
    });
  }

  function dispose() {
    intendedPlaying = false;
    clearConnectTimer();
    if (audioEl) {
      try { audioEl.pause(); } catch (error) { /* noop */ }
    }
    teardownGraph();
  }

  MR.audio = {
    init: init,
    dispose: dispose,
    playStation: playStation,
    toggle: toggle,
    pause: pause,
    stop: stop,
    next: next,
    prev: prev,
    get isCompat() { return compat; },
    get isGraphReady() { return graphReady; },
    getSourceLabel: sourceLabel,
    getCaptureStream: getCaptureStream,
    createPCMTap: createPCMTap,
    setBufferSilent: setBufferSilent,
  };
})(window);
