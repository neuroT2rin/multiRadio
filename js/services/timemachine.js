/**
 * services/timemachine.js — «машина времени» эфира.
 *
 * В памяти держится последние несколько минут звука в моно-PCM (16 кГц):
 * это ~38 МБ на 10 минут и позволяет точно отмотать назад. Перемотка строит
 * WAV из выбранного места и проигрывает его отдельным <audio>, живой поток
 * не ставится на паузу, а глушится, чтобы буфер продолжал писаться.
 *
 * Воспроизведение буфера — непрерывная лента. В PCM-таймлайне хранятся
 * абсолютная позиция прослушивания (cursor) и текущая граница записи
 * (totalSamples). Когда WAV подходит к концу, заранее (за PREBUILD_LEAD
 * секунд) строится следующий сегмент — от абсолютной позиции конца текущего
 * до актуальной границы записи. На `ended` он сразу запускается, поэтому
 * воспроизведение продолжается без прыжка в живой эфир и без пропуска
 * записанных секунд. Если новых сэмплов ещё нет, ждём коротким таймером и
 * повторяем: эфир всё это время остаётся заглушённым и продолжает писаться.
 *
 * Пауза не стирает данные: звучащий буфер ставится на паузу и продолжает с
 * выбранного места. Остановка и смена станции сбрасывают буфер.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const store = MR.store;
  const utils = MR.utils;
  const config = MR.config;

  const TARGET_RATE = 16000;
  /** За сколько секунд до конца сегмента готовим следующий WAV. */
  const PREBUILD_LEAD = 0.6;
  /** Пауза перед повтором, если записанных сэмплов ещё нет. */
  const CHAIN_RETRY_MS = 150;
  /** Сколько неудачных запусков/ожиданий терпим, прежде чем вернуться в эфир. */
  const MAX_CHAIN_FAILURES = 8;
  const MAX_CHAIN_WAITS = 100;

  let tap = null;
  let capturing = false;
  let chunks = [];
  let totalSamples = 0;
  let sourceRate = 44100;

  /** Абсолютная позиция прослушивания в PCM-таймлайне, в сэмплах. */
  let cursor = 0;
  let buffered = false;
  /** Буфер намеренно приостановлен (пауза плеера или пауза эфира). */
  let bufferPaused = false;

  let activeEl = null;
  let spareEl = null;
  let pendingEl = null;
  let segmentStart = 0;
  let segmentEnd = 0;

  let advanceTimer = null;
  let chainTimer = null;
  let chainFailures = 0;
  let chainWaits = 0;
  let chainToken = 0;

  let activeStationId = null;
  let emitTimer = null;

  function emit() {
    store.emit("timemachine");
  }

  /** Запись буфера включена в настройках (по умолчанию — да). */
  function isEnabled() {
    return store.state.ui.bufferEnabled !== false;
  }

  /** Текущий размер окна буфера в секундах (из настроек). */
  function maxSeconds() {
    const minutes = Number(store.state.ui.bufferMinutes);
    const safe = config.timemachine.options.indexOf(minutes) !== -1
      ? minutes
      : config.timemachine.defaultMinutes;
    return safe * 60;
  }

  function availableSeconds() {
    if (!isEnabled() || !chunks.length) return 0;
    return (totalSamples - chunks[0].start) / TARGET_RATE;
  }

  /** Обрезает буфер по текущему максимуму (настройка могла уменьшиться). */
  function trimChunks() {
    const limit = maxSeconds() * TARGET_RATE;
    while (chunks.length > 1 && totalSamples - chunks[0].start > limit) {
      chunks.shift();
    }
  }

  function appendSamples(mono) {
    chunks.push({ start: totalSamples, data: mono });
    totalSamples += mono.length;
    trimChunks();
  }

  function handleSamples(left, right, rate) {
    if (!isEnabled()) return;
    // На паузе поток ещё может отдавать буферы, но это тишина — не пишем её.
    if (!store.state.playback.isPlaying) return;
    if (!left || !left.length) return;
    sourceRate = rate || sourceRate;

    const step = sourceRate / TARGET_RATE;
    const outputLength = Math.max(1, Math.floor(left.length / step));
    const mono = new Float32Array(outputLength);

    let position = 0;
    for (let i = 0; i < outputLength; i += 1) {
      const index = Math.floor(position);
      const fraction = position - index;
      const nextIndex = Math.min(left.length - 1, index + 1);
      const a = (left[index] + right[index]) * 0.5;
      const b = (left[nextIndex] + right[nextIndex]) * 0.5;
      mono[i] = a + (b - a) * fraction;
      position += step;
    }

    appendSamples(mono);
  }

  function ensureTap() {
    if (!isEnabled()) return;
    // В режиме совместимости Web Audio выключен — PCM-ответвление невозможно.
    if (store.state.ui.compatMode) return;
    if (capturing) return;
    if (!store.state.playback.isPlaying) return;

    tap = MR.audio.createPCMTap(handleSamples);
    if (!tap) {
      setTimeout(ensureTap, 800);
      return;
    }
    capturing = true;
    emit();
  }

  function stopCapture() {
    if (tap) tap.disconnect();
    tap = null;
    capturing = false;
  }

  /* ------------------------------------------------------------------------
     PCM-таймлайн → WAV
     ------------------------------------------------------------------------ */

  /** Копирует записанные сэмплы из абсолютного интервала [startAbs, endAbs). */
  function collectRange(startAbs, endAbs) {
    const parts = [];
    let total = 0;

    chunks.forEach(function (chunk) {
      const chunkEnd = chunk.start + chunk.data.length;
      const from = Math.max(startAbs, chunk.start);
      const to = Math.min(endAbs, chunkEnd);
      if (to <= from) return;
      const part = chunk.data.subarray(from - chunk.start, to - chunk.start);
      parts.push(part);
      total += part.length;
    });

    const output = new Float32Array(total);
    let offset = 0;
    parts.forEach(function (part) {
      output.set(part, offset);
      offset += part.length;
    });
    return output;
  }

  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    function writeString(offset, text) {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i += 1) {
      const value = utils.clamp(samples[i], -1, 1);
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }

    return new Blob([view], { type: "audio/wav" });
  }

  /**
   * Строит сегмент WAV для абсолютного интервала. Возвращает фактические
   * границы (они могут быть уже запрошенных, если старые чанки обрезаны).
   */
  function buildSegment(startAbs, endAbs) {
    const first = chunks.length ? chunks[0].start : 0;
    const from = Math.max(first, Math.floor(startAbs));
    const to = Math.min(totalSamples, Math.floor(endAbs));
    if (to - from < 1) return null;

    const samples = collectRange(from, to);
    if (!samples.length) return null;

    return {
      blob: encodeWav(samples, TARGET_RATE),
      start: from,
      end: to,
    };
  }

  /* ------------------------------------------------------------------------
     Элементы буфера
     ------------------------------------------------------------------------ */

  /**
   * Буфер не проходит через GainNode живого эфира, поэтому громкость и mute
   * выставляются прямо элементам.
   */
  function applyBufferVolume() {
    const volume = Number(store.state.volume);
    const safe = Number.isFinite(volume) ? utils.clamp(volume, 0, 1) : 1;
    const value = store.state.muted ? 0 : safe;
    if (activeEl) activeEl.volume = value;
    if (spareEl) spareEl.volume = value;
  }

  function createPlayerElement() {
    const el = new Audio();
    el.preload = "auto";
    el.addEventListener("timeupdate", function () { onTimeUpdate(el); });
    el.addEventListener("ended", function () { onEnded(el); });
    el.addEventListener("playing", function () { onPlaying(el); });
    el.addEventListener("error", function () { onElementError(el); });
    return el;
  }

  function ensurePlayers() {
    if (!activeEl) activeEl = createPlayerElement();
    if (!spareEl) spareEl = createPlayerElement();
    applyBufferVolume();
  }

  /** Назначает элементу готовый сегмент (старый URL освобождается). */
  function assignSegment(el, segment) {
    if (el.__wavUrl) {
      URL.revokeObjectURL(el.__wavUrl);
      el.__wavUrl = "";
    }

    const url = URL.createObjectURL(segment.blob);
    el.__wavUrl = url;
    el.__wavStart = segment.start;
    el.__wavEnd = segment.end;
    el.src = url;
    try { el.load(); } catch (error) { /* noop */ }
    return true;
  }

  function releaseElement(el) {
    if (!el) return;
    try { el.pause(); } catch (error) { /* noop */ }
    try {
      el.removeAttribute("src");
      el.load();
    } catch (error) { /* noop */ }
    if (el.__wavUrl) {
      URL.revokeObjectURL(el.__wavUrl);
      el.__wavUrl = "";
    }
    el.__wavStart = 0;
    el.__wavEnd = 0;
  }

  function clearPlaybackTimers() {
    if (advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    if (chainTimer) {
      clearTimeout(chainTimer);
      chainTimer = null;
    }
  }

  /** Полностью освобождает оба элемента и служебные таймеры. */
  function resetPlayback() {
    clearPlaybackTimers();

    const oldActive = activeEl;
    const oldSpare = spareEl;
    const oldPending = pendingEl;

    activeEl = null;
    spareEl = null;
    pendingEl = null;
    segmentStart = 0;
    segmentEnd = 0;
    chainFailures = 0;
    chainWaits = 0;
    chainToken += 1;

    releaseElement(oldActive);
    if (oldSpare && oldSpare !== oldActive) releaseElement(oldSpare);
    if (oldPending && oldPending !== oldActive && oldPending !== oldSpare) {
      releaseElement(oldPending);
    }
  }

  /* ------------------------------------------------------------------------
     Позиция прослушивания
     ------------------------------------------------------------------------ */

  /** Абсолютная позиция активного сегмента по currentTime элемента. */
  function positionOfActive() {
    if (!buffered || !activeEl) return cursor;
    const time = Number(activeEl.currentTime);
    if (!Number.isFinite(time) || time <= 0) return cursor;
    return Math.min(segmentEnd, segmentStart + Math.round(time * TARGET_RATE));
  }

  /* ------------------------------------------------------------------------
     Непрерывная лента: подготовка и переключение сегментов
     ------------------------------------------------------------------------ */

  /** Таймер у конца текущего сегмента: готовим следующий WAV заранее. */
  function armAdvance() {
    if (advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    if (!buffered || bufferPaused || !activeEl) return;

    const duration = Math.max(0, segmentEnd - segmentStart) / TARGET_RATE;
    const position = Number(activeEl.currentTime) || 0;
    const delay = Math.max(0, (duration - PREBUILD_LEAD - position) * 1000);

    advanceTimer = setTimeout(function () {
      advanceTimer = null;
      requestNextSegment();
    }, delay);
  }

  function scheduleChainRetry() {
    if (chainTimer) return;
    chainTimer = setTimeout(function () {
      chainTimer = null;
      if (!buffered || bufferPaused || pendingEl) return;
      if (!store.state.playback.isPlaying) return;

      if (activeEl && !activeEl.ended) {
        // Сегмент ещё звучит — просто ждём данных для предзагрузки.
        requestNextSegment();
        return;
      }
      startNextSegment();
    }, CHAIN_RETRY_MS);
  }

  /**
   * Заранее строит следующий сегмент от абсолютной позиции конца текущего до
   * актуальной границы записи. Если новых сэмплов ещё нет — короткий таймер.
   */
  function requestNextSegment() {
    if (!buffered || bufferPaused || pendingEl || !isEnabled()) return;
    if (!store.state.playback.isPlaying) return;

    const from = segmentEnd;
    const ready = Boolean(
      spareEl && spareEl.__wavUrl &&
      spareEl.__wavStart === from && spareEl.__wavEnd > from
    );

    if (!ready) {
      const to = totalSamples;
      if (to <= from) {
        chainWaits += 1;
        if (chainWaits > MAX_CHAIN_WAITS) {
          // Запись давно не растёт — нет смысла держать эфир заглушённым.
          returnLive();
          return;
        }
        scheduleChainRetry();
        return;
      }

      ensurePlayers();
      const segment = buildSegment(from, to);
      if (!segment) {
        scheduleChainRetry();
        return;
      }
      assignSegment(spareEl, segment);
    }

    chainWaits = 0;

    // Сегмент уже доигран (ждём только данных) — запускаем сразу.
    if (activeEl && activeEl.ended) startNextSegment();
  }

  /** Запускает следующий сегмент, не возвращаясь в живой эфир. */
  function startNextSegment() {
    if (!buffered || bufferPaused || pendingEl || !isEnabled()) return;
    if (!store.state.playback.isPlaying) return;

    const from = segmentEnd;
    let candidate = null;

    if (spareEl && spareEl.__wavUrl &&
        spareEl.__wavStart === from && spareEl.__wavEnd > from) {
      candidate = spareEl;
    } else {
      const to = totalSamples;
      if (to <= from) {
        chainWaits += 1;
        if (chainWaits > MAX_CHAIN_WAITS) {
          returnLive();
          return;
        }
        scheduleChainRetry();
        return;
      }
      ensurePlayers();
      const segment = buildSegment(from, to);
      if (!segment) {
        scheduleChainRetry();
        return;
      }
      assignSegment(spareEl, segment);
      candidate = spareEl;
    }

    pendingEl = candidate;
    applyBufferVolume();

    try { candidate.currentTime = 0; } catch (error) { /* noop */ }

    // Токен защищает от позднего reject предыдущей попытки, когда элемент уже
    // участвует в новом переключении.
    chainToken += 1;
    const token = chainToken;
    const promise = candidate.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch(function () {
        if (token !== chainToken) return;
        onChainFailure(candidate);
      });
    }
  }

  /** Новый сегмент зазвучал: только теперь освобождаем предыдущий. */
  function activate(el) {
    if (!buffered || el !== pendingEl) return;

    const old = activeEl;
    pendingEl = null;
    activeEl = el;
    segmentStart = el.__wavStart;
    segmentEnd = el.__wavEnd;
    cursor = segmentStart;
    chainFailures = 0;
    chainWaits = 0;

    // Старый сегмент отпускаем после старта нового — без наложения двух WAV.
    spareEl = old;
    releaseElement(old);

    applyBufferVolume();
    armAdvance();
    emit();
  }

  function maybeActivate(el) {
    if (!buffered || el !== pendingEl) return;
    if (el.paused || el.ended) return;
    activate(el);
  }

  function onChainFailure(el) {
    if (el !== pendingEl) return;
    pendingEl = null;
    releaseElement(el);
    chainFailures += 1;
    if (chainFailures > MAX_CHAIN_FAILURES) {
      returnLive();
      return;
    }
    scheduleChainRetry();
  }

  function onTimeUpdate(el) {
    if (el === pendingEl) {
      maybeActivate(el);
      if (el !== activeEl) return;
    }
    if (!buffered || el !== activeEl) return;

    cursor = positionOfActive();
    if (bufferPaused) return;

    const duration = Math.max(0, segmentEnd - segmentStart) / TARGET_RATE;
    const position = Number(el.currentTime) || 0;
    if (duration - position <= PREBUILD_LEAD) requestNextSegment();
  }

  function onEnded(el) {
    if (!buffered || el !== activeEl) return;
    cursor = segmentEnd;
    if (bufferPaused || !store.state.playback.isPlaying) return;

    if (advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    // Не возвращаемся в эфир: продолжаем ленту со следующего сегмента.
    startNextSegment();
  }

  function onPlaying(el) {
    if (el === pendingEl) {
      activate(el);
      return;
    }
    if (el !== activeEl) return;
    if (!buffered || bufferPaused) return;
    armAdvance();
  }

  function onElementError(el) {
    if (!buffered) return;
    if (el === pendingEl) {
      onChainFailure(el);
      return;
    }
    if (el !== activeEl) return;
    // Текущий сегмент не читается — дальше продолжать нечем.
    returnLive();
  }

  /* ------------------------------------------------------------------------
     Публичное управление
     ------------------------------------------------------------------------ */

  /**
   * Готовит WAV с выбранной позиции и назначает его активному элементу,
   * но не запускает воспроизведение. Живой эфир при этом глушится.
   */
  function prepare(secondsBack) {
    if (!isEnabled()) return false;

    const available = availableSeconds();
    if (available < 2) return false;

    const raw = Number(secondsBack);
    const requested = Number.isFinite(raw) ? raw : 1;
    const clamped = utils.clamp(requested, 1, Math.max(1, available - 0.3));
    const startSample = Math.max(
      chunks[0].start,
      totalSamples - Math.floor(clamped * TARGET_RATE)
    );

    const segment = buildSegment(startSample, totalSamples);
    if (!segment) return false;

    resetPlayback();
    ensurePlayers();
    if (!assignSegment(activeEl, segment)) return false;

    segmentStart = segment.start;
    segmentEnd = segment.end;
    cursor = segmentStart;
    buffered = true;
    // На паузе эфира буфер только готовится: звук продолжит Play.
    bufferPaused = !store.state.playback.isPlaying;

    // Живой эфир не ставим на паузу — только глушим, чтобы буфер продолжал
    // писаться, а в плеере не появлялось состояние «Пауза».
    MR.audio.setBufferSilent(true);
    applyBufferVolume();

    emit();
    return true;
  }

  /** Запускает уже подготовленный (или приостановленный) буфер. */
  function startBuffer() {
    if (!isEnabled() || !buffered || !activeEl) return false;

    applyBufferVolume();

    if (!activeEl.paused && !activeEl.ended) {
      bufferPaused = false;
      armAdvance();
      emit();
      return true;
    }

    if (activeEl.ended) {
      // Сегмент доигран — продолжаем ленту с абсолютной позиции.
      bufferPaused = false;
      startNextSegment();
      emit();
      return buffered;
    }

    bufferPaused = false;
    const el = activeEl;
    const promise = el.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch(function () {
        // Автозапуск запрещён или источник недоступен: возвращаемся к эфиру,
        // данные буфера при этом остаются в памяти.
        if (buffered && activeEl === el) returnLive();
      });
    }

    emit();
    return true;
  }

  function playFrom(secondsBack) {
    if (!prepare(secondsBack)) return false;
    return startBuffer();
  }

  /**
   * Перемотка без смены состояния плеера: на паузе только готовит буфер
   * (продолжение — по Play), во время живого эфира сразу играет.
   */
  function seek(secondsBack) {
    if (!isEnabled()) return false;
    if (store.state.playback.isPlaying) return playFrom(secondsBack);
    return prepare(secondsBack);
  }

  /** Продолжает приостановленный буфер с выбранного места. */
  function resumeBuffer() {
    if (!isEnabled() || !buffered) return false;
    return startBuffer();
  }

  function pauseBuffer() {
    if (!buffered) return false;
    bufferPaused = true;
    clearPlaybackTimers();

    // Незавершённое переключение отменяем: продолжение — по Play, с той же
    // абсолютной позиции (данные за паузу никуда не денутся).
    if (pendingEl) {
      const pending = pendingEl;
      pendingEl = null;
      releaseElement(pending);
    }

    cursor = positionOfActive();
    if (activeEl) {
      try { activeEl.pause(); } catch (error) { /* noop */ }
    }
    emit();
    return true;
  }

  function isBufferPlaying() {
    return Boolean(buffered && !bufferPaused && activeEl && !activeEl.paused && !activeEl.ended);
  }

  function stopBuffer() {
    resetPlayback();
    buffered = false;
    bufferPaused = false;
    cursor = 0;

    // Возвращаем звук живого эфира (он всё это время продолжал играть беззвучно).
    MR.audio.setBufferSilent(false);
  }

  function returnLive() {
    stopBuffer();
    emit();
    return true;
  }

  function reset() {
    stopCapture();
    chunks = [];
    totalSamples = 0;
    stopBuffer();
    activeStationId = null;
    emit();
  }

  function onPlayback(payload) {
    const playback = payload || store.state.playback;

    if (!isEnabled()) {
      if (capturing || buffered || chunks.length || activeStationId) reset();
      return;
    }

    // Остановка (stop) — единственный статус, который сбрасывает буфер.
    if (playback.status === "idle") {
      if (capturing || buffered || chunks.length || activeStationId) reset();
      return;
    }

    if (activeStationId !== playback.stationId) {
      reset();
      activeStationId = playback.stationId || null;
    }

    if (playback.status === "paused") {
      // Пауза не стирает данные: останавливаем звучащий буфер и перестаём
      // писать тишину, но позиция и содержимое остаются доступными.
      pauseBuffer();
      stopCapture();
      emit();
      return;
    }

    if (buffered) {
      // Временные статусы живого потока (connecting/buffering/error) не должны
      // выбивать из буфера: эфир заглушён, запись продолжается.
      MR.audio.setBufferSilent(true);
      if (playback.isPlaying) {
        ensureTap();
        if (bufferPaused) {
          resumeBuffer();
        } else if (activeEl && activeEl.ended && !pendingEl) {
          // Пока эфир переподключался, сегмент доиграл — продолжаем ленту.
          startNextSegment();
        }
      }
      return;
    }

    if (!playback.isPlaying) return;
    ensureTap();
  }

  function onUiChange() {
    if (!isEnabled()) {
      reset();
      MR.audio.setBufferSilent(false);
      emit();
      return;
    }

    // Переключились в compat-режим: старый tap уже мёртв (контекст закрыт),
    // поэтому освобождаем PCM, а не показываем замерший буфер.
    if (store.state.ui.compatMode) {
      if (capturing || buffered || chunks.length) {
        reset();
        MR.audio.setBufferSilent(false);
        emit();
      }
      return;
    }

    trimChunks();

    const available = availableSeconds();
    const position = positionOfActive();
    const first = chunks.length ? chunks[0].start : 0;

    if (buffered && (position < first || segmentEnd <= first)) {
      // Буфер сократили — выбранная позиция стала недоступна.
      returnLive();
      return;
    }

    if (buffered && (totalSamples - position) / TARGET_RATE > Math.max(1, available - 0.3)) {
      // Окно сузилось настолько, что записанные для буфера секунды обрезаны.
      returnLive();
      return;
    }

    // Буфер только что включили во время игры — начинаем писать сразу.
    if (!capturing && !tap && store.state.playback.isPlaying) {
      activeStationId = store.state.playback.stationId || null;
      ensureTap();
    }

    emit();
  }

  function init() {
    store.on("playback", onPlayback);
    store.on("volume", applyBufferVolume);
    store.on("ui", onUiChange);

    emitTimer = setInterval(function () {
      if ((capturing && isEnabled()) || buffered) emit();
    }, 1000);

    onPlayback();
  }

  function dispose() {
    if (emitTimer) clearInterval(emitTimer);
    emitTimer = null;
    reset();
    activeEl = null;
    spareEl = null;
  }

  MR.timemachine = {
    init: init,
    dispose: dispose,
    availableSeconds: availableSeconds,
    prepare: prepare,
    playFrom: playFrom,
    seek: seek,
    resume: resumeBuffer,
    resumeBuffer: resumeBuffer,
    returnLive: returnLive,
    getRewind: function () {
      if (!buffered) return 0;
      const position = positionOfActive();
      cursor = position;
      return Math.max(0, (totalSamples - position) / TARGET_RATE);
    },
    isBuffered: function () { return buffered; },
    isCapturing: function () { return capturing; },
    isEnabled: isEnabled,
    isBufferPlaying: isBufferPlaying,
    maxSeconds: maxSeconds,
  };
})(window);
