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
      dom.el("div", { class: "search-card__side" }, dot, addButton)
    );

    state.cardNodes.set(key, {
      card: card,
      dot: dot,
      button: addButton,
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

    const errors = result.errors || {};
    const message = errors.general || errors.name || errors.sources ||
      Object.keys(errors).map(function (key) { return errors[key]; })[0] ||
      "Не удалось добавить станцию.";
    MR.toast.error(message);
  }

  /* ------------------------------------------------------------------------
     Открытие и закрытие
     ------------------------------------------------------------------------ */

  function cleanupSearch() {
    state.open = false;
    state.seq += 1;

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
        const button = event.target.closest("[data-search-add]");
        if (!button || button.disabled) return;
        addResult(Number(button.dataset.searchIndex));
      });
    }

    offStations = store.on("stations", syncAddedStates);
  }

  function dispose() {
    cleanupSearch();
    if (offStations) offStations();
    offStations = null;
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
