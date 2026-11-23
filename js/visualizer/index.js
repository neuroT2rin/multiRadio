/**
 * visualizer/index.js — единый цикл отрисовки.
 *
 * Один requestAnimationFrame обслуживает мини-спектр, фоновую визуализацию
 * и индикаторы эквалайзера. Данные анализатора читаются один раз за кадр.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  let rafId = null;
  let lastTs = 0;
  let lastBgAt = 0;
  let lastEqAt = 0;
  let lastMiniHint = "";
  let lastHint = "";
  let miniNeedsIdle = true;
  let bgEnabled = true;
  let reducedMotion = false;

  const VISUALIZER_HINTS = {
    compat: "Режим совместимости: Web Audio отключён, спектр недоступен. Звук при этом работает.",
    off: "Фон выключен. Включите его переключателем ниже.",
    silent: "Поток играет, но браузер не отдаёт данные спектра (обычно из-за CORS).",
    idle: "Фон оживает при воспроизведении. Реагирует на громкость, бас и удары.",
  };

  function setHint(next) {
    if (next === lastHint) return;
    lastHint = next;
    dom.setText("#visualizer-hint", next);
  }

  function setMiniHint(next) {
    if (next === lastMiniHint) return;
    lastMiniHint = next;
    dom.setText("#mini-hint", next);
  }

  function updateHints(analysis, playing) {
    const compat = store.state.ui.compatMode;

    if (compat) {
      setHint(VISUALIZER_HINTS.compat);
      setMiniHint("режим совместимости · без спектра");
      return;
    }

    if (analysis && analysis.silent) {
      setHint(VISUALIZER_HINTS.silent);
      setMiniHint("нет данных спектра (CORS)");
      return;
    }

    setMiniHint("визуализация потока");

    if (!bgEnabled) setHint(VISUALIZER_HINTS.off);
    else if (!playing) setHint(VISUALIZER_HINTS.idle);
    else setHint("Живой спектр: полосы, волна и удары в реальном времени.");
  }

  function frame(ts) {
    rafId = requestAnimationFrame(frame);

    if (!lastTs) lastTs = ts;
    const dt = Math.min(80, ts - lastTs);
    lastTs = ts;

    const analysis = MR.analyser.read(ts);
    const playing = Boolean(store.state.playback.isPlaying);

    if (playing) {
      MR.mini.draw(analysis);
      miniNeedsIdle = true;
    } else if (miniNeedsIdle) {
      MR.mini.drawIdle();
      miniNeedsIdle = false;
    }

    if (ts - lastEqAt > 50) {
      MR.eqUI.tick(analysis);
      lastEqAt = ts;
    }

    if (bgEnabled) {
      const bgInterval = playing ? 33 : 110;
      if (ts - lastBgAt >= bgInterval) {
        MR.bg.draw(analysis, lastBgAt ? ts - lastBgAt : 16, ts);
        lastBgAt = ts;
      }
    }

    updateHints(analysis, playing);
  }

  function applyUi() {
    const ui = store.state.ui;
    bgEnabled = Boolean(ui.bgEnabled);

    const container = dom.$("#bg-visualizer");
    if (container) container.classList.toggle("is-hidden", !bgEnabled);

    MR.bg.setMode(ui.mode);

    dom.$$(".segmented__btn").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === ui.mode));
    });

    const toggle = dom.$("#bg-toggle");
    if (toggle) toggle.setAttribute("aria-pressed", String(bgEnabled));

    if (reducedMotion) {
      // При включённом «уменьшении движения» рисуем один статичный кадр.
      if (bgEnabled) MR.bg.draw(null, 0, 4000);
      MR.mini.drawIdle();
    } else if (bgEnabled) {
      lastBgAt = 0;
    }

    updateHints(null, false);

    const modeSelect = dom.$("#setting-mode");
    if (modeSelect) modeSelect.value = store.state.ui.mode;
  }

  function onPlayback() {
    if (!store.state.playback.isPlaying) {
      miniNeedsIdle = true;
      lastBgAt = 0;
    } else {
      lastTs = 0;
    }
    updateHints(null, store.state.playback.isPlaying);
  }

  function init() {
    reducedMotion = MR.utils.prefersReducedMotion();

    MR.mini.init();
    MR.bg.init();

    MR.commands.registerMany({
      "ui:toggle-bg": function () {
        store.toggleBg();
      },
      "ui:mode": function (payload) {
        const mode = payload && payload.dataset ? payload.dataset.mode : "";
        if (mode) store.setVisualizerMode(mode);
      },
    });

    store.on("ui", applyUi);
    store.on("playback", onPlayback);

    applyUi();
    MR.mini.drawIdle();

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        lastTs = 0;
        lastBgAt = 0;
      }
    });

    if (!reducedMotion) {
      rafId = requestAnimationFrame(frame);
    }
  }

  function dispose() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    MR.mini.dispose();
  }

  MR.visualizer = {
    init: init,
    dispose: dispose,
  };
})(window);
