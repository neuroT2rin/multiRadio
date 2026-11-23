/**
 * ui/nav.js — полноценное меню: выпадающие группы, клавиатура,
 * мобильный drawer, синхронизация галочек с состоянием.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  let header = null;
  let nav = null;
  let toggle = null;
  let groups = [];

  function setExpanded(group, expanded) {
    const button = group.querySelector(".nav-btn");
    group.classList.toggle("is-open", expanded);
    if (button) button.setAttribute("aria-expanded", String(expanded));
  }

  function closeGroups(except) {
    groups.forEach(function (group) {
      if (group !== except) setExpanded(group, false);
    });
  }

  function toggleGroup(group) {
    const willOpen = !group.classList.contains("is-open");
    closeGroups(group);
    setExpanded(group, willOpen);
  }

  function focusItem(group, index) {
    const items = dom.$$(".nav-item", group).filter(function (node) {
      return !node.disabled;
    });
    if (!items.length) return;
    const target = items[(index + items.length) % items.length];
    target.focus();
  }

  function isDrawerOpen() {
    return header.classList.contains("is-nav-open");
  }

  function setDrawer(open) {
    header.classList.toggle("is-nav-open", open);
    document.body.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");

    if (open) {
      closeGroups();
      const first = nav.querySelector(".nav-btn");
      if (first) first.focus();
    }
  }

  function closeAll(options) {
    closeGroups();
    if (isDrawerOpen()) setDrawer(false);
    if (options && options.restoreFocus && toggle) toggle.focus();
  }

  function syncChecked() {
    const state = store.state;

    nav.querySelectorAll('[data-command^="view:"]').forEach(function (item) {
      item.setAttribute("aria-checked", String(item.dataset.command === "view:" + state.view));
    });

    nav.querySelectorAll('[data-command="ui:toggle-bg"]').forEach(function (item) {
      item.setAttribute("aria-checked", String(state.ui.bgEnabled));
    });

    nav.querySelectorAll('[data-command="ui:mode"]').forEach(function (item) {
      item.setAttribute("aria-checked", String(item.dataset.mode === state.ui.mode));
    });
  }

  function init() {
    header = dom.$("#app-header");
    nav = dom.$("#main-nav");
    toggle = dom.$("#nav-toggle");
    if (!header || !nav) return;

    groups = dom.$$(".nav-group", nav);

    groups.forEach(function (group) {
      const menu = group.querySelector(".nav-menu");
      const button = group.querySelector(".nav-btn");
      if (menu) {
        menu.setAttribute("role", "menu");
        const label = button ? button.textContent.trim() : "";
        menu.setAttribute("aria-label", label);
      }
    });

    nav.addEventListener("click", function (event) {
      const button = event.target.closest(".nav-btn");
      if (button) {
        toggleGroup(button.closest(".nav-group"));
        return;
      }
      if (event.target.closest(".nav-item[data-command]")) {
        // Команда выполнится общей шиной; меню закрываем сразу.
        closeAll();
      }
    });

    nav.addEventListener("keydown", function (event) {
      const button = event.target.closest(".nav-btn");

      if (button) {
        const group = button.closest(".nav-group");

        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (!group.classList.contains("is-open")) {
            closeGroups(group);
            setExpanded(group, true);
          }
          focusItem(group, 0);
          return;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          closeGroups(group);
          setExpanded(group, true);
          focusItem(group, -1);
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          closeAll({ restoreFocus: true });
        }
        return;
      }

      const item = event.target.closest(".nav-item");
      if (!item) return;

      const group = item.closest(".nav-group");
      const items = dom.$$(".nav-item", group);
      const index = items.indexOf(item);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusItem(group, index + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusItem(group, index - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        focusItem(group, 0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusItem(group, -1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeAll();
        const buttonInGroup = group.querySelector(".nav-btn");
        if (buttonInGroup) buttonInGroup.focus();
      } else if (event.key === "Tab") {
        closeGroups();
      }
    });

    toggle.addEventListener("click", function () {
      setDrawer(!isDrawerOpen());
    });

    document.addEventListener("click", function (event) {
      if (!isDrawerOpen() && !nav.querySelector(".nav-group.is-open")) return;
      if (toggle.contains(event.target)) return;

      if (isDrawerOpen()) {
        // На мобильных клик по пустому месту вне панели закрывает drawer.
        const insideNav = nav.contains(event.target);
        if (!insideNav) setDrawer(false);
        return;
      }

      if (!nav.contains(event.target)) closeGroups();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (nav.querySelector(".nav-group.is-open") || isDrawerOpen()) {
        closeAll({ restoreFocus: true });
      }
    });

    const desktopQuery = global.matchMedia("(min-width: 1081px)");
    const handleBreakpoint = function (event) {
      if (event.matches) setDrawer(false);
    };
    if (typeof desktopQuery.addEventListener === "function") {
      desktopQuery.addEventListener("change", handleBreakpoint);
    } else if (typeof desktopQuery.addListener === "function") {
      desktopQuery.addListener(handleBreakpoint);
    }

    const brand = dom.$("#brand-link");
    if (brand) {
      brand.addEventListener("click", function (event) {
        event.preventDefault();
        global.scrollTo({ top: 0, behavior: "smooth" });
        closeAll();
      });
    }

    store.on("view", syncChecked);
    store.on("ui", syncChecked);
    syncChecked();
  }

  MR.navUI = {
    init: init,
    closeAll: closeAll,
  };
})(window);
