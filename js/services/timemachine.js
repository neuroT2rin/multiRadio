/**
 * services/timemachine.js — «машина времени» эфира.
 *
 * В памяти держится последние несколько минут звука в моно-PCM (16 кГц):
 * это ~38 МБ на 10 минут и позволяет точно отмотать назад. Перемотка строит
 * WAV из выбранного места и проигрывает его отдельным <audio>, живой поток
 * не ставится на паузу, а глушится, чтобы буфер продолжал писаться.
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

  let tap = null;
  let capturing = false;
  let chunks = [];
  let totalSamples = 0;
  let sourceRate = 44100;
  let resamplePhase = 0;

  let bufferEl = null;
  let bufferUrl = "";
  let buffered = false;
  let bufferPosition = 0;
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

  function collectFrom(absStart) {
    const parts = [];
    chunks.forEach(function (chunk) {
      const end = chunk.start + chunk.data.length;
      if (end <= absStart) return;
      const from = Math.max(0, absStart - chunk.start);
      parts.push(chunk.data.subarray(from));
    });

    const total = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
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
   * Буфер не проходит через GainNode живого эфира, поэтому громкость и mute
   * выставляются прямо элементу.
   */
  function applyBufferVolume() {
    if (!bufferEl) return;
    const volume = Number(store.state.volume);
    const safe = Number.isFinite(volume) ? utils.clamp(volume, 0, 1) : 1;
    bufferEl.volume = store.state.muted ? 0 : safe;
  }

  function ensureBufferElement() {
    if (bufferEl) return;
    bufferEl = new Audio();
    bufferEl.addEventListener("ended", function () {
      if (buffered) returnLive();
    });
  }

  function stopBuffer() {
    if (bufferEl) {
      try { bufferEl.pause(); } catch (error) { /* noop */ }
      bufferEl.removeAttribute("src");
      try { bufferEl.load(); } catch (error) { /* noop */ }
    }
    if (bufferUrl) {
      URL.revokeObjectURL(bufferUrl);
      bufferUrl = "";
    }
    buffered = false;
    bufferPosition = 0;
    // Возвращаем звук живого эфира (он всё это время продолжал играть беззвучно).
    MR.audio.setBufferSilent(false);
  }

  function returnLive() {
    stopBuffer();
    emit();
    return true;
  }

  /**
   * Готовит WAV с выбранной позиции и назначает его буферному элементу,
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
    const samples = collectFrom(startSample);
    if (!samples.length) return false;

    const blob = encodeWav(samples, TARGET_RATE);

    if (bufferUrl) URL.revokeObjectURL(bufferUrl);
    bufferUrl = URL.createObjectURL(blob);

    ensureBufferElement();
    bufferEl.src = bufferUrl;
    bufferPosition = clamped;
    buffered = true;

    // Живой эфир не ставим на паузу — только глушим, чтобы буфер продолжал
    // писаться, а в плеере не появлялось состояние «Пауза».
    MR.audio.setBufferSilent(true);
    applyBufferVolume();

    emit();
    return true;
  }

  /** Запускает уже подготовленный (или приостановленный) буфер. */
  function startBuffer() {
    if (!isEnabled() || !buffered || !bufferEl) return false;
    if (!bufferEl.paused) return true;

    applyBufferVolume();

    const promise = bufferEl.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch(function () {
        // Автозапуск запрещён или источник недоступен: возвращаемся к эфиру,
        // данные буфера при этом остаются в памяти.
        if (buffered) returnLive();
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
    if (!bufferEl || !buffered) return false;
    try { bufferEl.pause(); } catch (error) { /* noop */ }
    emit();
    return true;
  }

  function isBufferPlaying() {
    return Boolean(buffered && bufferEl && !bufferEl.paused && !bufferEl.ended);
  }

  function reset() {
    stopCapture();
    chunks = [];
    totalSamples = 0;
    resamplePhase = 0;
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
        if (bufferEl && bufferEl.paused) resumeBuffer();
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
    if (buffered && bufferPosition > Math.max(1, available - 0.3)) {
      // Буфер сократили — выбранная позиция стала недоступна.
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
      if (capturing && isEnabled()) emit();
    }, 1000);

    onPlayback();
  }

  function dispose() {
    if (emitTimer) clearInterval(emitTimer);
    emitTimer = null;
    reset();
    if (bufferEl) {
      try { bufferEl.pause(); } catch (error) { /* noop */ }
      bufferEl = null;
    }
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
    getRewind: function () { return buffered ? bufferPosition : 0; },
    isBuffered: function () { return buffered; },
    isCapturing: function () { return capturing; },
    isEnabled: isEnabled,
    isBufferPlaying: isBufferPlaying,
    maxSeconds: maxSeconds,
  };
})(window);
