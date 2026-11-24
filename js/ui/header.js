/**
 * ui/header.js — статус сети, статус плеера и полоса проверки станций.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;

  const NETWORK_STATES = {
    checking: { text: "Сеть: проверка…", state: "pending" },
    online: { text: "Сеть: онлайн", state: "online" },
    restricted: { text: "Сеть: ограничена", state: "restricted" },
    offline: { text: "Сеть: офлайн", state: "offline" },
  };

  const PLAYBACK_STATES = {
    idle: "Готов к запуску",
    connecting: "Подключение…",
    buffering: "Буферизация…",
    playing: "Играет",
    paused: "Пауза",
    error: "Ошибка потока",
    blocked: "Нужен клик",
  };

  const BASE_TITLE = "MultiRadio — многофункциональное интернет-радио";
  let hideTimer = null;

  function renderNetwork(network) {
    const badge = dom.$("#network-badge");
    if (!badge) return;

    const current = network || store.state.network || {};
    const state = NETWORK_STATES[current.status] || NETWORK_STATES.checking;
    dom.setText("#network-badge-text", state.text);
    badge.dataset.state = state.state;

    const details = [];
    if (current.effectiveType) details.push("тип: " + current.effectiveType.toUpperCase());
    if (typeof current.downlink === "number") details.push("≈" + current.downlink + " Мбит/с");
    if (current.status === "restricted") details.push("возможен VPN или фильтр");
    badge.title = details.length ? details.join(" · ") : "Состояние сети";
  }

  function updateTitle(playback) {
    const station = store.getCurrentStation();
    if (station && (playback.status === "playing" || playback.status === "buffering" || playback.status === "paused")) {
      const icon = playback.status === "paused" ? "⏸" : "▶";
      document.title = icon + " " + station.name + " — MultiRadio";
    } else {
      document.title = BASE_TITLE;
    }
  }

  function renderPlayback(playback) {
    const badge = dom.$("#stream-status");
    if (!badge) return;

    const current = playback || store.state.playback;
    const label = PLAYBACK_STATES[current.status] || PLAYBACK_STATES.idle;
    badge.textContent = label;
    badge.dataset.state = current.status;
    badge.title = current.error ? "Ошибка: " + current.error : label;

    updateTitle(current);
  }

  function renderProgress(progress) {
    const container = dom.$("#health-progress");
    const fill = dom.$("#health-progress-fill");
    const label = dom.$("#health-progress-label");
    if (!container || !fill || !label) return;

    // emitAll() приходит без payload — берём текущий прогресс из стора.
    progress = progress || store.state.healthProgress;

    const total = progress.total || 0;
    const done = utils.clamp(progress.done || 0, 0, total || 0);
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;

    if (progress.running) {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }

      if (container.hidden) {
        container.hidden = false;
        requestAnimationFrame(function () { container.classList.add("is-active"); });
      } else {
        container.classList.add("is-active");
      }

      fill.style.width = percent + "%";
      container.setAttribute("aria-valuenow", String(percent));

      const stationsDone = progress.stationsDone || 0;
      const stationsTotal = progress.stationsTotal || 0;
      const text = "Проверка станций · " + stationsDone + "/" + stationsTotal;
      label.textContent = text;
      container.setAttribute("aria-valuetext", text + ", источников " + done + " из " + total);
      return;
    }

    if (!progress.finishedAt) return;

    fill.style.width = "100%";
    container.setAttribute("aria-valuenow", "100");

    const summary = store.getHealthSummary();
    const text = "Проверено " + progress.stationsTotal + " " +
      utils.pluralRu(progress.stationsTotal, "station") + " · " +
      summary.online + " онлайн";
    label.textContent = text;
    container.setAttribute("aria-valuetext", text);

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (store.state.healthProgress.running) return;
      container.classList.remove("is-active");
      setTimeout(function () {
        if (!store.state.healthProgress.running) container.hidden = true;
      }, 320);
    }, 1500);
  }

  function init() {
    store.on("network", renderNetwork);
    store.on("playback", renderPlayback);
    store.on("stations", function () { updateTitle(store.state.playback); });
    store.on("health:progress", renderProgress);

    renderNetwork(store.state.network);
    renderPlayback(store.state.playback);
    renderProgress(store.state.healthProgress);
  }

  MR.headerUI = {
    init: init,
  };
})(window);
