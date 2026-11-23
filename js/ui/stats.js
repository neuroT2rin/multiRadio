/**
 * ui/stats.js — панель статистики прослушивания (станции и жанры).
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;

  let totalLabel = null;
  let stationsList = null;
  let genresList = null;
  let emptyLabel = null;

  function formatMinutes(seconds) {
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return "< 1 мин";
    if (minutes < 60) return minutes + " мин";

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours + " ч" + (rest ? " " + rest + " мин" : "");
  }

  function render() {
    if (!totalLabel) return;

    const summary = MR.stats.getSummary();
    totalLabel.textContent = summary.totalSeconds > 0
      ? "Всего в эфире: " + utils.formatDuration(summary.totalSeconds * 1000)
      : "Пока нет данных";

    if (stationsList) {
      stationsList.innerHTML = "";
      summary.stations.forEach(function (item) {
        stationsList.appendChild(dom.el("li", { class: "stats-row" },
          dom.el("span", { class: "stats-row__name", text: item.emoji + " " + item.name }),
          dom.el("span", { class: "stats-row__value", text: formatMinutes(item.seconds) })
        ));
      });
    }

    if (genresList) {
      genresList.innerHTML = "";
      const max = summary.genres.length ? summary.genres[0].seconds : 0;

      summary.genres.forEach(function (item) {
        const percent = max > 0 ? Math.max(4, Math.round((item.seconds / max) * 100)) : 0;
        const bar = dom.el("span", { class: "stats-bar", "aria-hidden": "true" },
          dom.el("span", { class: "stats-bar__fill", style: { width: percent + "%" } })
        );
        genresList.appendChild(dom.el("li", { class: "stats-row stats-row--genre" },
          dom.el("span", { class: "stats-row__name", text: item.name }),
          dom.el("span", { class: "stats-row__value", text: formatMinutes(item.seconds) }),
          bar
        ));
      });
    }

    if (emptyLabel) {
      const isEmpty = summary.stations.length === 0;
      emptyLabel.hidden = !isEmpty;
      if (isEmpty) {
        emptyLabel.textContent = "Пока нет данных — включите радио, и время начнёт копиться.";
      }
    }
  }

  async function reset() {
    const confirmed = await MR.modal.confirm({
      title: "Сбросить статистику?",
      message: "Всё накопленное время прослушивания по станциям и жанрам будет удалено.",
      confirmLabel: "Сбросить",
      cancelLabel: "Отмена",
      danger: true,
    });
    if (!confirmed) return;
    MR.stats.reset();
    MR.toast.success("Статистика прослушивания сброшена.");
  }

  function init() {
    totalLabel = dom.$("#stats-total");
    stationsList = dom.$("#stats-stations");
    genresList = dom.$("#stats-genres");
    emptyLabel = dom.$("#stats-empty");
    if (!totalLabel) return;

    MR.commands.registerMany({
      "stats:reset": reset,
    });

    store.on("stats", render);
    store.on("stations", render);

    render();
  }

  MR.statsUI = {
    init: init,
    render: render,
  };
})(window);
