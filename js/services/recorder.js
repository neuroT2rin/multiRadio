/**
 * services/recorder.js — запись текущего эфира в файл через MediaRecorder.
 *
 * Записываем звук после анализатора (с эквалайзером), поэтому файл совпадает
 * с тем, что слышно. Это личная копия эфира: приложение не загружает её
 * никуда и не хранит после скачивания.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const store = MR.store;

  const MAX_MS = 60 * 60 * 1000;
  const MIME_CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let mimeType = "";
  let stationSlug = "radio";
  let limitTimer = null;

  function supported() {
    return typeof global.MediaRecorder === "function";
  }

  function pickMime() {
    if (!supported() || typeof MediaRecorder.isTypeSupported !== "function") return "";
    for (let i = 0; i < MIME_CANDIDATES.length; i += 1) {
      if (MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
    }
    return "";
  }

  function extensionFor(type) {
    if (type.indexOf("ogg") !== -1) return "ogg";
    if (type.indexOf("mp4") !== -1) return "m4a";
    return "webm";
  }

  function stamp(date) {
    const pad = function (value) { return value < 10 ? "0" + value : String(value); };
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
      "-" + pad(date.getHours()) + pad(date.getMinutes());
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
  }

  function cleanup() {
    if (limitTimer) clearInterval(limitTimer);
    limitTimer = null;
    recorder = null;
    startedAt = 0;
    chunks = [];
    store.emit("record");
  }

  function finish() {
    const type = mimeType || "audio/webm";
    const blob = new Blob(chunks, { type: type });
    const seconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    const filename = "multiradio-" + stationSlug + "-" + stamp(new Date()) +
      "." + extensionFor(type);

    cleanup();

    if (!blob.size) {
      store.emit("notice", {
        level: "warning",
        message: "Запись пустая — похоже, поток не отдавал звук.",
      });
      return;
    }

    download(blob, filename);
    store.emit("notice", {
      level: "success",
      message: "Запись сохранена (" + seconds + " с): " + filename,
    });
  }

  function start() {
    if (recorder) return false;

    if (!supported()) {
      store.emit("notice", {
        level: "warning",
        message: "Браузер не поддерживает запись звука (MediaRecorder).",
      });
      return false;
    }

    if (!store.state.playback.isPlaying) {
      store.emit("notice", {
        level: "warning",
        message: "Сначала включите радио — записывать пока нечего.",
      });
      return false;
    }

    const stream = MR.audio.getCaptureStream();
    if (!stream) {
      store.emit("notice", {
        level: "error",
        message: "Запись недоступна: поток без CORS или Web Audio отключён.",
      });
      return false;
    }

    mimeType = pickMime();

    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
    } catch (error) {
      store.emit("notice", {
        level: "error",
        message: "Не удалось начать запись: " + (error.message || error),
      });
      recorder = null;
      return false;
    }

    chunks = [];
    startedAt = Date.now();
    const station = store.getCurrentStation();
    stationSlug = station ? String(station.id).replace(/[^a-z0-9-]/gi, "") : "radio";

    recorder.addEventListener("dataavailable", function (event) {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", finish);

    try {
      recorder.start(1000);
    } catch (error) {
      recorder = null;
      store.emit("notice", { level: "error", message: "Не удалось начать запись." });
      return false;
    }

    limitTimer = setInterval(function () {
      if (startedAt && Date.now() - startedAt >= MAX_MS) {
        stop();
      }
    }, 5000);

    store.emit("notice", {
      level: "success",
      message: "Запись эфира началась. Это личная копия — не распространяйте её.",
    });
    store.emit("record");
    return true;
  }

  function stop() {
    if (!recorder) return false;
    try {
      recorder.stop();
    } catch (error) {
      cleanup();
    }
    return true;
  }

  function dispose() {
    if (recorder) {
      try {
        recorder.onstop = null;
        recorder.stop();
      } catch (error) {
        /* уже остановлена */
      }
    }
    cleanup();
  }

  MR.recorder = {
    start: start,
    stop: stop,
    dispose: dispose,
    supported: supported,
    isRecording: function () { return Boolean(recorder); },
    elapsedMs: function () { return startedAt ? Date.now() - startedAt : 0; },
  };
})(window);
