/**
 * services/timemachine.js — «машина времени» эфира.
 *
 * В памяти держится последние несколько минут звука в моно-PCM (16 кГц):
 * это ~38 МБ на 10 минут и позволяет точно отмотать назад.
 *
 * Воспроизведение буфера — непрерывная лента в общем AudioContext. В
 * PCM-таймлайне хранятся абсолютная позиция прослушивания (cursor) и текущая
 * граница записи (totalSamples). Звук идёт через отдельную шину AudioContext
 * (мимо GainNode и эквалайзера живого эфира), а сегменты планируются заранее:
 * следующий сегмент строится за PREBUILD_LEAD секунд до конца текущего и
 * ставится в график ровно на момент окончания предыдущего. Поэтому стыки
 * получаются без паузы, а на `ended` никто не возвращается в живой эфир.
 * Если новых сэмплов ещё нет, ждём коротким таймером и повторяем: эфир всё
 * это время остаётся заглушённым и продолжает писаться.
 *
 * Запись PCM и воспроизведение буфера живут на одном AudioContext, поэтому
 * позиция не уплывает относительно записанного звука. Пока звучит буфер,
 * транзиентная «буферизация» беззвучного живого эфира не показывается:
 * пользователь слушает буфер, а не эфир.
 *
 * Пауза не стирает данные: звучащий буфер останавливается, позиция
 * сохраняется, Play продолжает с того же места. Остановка и смена станции
 * сбрасывают буфер.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const store = MR.store;
  const utils = MR.utils;
  const config = MR.config;

  const TARGET_RATE = 16000;
  /** Запас перед стартом/возобновлением буфера, секунды. */
  const START_LEAD = 0.05;
  /** Минимальный запас, чтобы успеть поставить источник в график. */
  const MIN_START_GAP = 0.02;
  /** За сколько секунд до конца сегмента готовим следующий. */
  const PREBUILD_LEAD = 0.6;
  /** Пауза перед повтором, если записанных сэмплов ещё нет. */
  const CHAIN_RETRY_MS = 150;
  /** Сколько повторов терпим, прежде чем вернуться в эфир. */
  const MAX_CHAIN_WAITS = 100;

  let tap = null;
  let capturing = false;
  let chunks = [];
  let totalSamples = 0;
  let sourceRate = 44100;

  /** Шина AudioContext: { context, gain }. */
  let bus = null;
  /** Запланированные и звучащие сегменты. */
  let scheduled = [];
  /** Сегмент, подготовленный для паузы/перемотки, но ещё не запущенный. */
  let pendingSegment = null;

  /** Абсолютная позиция прослушивания в PCM-таймлайне, в сэмплах. */
  let cursor = 0;
  let lastEndSample = 0;
  let lastEndTime = 0;
  let buffered = false;
  /** Буфер намеренно приостановлен (пауза плеера или пауза эфира). */
  let bufferPaused = false;

  let advanceTimer = null;
  let retryTimer = null;
  let chainWaits = 0;
  let suppressStatus = false;

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
     PCM-таймлайн → AudioBuffer
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

  /** Текущая шина AudioContext (создаётся в audio.js, второй контекст не нужен). */
  function syncBus() {
    const next = MR.audio.getBufferBus ? MR.audio.getBufferBus() : null;
    if (next !== bus) {
      stopScheduled();
      bus = next;
      if (bus) applyBufferVolume();
    }
    return bus;
  }

  /**
   * Строит сегмент для абсолютного интервала. Возвращает фактические границы
   * (они могут быть уже запрошенных, если старые чанки обрезаны).
   */
  function buildSegment(startAbs, endAbs) {
    if (!syncBus()) return null;

    const first = chunks.length ? chunks[0].start : 0;
    const from = Math.max(first, Math.floor(startAbs));
    const to = Math.min(totalSamples, Math.floor(endAbs));
    if (to - from < 1) return null;

    const samples = collectRange(from, to);
    if (!samples.length) return null;

    let buffer;
    try {
      // Буфер сразу в 16 кГц: Web Audio ресемплирует его в частоту контекста.
      buffer = bus.context.createBuffer(1, samples.length, TARGET_RATE);
      buffer.getChannelData(0).set(samples);
    } catch (error) {
      return null;
    }

    return {
      buffer: buffer,
      start: from,
      end: from + samples.length,
    };
  }

  /* ------------------------------------------------------------------------
     Планирование сегментов
     ------------------------------------------------------------------------ */

  function now() {
    return bus ? bus.context.currentTime : 0;
  }

  /** Громкость/mute буфера: своя шина, живой GainNode не затрагивается. */
  function applyBufferVolume() {
    if (!bus) return;
    const volume = Number(store.state.volume);
    const safe = Number.isFinite(volume) ? utils.clamp(volume, 0, 1) : 1;
    const value = store.state.muted ? 0 : safe;
    try {
      bus.gain.gain.setTargetAtTime(value, bus.context.currentTime, 0.02);
    } catch (error) {
      bus.gain.gain.value = value;
    }
  }

  function stopScheduled() {
    scheduled.forEach(function (item) {
      try {
        item.source.onended = null;
        item.source.stop();
      } catch (error) { /* источник уже остановлен */ }
      try { item.source.disconnect(); } catch (error) { /* noop */ }
    });
    scheduled = [];
  }

  /** Ставит сегмент в график на абсолютное время контекста. */
  function startSource(segment, startAt) {
    if (!bus) return null;

    const context = bus.context;
    const source = context.createBufferSource();
    source.buffer = segment.buffer;
    source.connect(bus.gain);

    const when = Math.max(startAt, context.currentTime + MIN_START_GAP);
    try {
      source.start(when);
    } catch (error) {
      try { source.disconnect(); } catch (disconnectError) { /* noop */ }
      return null;
    }

    const item = {
      source: source,
      startAt: when,
      startSample: segment.start,
      endSample: segment.end,
      duration: segment.buffer.duration,
    };
    source.onended = function () { onSourceEnded(item); };
    scheduled.push(item);

    lastEndSample = segment.end;
    lastEndTime = when + segment.buffer.duration;
    return item;
  }

  function clearTimers() {
    if (advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function armAdvance() {
    if (advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    if (!buffered || bufferPaused || !scheduled.length) return;

    const delay = Math.max(0, (lastEndTime - PREBUILD_LEAD - now()) * 1000);
    advanceTimer = setTimeout(function () {
      advanceTimer = null;
      scheduleNextSegment();
    }, delay);
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!buffered || bufferPaused) return;

      // Эфир переподключается — запись ещё не растёт, но буфер не бросаем.
      if (!store.state.playback.isPlaying) {
        scheduleRetry();
        return;
      }

      chainWaits += 1;
      if (chainWaits > MAX_CHAIN_WAITS) {
        // Запись давно не растёт — нет смысла держать эфир заглушённым.
        returnLive();
        return;
      }
      scheduleNextSegment();
    }, CHAIN_RETRY_MS);
  }

  /**
   * Заранее строит продолжение от абсолютной позиции конца последнего
   * сегмента до актуальной границы записи и ставит его ровно на стык.
   */
  function scheduleNextSegment() {
    if (!buffered || bufferPaused) return;
    if (!syncBus()) return;

    const from = lastEndSample;
    const to = totalSamples;
    if (to <= from) {
      scheduleRetry();
      return;
    }

    const segment = buildSegment(from, to);
    if (!segment) {
      scheduleRetry();
      return;
    }

    let startAt = lastEndTime;
    if (!Number.isFinite(startAt) || startAt < now() + MIN_START_GAP) {
      // Не успели поставить заранее — минимальный запас, но без пропуска
      // записанных сэмплов: продолжаем ровно с from.
      startAt = now() + START_LEAD;
    }

    if (!startSource(segment, startAt)) {
      scheduleRetry();
      return;
    }

    chainWaits = 0;
    armAdvance();
  }

  function onSourceEnded(item) {
    const index = scheduled.indexOf(item);
    if (index !== -1) scheduled.splice(index, 1);
    try { item.source.disconnect(); } catch (error) { /* noop */ }

    if (scheduled.length) return;

    // Все запланированные сегменты доиграны: фиксируем позицию и пробуем
    // продолжить, если запись уже успела продвинуться.
    cursor = item.endSample;
    if (buffered && !bufferPaused) scheduleNextSegment();
  }

  /* ------------------------------------------------------------------------
     Позиция прослушивания
     ------------------------------------------------------------------------ */

  function currentPosition() {
    if (!buffered || !scheduled.length) return cursor;

    const time = now();
    for (let i = 0; i < scheduled.length; i += 1) {
      const item = scheduled[i];
      const end = item.startAt + item.duration;
      if (time < item.startAt) return item.startSample;
      if (time < end) {
        const played = Math.round((time - item.startAt) * TARGET_RATE);
        return Math.min(item.endSample, item.startSample + played);
      }
    }

    const last = scheduled[scheduled.length - 1];
    return last.endSample;
  }

  /* ------------------------------------------------------------------------
     Публичное управление
     ------------------------------------------------------------------------ */

  /**
   * Готовит буфер с выбранной позиции, но не запускает его. Живой эфир при
   * этом глушится, данные и позиция остаются в памяти.
   */
  function prepare(secondsBack) {
    if (!isEnabled()) return false;
    if (!syncBus()) return false;

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

    clearTimers();
    stopScheduled();

    cursor = segment.start;
    lastEndSample = segment.start;
    lastEndTime = 0;
    pendingSegment = segment;
    buffered = true;
    // На паузе эфира буфер только готовится: звук продолжит Play.
    bufferPaused = !store.state.playback.isPlaying;
    chainWaits = 0;

    // Живой эфир не ставим на паузу — только глушим, чтобы буфер продолжал
    // писаться, а в плеере не появлялось состояние «Пауза».
    MR.audio.setBufferSilent(true);
    applyBufferVolume();

    emit();
    return true;
  }

  /** Запускает подготовленный (или приостановленный) буфер. */
  function startBuffer() {
    if (!isEnabled() || !buffered) return false;
    if (!syncBus()) return false;

    bufferPaused = false;
    applyBufferVolume();

    if (scheduled.length) {
      armAdvance();
      emit();
      return true;
    }

    let segment = pendingSegment;
    pendingSegment = null;
    if (!segment) {
      const first = chunks.length ? chunks[0].start : 0;
      segment = buildSegment(Math.max(cursor, first), totalSamples);
      if (!segment) return false;
    }

    if (!startSource(segment, now() + START_LEAD)) return false;

    cursor = segment.start;
    armAdvance();
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
    cursor = currentPosition();
    clearTimers();
    stopScheduled();
    pendingSegment = null;
    emit();
    return true;
  }

  function isBufferPlaying() {
    return Boolean(buffered && !bufferPaused && scheduled.length > 0);
  }

  function stopBuffer() {
    clearTimers();
    stopScheduled();

    pendingSegment = null;
    buffered = false;
    bufferPaused = false;
    cursor = 0;
    lastEndSample = 0;
    lastEndTime = 0;
    chainWaits = 0;

    if (bus) {
      try { bus.gain.gain.value = 0; } catch (error) { /* noop */ }
    }

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

  /**
   * Пока звучит буфер, транзиентная буферизация беззвучного эфира не должна
   * выглядеть как прерывание: пользователь слушает запись, а не поток.
   */
  function quietLiveBuffering(playback) {
    if (suppressStatus || !buffered || bufferPaused) return;
    if (playback.status !== "buffering" || !playback.isPlaying) return;
    if (!scheduled.length) return;

    suppressStatus = true;
    try {
      store.setPlayback({ status: "playing" });
    } finally {
      suppressStatus = false;
    }
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
      quietLiveBuffering(playback);

      if (playback.isPlaying) {
        ensureTap();
        if (bufferPaused) {
          resumeBuffer();
        } else if (!scheduled.length) {
          scheduleNextSegment();
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
    const position = currentPosition();
    const first = chunks.length ? chunks[0].start : 0;

    if (buffered && (position < first || lastEndSample <= first)) {
      // Буфер сократили — выбранная позиция стала недоступна.
      returnLive();
      return;
    }

    if (buffered && (totalSamples - position) / TARGET_RATE > Math.max(1, available - 0.3) + 0.001) {
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
    bus = null;
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
      const position = currentPosition();
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
