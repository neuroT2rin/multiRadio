/**
 * services/recorder.js — запись текущего эфира через MediaRecorder.
 *
 * Записываем звук после анализатора (с эквалайзером), поэтому файл совпадает
 * с тем, что слышно. Это личная копия эфира: она уходит в локальный архив
 * (`MR.recordings`), никуда не загружается и не скачивается автоматически —
 * скачать файл можно вручную во вкладке «Записи».
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
  let station = { id: "", name: "" };
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

  function cleanup() {
    if (limitTimer) clearInterval(limitTimer);
    limitTimer = null;
    recorder = null;
    startedAt = 0;
    chunks = [];
    station = { id: "", name: "" };
    store.emit("record");
  }

  function finish() {
    const type = mimeType || "audio/webm";
    const blob = new Blob(chunks, { type: type });
    const durationMs = startedAt ? Date.now() - startedAt : 0;
    const current = store.getCurrentStation();
    const stationId = station.id || (current ? String(current.id) : "");
    const stationName = station.name || (current ? String(current.name) : "Радио");

    cleanup();

    if (!blob.size) {
      store.emit("notice", {
        level: "warning",
        message: "Запись пустая — похоже, поток не отдавал звук.",
      });
      return;
    }

    const entry = {
      id: MR.utils.uid("rec"),
      stationId: stationId,
      stationName: stationName,
      createdAt: Date.now(),
      durationMs: durationMs,
      mimeType: type,
      size: blob.size,
      blob: blob,
    };

    MR.recordings.save(entry).then(function (result) {
      if (result && result.ok) {
        store.emit("notice", {
          level: "success",
          message: "Запись сохранена в архив",
        });
        store.emit("record:saved", result.entry || entry);
        return;
      }

      store.emit("notice", {
        level: "error",
        message: result && result.quota
          ? "Не хватает места в архиве — удалите старые записи во вкладке «Записи»."
          : "Не удалось сохранить запись в архив. Попробуйте ещё раз.",
      });
    }).catch(function () {
      store.emit("notice", {
        level: "error",
        message: "Не удалось сохранить запись в архив. Попробуйте ещё раз.",
      });
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
    const current = store.getCurrentStation();
    station = {
      id: current ? String(current.id) : "",
      name: current ? String(current.name) : "Радио",
    };

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
