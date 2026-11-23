/**
 * ui/info.js — карточка «Источники и сеть» и кнопка ручной проверки.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;
  const config = MR.config;

  const NETWORK_LABELS = {
    checking: "проверка…",
    online: "онлайн",
    restricted: "ограничена (возможен VPN или фильтр)",
    offline: "офлайн",
  };

  let timer = null;

  function renderNetwork() {
    const network = store.state.network;
    const type = network.effectiveType ? network.effectiveType.toUpperCase() : "неизвестно";
    const downlink = typeof network.downlink === "number" ? " · ≈" + network.downlink + " Мбит/с" : "";

    dom.setText("#info-connection", type + downlink);
    dom.setText("#info-connection-state", NETWORK_LABELS[network.status] || "—");
  }

  function renderPlayback() {
    const playback = store.state.playback;
    const station = store.getCurrentStation();
    const labels = config.playbackLabels;

    dom.setText("#info-source", playback.url || "—");
    const sourceNode = dom.$("#info-source");
    if (sourceNode) sourceNode.title = playback.url || "";

    dom.setText("#info-bitrate", station ? station.bitrate : "—");

    const status = labels[playback.status] || playback.status;
    const sourceNote = playback.sourceLabel ? " · " + playback.sourceLabel : "";
    const errorNote = playback.error ? " · " + playback.error : "";
    dom.setText("#info-playback", status + sourceNote + errorNote);
  }

  function renderHealth() {
    const summary = store.getHealthSummary();
    const progress = store.state.healthProgress;

    if (progress.running) {
      dom.setText(
        "#info-health",
        "проверка: " + progress.stationsDone + " из " + progress.stationsTotal + " станций"
      );
      return;
    }

    if (summary.checked === 0) {
      dom.setText("#info-health", "ещё не проверялись");
      return;
    }

    const parts = [
      summary.online + " онлайн",
      summary.fallbackOnly + " только резерв",
      summary.offline + " недоступно",
    ];

    dom.setText(
      "#info-health",
      parts.join(" · ") + " · " + utils.formatRelative(progress.finishedAt || Date.now())
    );
  }

  function renderBusy() {
    const running = Boolean(store.state.healthProgress.running);
    const button = dom.$("#recheck-btn");
    if (button) button.setAttribute("aria-busy", String(running));
    dom.setText("#recheck-label", running ? "Проверка…" : "Проверить сейчас");
  }

  function renderAll() {
    renderNetwork();
    renderPlayback();
    renderHealth();
    renderBusy();
  }

  function init() {
    MR.commands.register("health:check", function () {
      MR.health.run({ manual: true });
    });

    store.on("network", renderNetwork);
    store.on("playback", renderPlayback);
    store.on("stations", renderPlayback);
    store.on("health", renderHealth);
    store.on("health:progress", function () {
      renderHealth();
      renderBusy();
    });

    renderAll();

    // Обновляем «5 мин назад», пока вкладка открыта.
    timer = setInterval(function () {
      if (document.visibilityState === "visible") renderHealth();
    }, 60000);
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  MR.infoUI = {
    init: init,
    render: renderAll,
    dispose: dispose,
  };
})(window);
