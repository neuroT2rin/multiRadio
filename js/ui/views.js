/**
 * ui/views.js — переключение разделов «Станции / Избранные / Эквалайзер / Записи».
 * Панели и кнопки-табы синхронизируются с state.view.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  let tabs = [];
  let panels = [];

  function applyView() {
    const view = store.state.view;

    tabs.forEach(function (tab) {
      const isActive = tab.dataset.command === "view:" + view;
      tab.setAttribute("aria-selected", String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
    });

    panels.forEach(function (panel) {
      panel.hidden = panel.id !== "panel-" + view;
    });
  }

  function onTabKeydown(event) {
    const current = event.currentTarget;
    const index = tabs.indexOf(current);
    let nextIndex = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }

    if (nextIndex === null) return;

    event.preventDefault();
    const next = tabs[nextIndex];
    next.focus();
    store.setView(next.dataset.command.split(":")[1]);
  }

  function init() {
    tabs = dom.$$(".view-tab");
    panels = dom.$$(".view-panel");

    MR.commands.registerMany({
      "view:stations": function () { store.setView("stations"); },
      "view:favorites": function () { store.setView("favorites"); },
      "view:equalizer": function () { store.setView("equalizer"); },
      "view:recordings": function () { store.setView("recordings"); },
    });

    tabs.forEach(function (tab) {
      tab.addEventListener("keydown", onTabKeydown);
    });

    store.on("view", applyView);
    applyView();
  }

  MR.views = {
    init: init,
    apply: applyView,
    set: function (view) { store.setView(view); },
  };
})(window);
