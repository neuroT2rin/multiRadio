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
  let miniNeedsIdle = true;
  let bgEnabled = true;
  let vizMode = false;
  let reducedMotion = false;
  let savedScroll = 0;

  const MINI_HINTS = {
    compat: "режим совместимости · без спектра",
    silent: "нет данных спектра (CORS)",
    idle: "визуализация потока",
  };

  function setMiniHint(next) {
    if (next === lastMiniHint) return;
    lastMiniHint = next;
    dom.setText("#mini-hint", next);
  }

  function updateHints(analysis) {
    const compat = store.state.ui.compatMode;

    if (compat) {
      setMiniHint(MINI_HINTS.compat);
      return;
    }

    if (analysis && analysis.silent) {
      setMiniHint(MINI_HINTS.silent);
      return;
    }

    setMiniHint(MINI_HINTS.idle);
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

    if (bgEnabled || vizMode) {
      const bgInterval = playing ? 33 : vizMode ? 60 : 110;
      if (ts - lastBgAt >= bgInterval) {
        MR.bg.draw(analysis, lastBgAt ? ts - lastBgAt : 16, ts);
        lastBgAt = ts;
      }
    }

    updateHints(analysis);
  }

  function showBackground() {
    return bgEnabled || vizMode;
  }

  function applyUi() {
    const ui = store.state.ui;
    bgEnabled = Boolean(ui.bgEnabled);

    const container = dom.$("#bg-visualizer");
    if (container) container.classList.toggle("is-hidden", !showBackground());

    MR.bg.setMode(ui.mode);
    MR.mini.setMode(ui.miniMode);

    if (reducedMotion) {
      // При включённом «уменьшении движения» рисуем один статичный кадр.
      if (showBackground()) MR.bg.draw(null, 0, 4000);
      MR.mini.drawIdle();
    } else if (showBackground()) {
      lastBgAt = 0;
    }

    updateHints(null);

    const modeSelect = dom.$("#setting-mode");
    if (modeSelect) modeSelect.value = store.state.ui.mode;
  }

  function setVizMode(next) {
    const willEnable = Boolean(next);

    if (willEnable === vizMode) return;

    vizMode = willEnable;
    document.body.classList.toggle("is-viz-mode", vizMode);

    const toggle = dom.$("#viz-toggle");
    if (toggle) toggle.setAttribute("aria-pressed", String(vizMode));
    if (toggle) toggle.title = vizMode ? "Выйти из режима визуализации (Esc)" : "Режим визуализации (V)";

    if (vizMode) {
      savedScroll = global.scrollY || 0;
      lastBgAt = 0;
    }

    if (MR.navUI) MR.navUI.closeAll();

    applyUi();

    if (!vizMode) {
      // Возвращаем пользователя туда, где он был до входа в режим.
      requestAnimationFrame(function () {
        global.scrollTo(0, savedScroll);
      });
    }
  }

  function onPlayback() {
    if (!store.state.playback.isPlaying) {
      miniNeedsIdle = true;
      lastBgAt = 0;
    } else {
      lastTs = 0;
    }
    updateHints(null);
  }

  function isTypingTarget(target) {
    if (!target) return false;
    return target.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "");
  }

  function isOverlayOpen() {
    if (MR.modal && MR.modal.hasOpen) return true;
    const header = dom.$("#app-header");
    return Boolean(
      (header && header.classList.contains("is-nav-open")) ||
      document.querySelector(".nav-group.is-open")
    );
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      if (!vizMode || isOverlayOpen()) return;
      setVizMode(false);
      return;
    }

    if (
      (event.key === "v" || event.key === "V" || event.key === "м" || event.key === "М") &&
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      !isTypingTarget(event.target)
    ) {
      setVizMode(!vizMode);
    }
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
      "ui:viz-mode": function () {
        setVizMode(!vizMode);
      },
      "ui:mini-mode": function (payload) {
        const miniMode = payload && payload.dataset ? payload.dataset.miniMode : "";
        if (miniMode) store.setMiniMode(miniMode);
      },
    });

    store.on("ui", applyUi);
    store.on("playback", onPlayback);

    applyUi();
    MR.mini.drawIdle();

    // capture: срабатываем раньше меню и модалок, чтобы не выйти из режима
    // одним Esc вместе с закрытием меню.
    document.addEventListener("keydown", onKeydown, true);

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
    document.removeEventListener("keydown", onKeydown, true);
    MR.mini.dispose();
  }

  MR.visualizer = {
    init: init,
    dispose: dispose,
    setVizMode: setVizMode,
    isVizMode: function () { return vizMode; },
  };
})(window);
