/**
 * ui/sleep-timer.js — таймер сна: останавливает радио через заданное время.
 * Кнопка с оставшимся временем живёт в шапке, меню — обычный nav-group.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  let button = null;
  let label = null;
  let endAt = 0;
  let timerId = null;

  function formatLeft(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = function (value) { return value < 10 ? "0" + value : String(value); };
    return hours > 0
      ? hours + ":" + pad(minutes) + ":" + pad(seconds)
      : pad(minutes) + ":" + pad(seconds);
  }

  function render() {
    if (!button || !label) return;

    if (!endAt) {
      label.textContent = "Таймер";
      button.classList.remove("is-active");
      button.title = "Таймер сна: остановить радио через заданное время";
      button.setAttribute("aria-label", "Таймер сна");
      return;
    }

    const left = endAt - Date.now();
    label.textContent = formatLeft(left);
    button.classList.add("is-active");
    button.title = "До остановки радио: " + formatLeft(left) + ". Нажмите, чтобы изменить.";
    button.setAttribute("aria-label", "Таймер сна, осталось " + formatLeft(left));
  }

  function clear() {
    if (timerId) clearInterval(timerId);
    timerId = null;
    endAt = 0;
    render();
  }

  function fire() {
    const wasActive = Boolean(endAt);
    clear();
    if (!wasActive) return;

    if (store.state.playback.isPlaying || store.state.playback.stationId) {
      MR.audio.stop();
    }
    store.emit("notice", {
      level: "success",
      message: "Таймер сна: воспроизведение остановлено.",
    });
  }

  function start(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) return;

    endAt = Date.now() + value * 60000;
    if (timerId) clearInterval(timerId);
    timerId = setInterval(function () {
      render();
      if (Date.now() >= endAt) fire();
    }, 1000);
    render();

    store.emit("notice", {
      level: "info",
      message: "Таймер сна: радио остановится через " + value + " мин.",
    });
  }

  function cancel() {
    if (!endAt) return;
    clear();
    store.emit("notice", { level: "info", message: "Таймер сна отменён." });
  }

  function init() {
    button = dom.$("#sleep-timer");
    label = dom.$("#sleep-timer-label");
    if (!button) return;

    MR.commands.registerMany({
      "timer:start": function (payload) {
        const minutes = payload && payload.dataset ? payload.dataset.minutes : "";
        start(minutes);
      },
      "timer:cancel": cancel,
    });

    render();
  }

  function dispose() {
    if (timerId) clearInterval(timerId);
    timerId = null;
  }

  MR.sleepTimer = {
    init: init,
    dispose: dispose,
    start: start,
    cancel: cancel,
    get remainingMs() { return endAt ? Math.max(0, endAt - Date.now()) : 0; },
  };
})(window);
