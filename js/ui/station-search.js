/**
 * ui/station-search.js — панель поиска станций по нескольким каталогам.
 *
 * Состояние поиска локальное: в MR.store попадают только добавленные станции.
 * Запросы отменяются через AbortController, каталоги опрашиваются параллельно,
 * результаты дорисовываются после каждого ответившего сервиса. Проверка
 * работоспособности запускается только для видимых карточек (IntersectionObserver).
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;
  const providersConfig = MR.searchProviders || {};
  const SETTINGS = providersConfig.settings || {};

  const SEARCH_DEBOUNCE = SETTINGS.debounceMs || 300;
  const PROBE_FALLBACK_LIMIT = SETTINGS.probeFallbackLimit || 12;

  let modal = null;
  let modalBody = null;
  let queryInput = null;
  let countrySelect = null;
  let genreInput = null;
  let languageSelect = null;
  let resultsList = null;
  let emptyNode = null;
  let countLabel = null;
  let statusNode = null;
  let errorNode = null;
  let viewButtons = [];
  let clearButton = null;
  let offStations = null;
  let addMenu = null;
  let addMenuPanel = null;
  let menuContext = null;
  const documentOffs = [];

  const state = {
    open: false,
    view: "list",
    results: [],
    errors: [],
    loading: false,
    seq: 0,
    controller: null,
    healthController: null,
    health: new Map(),
    probing: new Set(),
    cardNodes: new Map(),
    observer: null,
  };

  /* ------------------------------------------------------------------------
     Разметка
     ------------------------------------------------------------------------ */

  function populateSelects() {
    if (countrySelect && !countrySelect.dataset.ready) {
      countrySelect.appendChild(dom.el("option", { value: "", text: "Все страны" }));
      (providersConfig.countries || []).forEach(function (country) {
        countrySelect.appendChild(dom.el("option", {
          value: country.code,
          text: country.name,
        }));
      });
      countrySelect.dataset.ready = "true";
    }

    if (languageSelect && !languageSelect.dataset.ready) {
      languageSelect.appendChild(dom.el("option", { value: "", text: "Любой язык" }));
      (providersConfig.languages || []).forEach(function (language) {
        languageSelect.appendChild(dom.el("option", {
          value: language.code,
          text: language.name,
        }));
      });
      languageSelect.dataset.ready = "true";
    }
  }

  function languageLabel(code) {
    const value = String(code || "").toLowerCase();
    if (!value) return "";
    const match = (providersConfig.languages || []).find(function (language) {
      return language.code === value;
    });
    return match ? match.name : value;
  }

  function collectFilters() {
    return {
      query: queryInput ? queryInput.value : "",
      countryCode: countrySelect ? countrySelect.value : "",
      genre: genreInput ? genreInput.value : "",
      language: languageSelect ? languageSelect.value : "",
    };
  }

  function cardKey(record) {
    if (!record) return "";
    return record.primaryUrl || (record.sources[0] && record.sources[0].url) || "";
  }

  function addError(error) {
    if (!error) return;
    const label = error.label || error.provider || "Каталог";
    if (state.errors.some(function (item) { return item.label === label; })) return;
    state.errors.push({ label: label, message: error.message || "" });
  }

  /* ------------------------------------------------------------------------
     Карточка результата
     ------------------------------------------------------------------------ */

  function setButtonAdded(button, record, added) {
    if (!button) return;
    const label = button.querySelector(".search-card__add-label");
    if (added) {
      button.disabled = true;
      button.classList.add("is-added");
      if (label) label.textContent = "Добавлена";
      button.setAttribute("aria-label", "Станция «" + record.name + "» уже добавлена");
    } else {
      button.disabled = false;
      button.classList.remove("is-added");
      if (label) label.textContent = "Добавить";
      button.setAttribute("aria-label", "Добавить станцию " + record.name);
    }
  }

  function createCard(record, index) {
    const key = cardKey(record);
    const health = state.health.get(key) || {
      state: "unknown",
      title: "Ещё не проверялась",
    };

    const badges = dom.el("span", { class: "search-card__badges" },
      record.providers.map(function (provider) {
        return dom.el("span", { class: "station-row__group", text: provider.label });
      })
    );

    const metaParts = [];
    if (record.bitrates.length) {
      metaParts.push(record.bitrates.join(" · ") + " kbps");
    } else {
      metaParts.push("битрейт не указан");
    }
    const country = record.country || providersConfig.countryName(record.countryCode);
    if (country) metaParts.push(country);
    if (record.genre) metaParts.push(record.genre);

    const extraParts = [];
    if (record.language) extraParts.push("язык: " + languageLabel(record.language));
    if (record.codec) extraParts.push(record.codec.toUpperCase());
    if (record.sources.length > 1) {
      extraParts.push(record.sources.length + " " + utils.pluralRu(record.sources.length, "source"));
    }

    const dot = dom.el("span", {
      class: "health-dot",
      "data-health": health.state,
      role: "img",
      title: health.title,
      "aria-label": health.title,
    });

    const addButton = dom.el("button", {
      class: "btn btn-primary btn-sm search-card__add",
      type: "button",
      "data-search-add": "",
      "data-search-index": String(index),
      title: "Добавить в коллекцию",
      "aria-label": "Добавить станцию " + record.name,
    },
      dom.el("span", { "aria-hidden": "true", text: "➕" }),
      dom.el("span", { class: "search-card__add-label", text: "Добавить" })
    );

    const addToggle = dom.el("button", {
      class: "btn btn-primary btn-sm search-card__add-toggle",
      type: "button",
      "data-search-add-toggle": "",
      "data-search-index": String(index),
      title: "Добавить в группу",
      "aria-label": "Добавить в группу",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    },
      dom.el("span", { "aria-hidden": "true", text: "▾" })
    );

    const addGroup = dom.el("div", { class: "search-card__add-group" }, addButton, addToggle);

    const existing = MR.radioSearch.findStationByRecord(record);
    setButtonAdded(addButton, record, Boolean(existing));

    const card = dom.el("li", {
      class: "search-card",
      "data-search-url": key,
      "data-search-index": String(index),
    },
      dom.el("div", { class: "search-card__main" },
        dom.el("div", { class: "search-card__head" },
          dom.el("span", { class: "search-card__name", text: record.name, title: record.name }),
          badges
        ),
        dom.el("p", { class: "search-card__meta", text: metaParts.join(" · ") }),
        extraParts.length
          ? dom.el("p", { class: "search-card__extra", text: extraParts.join(" · ") })
          : null
      ),
      dom.el("div", { class: "search-card__side" }, dot, addGroup)
    );

    state.cardNodes.set(key, {
      card: card,
      dot: dot,
      button: addButton,
      toggle: addToggle,
      record: record,
    });

    return card;
  }

  function appendSkeletons() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 4; index += 1) {
      fragment.appendChild(dom.el("li", {
        class: "search-card search-card--skeleton",
        "aria-hidden": "true",
      },
        dom.el("span", { class: "search-skeleton__line search-skeleton__line--title" }),
        dom.el("span", { class: "search-skeleton__line search-skeleton__line--meta" })
      ));
    }
    resultsList.appendChild(fragment);
  }

  /* ------------------------------------------------------------------------
     Рендер
     ------------------------------------------------------------------------ */

  function render() {
    if (!resultsList) return;

    closeGroupMenu({ refocus: false });

    viewButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.searchView === state.view));
    });
    resultsList.classList.toggle("search-results--grid", state.view === "grid");

    const count = state.results.length;
    if (countLabel) {
      countLabel.textContent = count + " " + utils.pluralRu(count, "station");
    }

    resultsList.innerHTML = "";
    state.cardNodes.clear();

    if (state.loading && count === 0) {
      appendSkeletons();
    } else {
      const fragment = document.createDocumentFragment();
      state.results.forEach(function (record, index) {
        fragment.appendChild(createCard(record, index));
      });
      resultsList.appendChild(fragment);
    }

    if (emptyNode) {
      emptyNode.hidden = count > 0 || (state.loading && count === 0);
      if (!emptyNode.hidden) {
        const title = emptyNode.querySelector(".empty-state__title");
        const text = emptyNode.querySelector(".empty-state__text");
        if (state.errors.length) {
          if (title) title.textContent = "Каталоги не ответили";
          if (text) text.textContent = "Проверьте сеть и попробуйте ещё раз. Встроенный каталог не нашёл совпадений.";
        } else {
          if (title) title.textContent = "Ничего не найдено";
          if (text) text.textContent = "Попробуйте изменить название, страну или жанр.";
        }
      }
    }

    if (statusNode) {
      statusNode.hidden = !state.loading;
      statusNode.textContent = state.loading
        ? (count ? "Дополняем результаты…" : "Поиск по каталогам…")
        : "";
    }

    if (errorNode) {
      errorNode.hidden = state.errors.length === 0;
      if (state.errors.length) {
        errorNode.textContent = "Не ответили: " +
          state.errors.map(function (item) { return item.label; }).join(", ") +
          ". Показаны результаты встроенного каталога и ответивших сервисов.";
      }
    }

    observeCards();
  }

  /* ------------------------------------------------------------------------
     Проверка видимых карточек
     ------------------------------------------------------------------------ */

  function setHealth(key, info) {
    state.health.set(key, info);
    const item = state.cardNodes.get(key);
    if (!item || !item.dot) return;
    item.dot.dataset.health = info.state;
    item.dot.title = info.title;
    item.dot.setAttribute("aria-label", info.title);
  }

  function maybeProbe(record, key) {
    const known = state.health.get(key);
    if (known && (known.state === "online" || known.state === "fallback" || known.state === "offline")) {
      return;
    }
    if (state.probing.has(key)) return;

    state.probing.add(key);
    setHealth(key, { state: "checking", title: "Проверяется…" });

    const signal = state.healthController ? state.healthController.signal : undefined;
    MR.radioSearch.probeStation(record, { signal: signal }).then(function (result) {
      state.probing.delete(key);
      if (!result || result.aborted) return;
      setHealth(key, result);
    }).catch(function () {
      state.probing.delete(key);
      setHealth(key, { state: "unknown", title: "Не удалось проверить поток" });
    });
  }

  function observeCards() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (!state.open || !state.cardNodes.size) return;

    const entries = Array.from(state.cardNodes.entries());

    if (typeof global.IntersectionObserver !== "function") {
      entries.slice(0, PROBE_FALLBACK_LIMIT).forEach(function (entry) {
        maybeProbe(entry[1].record, entry[0]);
      });
      return;
    }

    state.observer = new global.IntersectionObserver(function (records) {
      records.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        const key = entry.target.dataset.searchUrl;
        const item = state.cardNodes.get(key);
        if (!item) return;
        state.observer.unobserve(entry.target);
        maybeProbe(item.record, key);
      });
    }, {
      root: modalBody,
      rootMargin: "120px",
    });

    entries.forEach(function (entry) {
      state.observer.observe(entry[1].card);
    });
  }

  function syncAddedStates() {
    state.cardNodes.forEach(function (item) {
      const existing = MR.radioSearch.findStationByRecord(item.record);
      setButtonAdded(item.button, item.record, Boolean(existing));
    });
  }

  /* ------------------------------------------------------------------------
     Меню выбора группы (правая часть разделённой кнопки)
     ------------------------------------------------------------------------ */

  const MENU_GAP = 6;
  const MENU_EDGE = 8;

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function normalizeStationName(name) {
    return String(name || "").trim().toLowerCase();
  }

  /**
   * Станция в коллекции: сначала по пересечению URL, затем по названию —
   * каталоги иногда отдают тот же поток по другому адресу.
   */
  function findStationForRecord(record) {
    const byUrl = MR.radioSearch.findStationByRecord(record);
    if (byUrl) return byUrl;

    const name = normalizeStationName(record && record.name);
    if (!name) return null;

    return store.state.stations.find(function (station) {
      return normalizeStationName(station.name) === name;
    }) || null;
  }

  function ensureGroupMenu() {
    if (addMenu && addMenu.isConnected) return addMenu;

    addMenuPanel = modal.querySelector(".modal__panel") || modal;
    addMenu = dom.el("div", {
      class: "search-add-menu",
      role: "menu",
      "aria-label": "Группы станций",
      hidden: true,
    });

    addMenu.addEventListener("click", onGroupMenuClick);
    addMenu.addEventListener("keydown", onGroupMenuKeydown);
    addMenuPanel.appendChild(addMenu);
    return addMenu;
  }

  function createGroupMenuItem(options) {
    const opts = options || {};
    const classes = ["search-add-menu__item"];
    if (opts.current) classes.push("is-current");
    if (opts.create) classes.push("search-add-menu__item--create");

    return dom.el("button", {
      class: classes.join(" "),
      type: "button",
      role: "menuitem",
      dataset: opts.dataset || {},
      disabled: opts.disabled ? true : null,
      "aria-current": opts.current ? "true" : null,
    },
      opts.current
        ? dom.el("span", { class: "search-add-menu__check", "aria-hidden": "true", text: "✓" })
        : null,
      dom.el("span", { class: "search-add-menu__label", text: opts.label || "" }),
      opts.count === undefined || opts.count === null
        ? null
        : dom.el("span", { class: "search-add-menu__count", text: String(opts.count) })
    );
  }

  function fillGroupMenu(currentGroupId) {
    clearNode(addMenu);

    const groups = (store.state.groups || []).slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, "ru");
    });

    addMenu.appendChild(createGroupMenuItem({
      dataset: { groupOption: "" },
      label: "Без группы",
      current: !currentGroupId,
    }));

    if (!groups.length) {
      addMenu.appendChild(dom.el("button", {
        class: "search-add-menu__item is-disabled",
        type: "button",
        role: "menuitem",
        disabled: true,
        "aria-disabled": "true",
        text: "Групп пока нет",
      }));
    } else {
      groups.forEach(function (group) {
        addMenu.appendChild(createGroupMenuItem({
          dataset: { groupOption: group.id },
          label: group.name,
          count: group.stationIds.length,
          current: group.id === currentGroupId,
        }));
      });
    }

    addMenu.appendChild(dom.el("div", { class: "search-add-menu__sep", role: "separator" }));
    addMenu.appendChild(createGroupMenuItem({
      dataset: { groupCreate: "" },
      label: "Создать группу…",
      create: true,
    }));
  }

  function menuItems() {
    if (!addMenu) return [];
    return Array.prototype.slice.call(addMenu.querySelectorAll('[role="menuitem"]'))
      .filter(function (node) { return node.tagName === "BUTTON" && !node.disabled; });
  }

  function positionGroupMenu(button) {
    const panel = addMenuPanel;
    if (!panel || !button) return;

    const panelRect = panel.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const width = addMenu.offsetWidth;
    const height = addMenu.offsetHeight;
    const maxLeft = Math.max(MENU_EDGE, panel.clientWidth - width - MENU_EDGE);

    let left = utils.clamp(buttonRect.right - panelRect.left - width, MENU_EDGE, maxLeft);
    let top = buttonRect.bottom - panelRect.top + MENU_GAP;

    const bottomLimit = panel.clientHeight - MENU_EDGE;
    if (top + height > bottomLimit) {
      const above = buttonRect.top - panelRect.top - height - MENU_GAP;
      top = above >= MENU_EDGE ? above : Math.max(MENU_EDGE, bottomLimit - height);
    }

    addMenu.style.left = Math.round(left) + "px";
    addMenu.style.top = Math.round(top) + "px";
  }

  function closeGroupMenu(options) {
    const opts = options || {};
    const context = menuContext;
    menuContext = null;

    if (!addMenu || addMenu.hidden) return;

    addMenu.hidden = true;
    if (context && context.button) {
      context.button.setAttribute("aria-expanded", "false");
      if (opts.refocus) {
        try { context.button.focus({ preventScroll: true }); } catch (error) { /* noop */ }
      }
    }
  }

  function openGroupMenu(button, index) {
    const record = state.results[index];
    if (!button || !record) return;

    closeGroupMenu({ refocus: false });
    ensureGroupMenu();

    const existing = findStationForRecord(record);
    const currentGroup = existing ? store.getGroupOfStation(existing.id) : null;
    fillGroupMenu(currentGroup ? currentGroup.id : "");

    menuContext = { button: button, index: index, record: record };
    button.setAttribute("aria-expanded", "true");
    addMenu.hidden = false;
    positionGroupMenu(button);

    const first = menuItems()[0];
    if (first) {
      try { first.focus({ preventScroll: true }); } catch (error) { first.focus(); }
    }
  }

  function toggleGroupMenu(button, index) {
    if (menuContext && menuContext.button === button && addMenu && !addMenu.hidden) {
      closeGroupMenu({ refocus: true });
      return;
    }
    openGroupMenu(button, index);
  }

  function groupMenuItemFromEvent(event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return null;
    return target.closest("[data-group-option], [data-group-create]");
  }

  function onGroupMenuClick(event) {
    const item = groupMenuItemFromEvent(event);
    if (!item || !addMenu || !addMenu.contains(item) || item.disabled) return;

    event.preventDefault();

    if (item.hasAttribute("data-group-create")) {
      // Фокус возвращаем на шеврон: после закрытия редактора он вернётся сюда.
      closeGroupMenu({ refocus: true });
      if (MR.groupsUI && typeof MR.groupsUI.openEditor === "function") {
        MR.groupsUI.openEditor(null);
      }
      return;
    }

    const context = menuContext;
    if (!context) {
      closeGroupMenu({ refocus: false });
      return;
    }

    applyGroupChoice(context, item.getAttribute("data-group-option") || null);
  }

  function onGroupMenuKeydown(event) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (keys.indexOf(event.key) === -1) return;
    if (!addMenu || addMenu.hidden) return;

    const items = menuItems();
    if (!items.length) return;

    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    let next = current;

    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;

    const target = items[next];
    if (target) target.focus();
  }

  function onDocumentKeydown(event) {
    if (event.key !== "Escape") return;
    if (!addMenu || addMenu.hidden) return;
    // Меню перехватывает Esc раньше модалки: она не должна закрываться.
    event.preventDefault();
    event.stopImmediatePropagation();
    closeGroupMenu({ refocus: true });
  }

  function onDocumentClick(event) {
    if (!addMenu || addMenu.hidden) return;
    const target = event.target;
    if (!(target instanceof global.Element)) return;
    if (addMenu.contains(target)) return;
    if (target.closest("[data-search-add-toggle]")) return;
    closeGroupMenu({ refocus: false });
  }

  function onViewportChange() {
    closeGroupMenu({ refocus: false });
  }

  function onPanelScroll(event) {
    if (!addMenu || addMenu.hidden) return;
    if (addMenu.contains(event.target)) return;
    closeGroupMenu({ refocus: false });
  }

  /* ------------------------------------------------------------------------
     Поиск
     ------------------------------------------------------------------------ */

  function runSearch() {
    if (!state.open) return;

    if (state.controller) state.controller.abort();
    if (state.healthController) state.healthController.abort();

    state.controller = new AbortController();
    state.healthController = new AbortController();
    state.seq += 1;
    const seq = state.seq;

    state.loading = true;
    state.errors = [];
    state.results = [];
    state.probing.clear();
    render();

    const filters = collectFilters();

    MR.radioSearch.search(filters, {
      signal: state.controller.signal,
      onBatch: function (batch) {
        if (seq !== state.seq) return;
        state.results = batch.results || [];
        if (batch.error) addError(batch.error);
        render();
      },
      onDone: function (payload) {
        if (seq !== state.seq) return;
        state.loading = false;
        state.results = payload.results || state.results;
        state.errors = payload.errors || state.errors;
        render();
      },
    }).then(function (payload) {
      if (seq !== state.seq) return;
      if (payload && !payload.aborted && state.loading) {
        state.loading = false;
        state.results = payload.results || state.results;
        state.errors = payload.errors || state.errors;
        render();
      }
    }).catch(function () {
      if (seq !== state.seq) return;
      state.loading = false;
      render();
    });
  }

  const debouncedSearch = utils.debounce(runSearch, SEARCH_DEBOUNCE);

  /* ------------------------------------------------------------------------
     Добавление
     ------------------------------------------------------------------------ */

  function addErrorMessage(errors) {
    const map = errors || {};
    return map.general || map.name || map.sources ||
      Object.keys(map).map(function (key) { return map[key]; })[0] ||
      "Не удалось добавить станцию.";
  }

  function addResult(index) {
    const record = state.results[index];
    if (!record) return;

    const result = MR.radioSearch.addRecord(record);

    if (result.ok) {
      MR.toast.success("Станция «" + result.station.name + "» добавлена.", { timeout: 2800 });
      syncAddedStates();
      return;
    }

    if (result.reason === "exists") {
      MR.toast.info("Станция «" + result.station.name + "» уже добавлена.");
      syncAddedStates();
      return;
    }

    MR.toast.error(addErrorMessage(result.errors));
  }

  /** Вход в store.addStation для записи каталога — как в radio-search, плюс группа. */
  function buildStationInput(record, groupId) {
    const limits = (MR.config && MR.config.audio) || {};
    const maxSources = limits.maxSources || 6;
    const sources = (record.sources || []).slice(0, maxSources).map(function (source) {
      return { url: source.url, bitrate: source.bitrate || 0 };
    });

    return {
      name: record.name,
      emoji: "🎧",
      genre: record.genre,
      sources: sources,
      groupId: groupId || "",
    };
  }

  /**
   * Пункт меню выбран: станция либо добавляется сразу в группу, либо
   * (если уже есть в коллекции) переносится — без дубликата.
   */
  function applyGroupChoice(context, groupId) {
    const record = context.record;
    const group = groupId ? store.getGroup(groupId) : null;

    if (groupId && !group) {
      MR.toast.error("Группа не найдена — возможно, её уже удалили.");
      syncAddedStates();
      closeGroupMenu({ refocus: false });
      return;
    }

    const existing = findStationForRecord(record);

    if (existing) {
      const previousGroup = store.getGroupOfStation(existing.id);
      const assigned = store.assignStationToGroup(existing.id, groupId);
      if (!assigned) {
        MR.toast.error("Не удалось изменить группу станции.");
      } else if (group) {
        MR.toast.success("Добавлено в группу «" + group.name + "».", { timeout: 2800 });
      } else if (previousGroup) {
        MR.toast.success("Станция «" + existing.name + "» убрана из группы.", { timeout: 2800 });
      } else {
        MR.toast.info("Станция «" + existing.name + "» уже без группы.");
      }
      syncAddedStates();
      closeGroupMenu({ refocus: true });
      return;
    }

    const result = store.addStation(buildStationInput(record, groupId));
    if (result.ok) {
      MR.toast.success(
        group
          ? "Добавлено в группу «" + group.name + "»."
          : "Станция «" + result.station.name + "» добавлена.",
        { timeout: 2800 }
      );
      syncAddedStates();
      closeGroupMenu({ refocus: true });
      return;
    }

    MR.toast.error(addErrorMessage(result.errors));
    closeGroupMenu({ refocus: false });
  }

  /* ------------------------------------------------------------------------
     Открытие и закрытие
     ------------------------------------------------------------------------ */

  function cleanupSearch() {
    state.open = false;
    state.seq += 1;

    closeGroupMenu({ refocus: false });

    if (state.controller) state.controller.abort();
    if (state.healthController) state.healthController.abort();
    state.controller = null;
    state.healthController = null;

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    state.probing.clear();
    state.cardNodes.clear();
  }

  function openPanel() {
    if (!modal) return;
    if (MR.modal.isOpen(modal)) {
      if (queryInput) queryInput.focus();
      return;
    }

    state.open = true;
    populateSelects();
    MR.modal.open(modal, {
      initialFocus: queryInput || undefined,
      onClose: cleanupSearch,
    });
    runSearch();
  }

  function closePanel() {
    if (modal) MR.modal.close(modal);
  }

  function resetFilters() {
    if (queryInput) queryInput.value = "";
    if (genreInput) genreInput.value = "";
    if (countrySelect) countrySelect.value = "";
    if (languageSelect) languageSelect.value = "";
    runSearch();
    if (queryInput) queryInput.focus();
  }

  /* ------------------------------------------------------------------------
     Инициализация
     ------------------------------------------------------------------------ */

  function init() {
    modal = dom.$("#modal-search");
    if (!modal) return;

    modalBody = modal.querySelector(".modal__body");
    queryInput = dom.$("#search-query", modal);
    countrySelect = dom.$("#search-country", modal);
    genreInput = dom.$("#search-genre", modal);
    languageSelect = dom.$("#search-language", modal);
    resultsList = dom.$("#search-results", modal);
    emptyNode = dom.$("#search-empty", modal);
    countLabel = dom.$("#search-count", modal);
    statusNode = dom.$("#search-status", modal);
    errorNode = dom.$("#search-error", modal);
    clearButton = dom.$("#search-clear", modal);
    viewButtons = dom.$$("[data-search-view]", modal);

    populateSelects();

    MR.commands.register("search:open", openPanel);

    if (queryInput) queryInput.addEventListener("input", debouncedSearch);
    if (genreInput) genreInput.addEventListener("input", debouncedSearch);
    if (countrySelect) countrySelect.addEventListener("change", runSearch);
    if (languageSelect) languageSelect.addEventListener("change", runSearch);
    if (clearButton) clearButton.addEventListener("click", resetFilters);

    viewButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        state.view = button.dataset.searchView === "grid" ? "grid" : "list";
        render();
      });
    });

    if (resultsList) {
      resultsList.addEventListener("click", function (event) {
        const toggle = event.target.closest("[data-search-add-toggle]");
        if (toggle && !toggle.disabled) {
          toggleGroupMenu(toggle, Number(toggle.dataset.searchIndex));
          return;
        }

        const button = event.target.closest("[data-search-add]");
        if (!button || button.disabled) return;
        addResult(Number(button.dataset.searchIndex));
      });
    }

    // Esc и клик вне: слушатели ставятся до открытия модалки, поэтому
    // перехватывают Esc раньше её собственного обработчика.
    documentOffs.push(dom.on(document, "keydown", onDocumentKeydown, true));
    documentOffs.push(dom.on(document, "click", onDocumentClick));
    documentOffs.push(dom.on(global, "resize", onViewportChange));
    if (modalBody) documentOffs.push(dom.on(modalBody, "scroll", onPanelScroll, true));

    offStations = store.on("stations", syncAddedStates);
  }

  function dispose() {
    cleanupSearch();
    if (offStations) offStations();
    offStations = null;
    while (documentOffs.length) {
      const off = documentOffs.pop();
      if (typeof off === "function") off();
    }
    if (addMenu && addMenu.parentNode) addMenu.parentNode.removeChild(addMenu);
    addMenu = null;
    addMenuPanel = null;
    MR.radioSearch.dispose();
  }

  MR.stationSearch = {
    init: init,
    dispose: dispose,
    open: openPanel,
    close: closePanel,
    get isOpen() { return Boolean(modal && MR.modal.isOpen(modal)); },
  };
})(window);
