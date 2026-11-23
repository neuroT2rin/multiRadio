/**
 * ui/plan.js — «План эфира»: что играет сейчас и что включится следующим.
 *
 * Реального треклиста у радиопотока без ICY-метаданных нет, поэтому план
 * строится по текущему списку станций (с учётом фильтров). Это честный
 * «следующий по списку», а не выдуманная программа передач.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  const PLAYBACK_LABELS = {
    idle: "Тишина",
    connecting: "Подключение…",
    buffering: "Буферизация…",
    playing: "В эфире",
    paused: "Пауза",
    error: "Ошибка потока",
    blocked: "Нужен клик",
  };

  let nowBox = null;
  let nextList = null;
  let stateBadge = null;

  function stationButton(station, className) {
    return dom.el("button", {
      class: className,
      type: "button",
      "data-command": "station:play",
      "data-station-id": station.id,
      title: "Включить «" + station.name + "»",
    },
      dom.el("span", { class: "plan-next__emoji", "aria-hidden": "true" }, station.emoji),
      dom.el("span", { class: "plan-next__body" },
        dom.el("span", { class: "plan-next__name", text: station.name }),
        dom.el("span", { class: "plan-next__meta", text: station.genre + " · " + station.bitrate })
      )
    );
  }

  function render() {
    if (!nowBox) return;

    const playback = store.state.playback;
    const current = playback.stationId ? store.findStation(playback.stationId) : null;

    if (stateBadge) {
      stateBadge.textContent = PLAYBACK_LABELS[playback.status] || PLAYBACK_LABELS.idle;
      stateBadge.dataset.state = playback.status;
    }

    nowBox.innerHTML = "";
    if (current) {
      nowBox.appendChild(dom.el("div", { class: "plan-now__station" },
        dom.el("span", { class: "plan-now__emoji", "aria-hidden": "true" }, current.emoji),
        dom.el("span", { class: "plan-now__body" },
          dom.el("span", { class: "plan-now__name", text: current.name }),
          dom.el("span", { class: "plan-now__meta", text: current.genre + " · " + current.bitrate })
        )
      ));
      nowBox.appendChild(dom.el("span", {
        class: "plan-now__source",
        text: playback.sourceLabel ? "источник: " + playback.sourceLabel : "источник: —",
      }));
    } else {
      nowBox.appendChild(dom.el("p", {
        class: "plan-now__empty",
        text: "Тишина — выберите станцию в списке.",
      }));
    }

    if (!nextList) return;
    nextList.innerHTML = "";

    const visible = store.getVisibleStations();
    if (visible.length === 0) {
      nextList.appendChild(dom.el("li", { class: "plan-next__empty", text: "Список станций пуст." }));
      return;
    }

    const currentIndex = current
      ? visible.findIndex(function (station) { return station.id === current.id; })
      : -1;

    const upcoming = [];
    if (currentIndex >= 0 && visible.length > 1) {
      for (let step = 1; step < visible.length && upcoming.length < 3; step += 1) {
        upcoming.push(visible[(currentIndex + step) % visible.length]);
      }
    } else {
      visible.slice(0, 3).forEach(function (station) { upcoming.push(station); });
    }

    upcoming.forEach(function (station, index) {
      nextList.appendChild(dom.el("li", { class: "plan-next__item-wrap" },
        dom.el("span", { class: "plan-next__index", "aria-hidden": "true" }, String(index + 1) + "."),
        stationButton(station, "plan-next__item")
      ));
    });
  }

  function init() {
    nowBox = dom.$("#plan-now");
    nextList = dom.$("#plan-next");
    stateBadge = dom.$("#plan-now-state");
    if (!nowBox) return;

    store.on("playback", render);
    store.on("stations", render);
    store.on("filters", render);
    store.on("groups", render);

    render();
  }

  MR.planUI = {
    init: init,
    render: render,
  };
})(window);
