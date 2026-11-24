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
  let sourcesBox = null;

  function renderNetwork() {
    const network = store.state.network;
    const type = network.effectiveType ? network.effectiveType.toUpperCase() : "неизвестно";
    const downlink = typeof network.downlink === "number" ? " · ≈" + network.downlink + " Мбит/с" : "";

    dom.setText("#info-connection", type + downlink);
    dom.setText("#info-connection-state", NETWORK_LABELS[network.status] || "—");
  }

  /** Список источников текущей станции: битрейт, URL и состояние проверки. */
  function renderSources() {
    if (!sourcesBox) return;

    const station = store.getCurrentStation();
    sourcesBox.innerHTML = "";
    if (!station) {
      sourcesBox.hidden = true;
      return;
    }

    const sources = store.getStationSources(station);
    if (!sources.length) {
      sourcesBox.hidden = true;
      return;
    }

    const health = store.getHealth(station.id);
    const probes = health && Array.isArray(health.sources) ? health.sources : [];
    const order = store.getPlaybackOrder(station);
    const playback = store.state.playback;
    const currentIndex = playback.stationId === station.id && playback.url
      ? sources.findIndex(function (source) { return source.url === playback.url; })
      : -1;

    sourcesBox.hidden = false;
    sourcesBox.appendChild(dom.el("p", {
      class: "info-sources__title",
      text: "Источники станции",
    }));

    const list = dom.el("ul", { class: "info-sources__list" });

    order.forEach(function (index) {
      const source = sources[index];
      const probe = probes[index];
      const isBest = index === order[0];
      const isCurrent = index === currentIndex;
      const healthState = !probe ? "unknown" : (probe.ok ? "online" : "offline");
      const healthTitle = !probe
        ? "Ещё не проверялся"
        : (probe.ok ? "Источник отвечает" : "Источник не отвечает");

      const item = dom.el("li", {
        class: "info-source" + (isBest ? " is-best" : "") + (isCurrent ? " is-current" : ""),
        title: (isBest ? "Лучший по битрейту. " : "") + source.url,
      },
        dom.el("span", { class: "info-source__bitrate", text: utils.formatBitrate(source.bitrate) }),
        dom.el("span", { class: "info-source__url mono", text: source.url }),
        dom.el("span", {
          class: "health-dot",
          "data-health": healthState,
          role: "img",
          title: healthTitle,
          "aria-label": healthTitle,
        })
      );

      list.appendChild(item);
    });

    sourcesBox.appendChild(list);
  }

  function renderPlayback() {
    const playback = store.state.playback;
    const station = store.getCurrentStation();
    const labels = config.playbackLabels;

    dom.setText("#info-source", playback.url || "—");
    const sourceNode = dom.$("#info-source");
    if (sourceNode) sourceNode.title = playback.url || "";

    const bitrateNode = dom.$("#info-bitrate");
    if (bitrateNode) {
      if (!station) {
        bitrateNode.textContent = "—";
        bitrateNode.title = "";
      } else {
        const isCurrent = playback.stationId === station.id &&
          Boolean(playback.url) && playback.status !== "idle";
        bitrateNode.textContent = utils.formatBitrate(
          isCurrent ? playback.bitrate : store.getStationBitrate(station)
        );
        bitrateNode.title = isCurrent
          ? "Битрейт текущего источника"
          : "Максимальный битрейт среди источников станции";
      }
    }

    const status = labels[playback.status] || playback.status;
    const sourceNote = playback.sourceLabel ? " · " + playback.sourceLabel : "";
    const errorNote = playback.error ? " · " + playback.error : "";
    dom.setText("#info-playback", status + sourceNote + errorNote);

    renderSources();
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
    sourcesBox = dom.$("#info-sources");

    MR.commands.register("health:check", function () {
      MR.health.run({ manual: true });
    });

    store.on("network", renderNetwork);
    store.on("playback", renderPlayback);
    store.on("stations", renderPlayback);
    store.on("health", function () {
      renderHealth();
      renderSources();
    });
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
