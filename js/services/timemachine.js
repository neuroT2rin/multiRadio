/**
 * services/timemachine.js — «машина времени» эфира.
 *
 * В памяти держится последние несколько минут звука в моно-PCM (16 кГц):
 * это ~11 МБ на 3 минуты и позволяет точно отмотать назад. Перемотка строит
 * WAV из выбранного места и проигрывает его отдельным <audio>, живой поток
 * ставится на паузу; кнопка LIVE возвращает к эфиру.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const store = MR.store;
  const utils = MR.utils;

  const TARGET_RATE = 16000;
  const MAX_SECONDS = 180;

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

  function availableSeconds() {
    if (!chunks.length) return 0;
    return (totalSamples - chunks[0].start) / TARGET_RATE;
  }

  function appendSamples(mono) {
    chunks.push({ start: totalSamples, data: mono });
    totalSamples += mono.length;

    const minSamples = MAX_SECONDS * TARGET_RATE;
    while (chunks.length > 1 && totalSamples - chunks[0].start > minSamples) {
      chunks.shift();
    }
  }

  function handleSamples(left, right, rate) {
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

  function playFrom(secondsBack) {
    const available = availableSeconds();
    if (available < 2) return false;

    const clamped = utils.clamp(secondsBack, 1, available - 0.3);
    const startSample = Math.max(
      chunks[0].start,
      totalSamples - Math.floor(clamped * TARGET_RATE)
    );
    const samples = collectFrom(startSample);
    if (!samples.length) return false;

    const blob = encodeWav(samples, TARGET_RATE);

    if (bufferUrl) URL.revokeObjectURL(bufferUrl);
    bufferUrl = URL.createObjectURL(blob);

    if (!bufferEl) {
      bufferEl = new Audio();
      bufferEl.addEventListener("ended", function () {
        if (buffered) returnLive();
      });
    }

    bufferEl.src = bufferUrl;
    bufferPosition = clamped;
    buffered = true;

    // Живой эфир не ставим на паузу — только глушим, чтобы буфер продолжал
    // писаться, а в плеере не появлялось состояние «Пауза».
    MR.audio.setBufferSilent(true);

    const promise = bufferEl.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch(function () {
        stopBuffer();
        emit();
      });
    }

    emit();
    return true;
  }

  function reset(clearStation) {
    if (tap) tap.disconnect();
    tap = null;
    capturing = false;
    chunks = [];
    totalSamples = 0;
    resamplePhase = 0;
    stopBuffer();
    if (clearStation) activeStationId = null;
    emit();
  }

  function onPlayback() {
    const playback = store.state.playback;

    // Пока играет буфер, обычные события воспроизведения игнорируем: живой
    // эфир продолжает идти беззвучно. Выходим из буфера только при смене
    // станции или ручной остановке.
    if (buffered) {
      if (!playback.isPlaying || playback.stationId !== activeStationId) {
        stopBuffer();
      } else {
        return;
      }
    }

    if (!playback.isPlaying) {
      reset(false);
      return;
    }

    if (playback.stationId !== activeStationId) {
      reset(false);
      activeStationId = playback.stationId;
    }

    ensureTap();
  }

  function init() {
    store.on("playback", onPlayback);

    emitTimer = setInterval(function () {
      if (capturing) emit();
    }, 1000);

    onPlayback();
  }

  function dispose() {
    if (emitTimer) clearInterval(emitTimer);
    emitTimer = null;
    reset(true);
    if (bufferEl) {
      bufferEl.pause();
      bufferEl = null;
    }
  }

  MR.timemachine = {
    init: init,
    dispose: dispose,
    availableSeconds: availableSeconds,
    playFrom: playFrom,
    returnLive: returnLive,
    getRewind: function () { return buffered ? bufferPosition : 0; },
    isBuffered: function () { return buffered; },
    isCapturing: function () { return capturing; },
    maxSeconds: MAX_SECONDS,
  };
})(window);
