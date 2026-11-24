/**
 * ui/stations.js — списки станций, поиск, фильтры, избранное.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;

  const REASONS = {
    timeout: "таймаут",
    "media-error": "поток не открылся",
    offline: "нет сети",
    "invalid-url": "некорректный адрес",
    "no-url": "нет адреса",
  };

  let list = null;
  let favoritesList = null;
  let empty = null;
  let favoritesEmpty = null;
  let countLabel = null;
  let searchInput = null;
  let favoritesChip = null;
  let groupChip = null;
  let groupChipName = null;
  let viewButtons = [];
  let renderQueued = false;

  function applyViewMode() {
    const isGrid = store.state.ui.stationView === "grid";
    [list, favoritesList].forEach(function (node) {
      if (!node) return;
      node.classList.toggle("stations-list--grid", isGrid);
    });
    viewButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.stationView === store.state.ui.stationView));
    });
  }

  function bitrateSummary(station) {
    const values = store.getStationSources(station)
      .map(function (source) { return source.bitrate; })
      .filter(Boolean);
    if (!values.length) return "битрейт не указан";
    const max = Math.max.apply(null, values);
    const unique = Array.from(new Set(values));
    return unique.length > 1 ? "до " + max + " kbps" : max + " kbps";
  }

  function healthInfo(station) {
    const health = store.getHealth(station.id);
    if (!health) {
      if (store.state.healthProgress.running) {
        return { state: "checking", title: "Проверяется…" };
      }
      return { state: "unknown", title: "Ещё не проверялась" };
    }

    const probes = Array.isArray(health.sources) ? health.sources : [];
    if (!probes.length) return { state: "unknown", title: "Нет источников для проверки" };

    const sources = store.getStationSources(station);
    const order = store.getPlaybackOrder(station);
    const bestIndex = order[0];
    const bestProbe = probes[bestIndex];
    const bestBitrate = store.getStationBitrate(station);
    const bestLabel = bestBitrate ? "Источник " + bestBitrate + " kbps" : "Лучший источник";

    if (bestProbe && bestProbe.ok) {
      return { state: "online", title: bestLabel + " отвечает" };
    }

    const workingIndex = order.find(function (index) {
      return probes[index] && probes[index].ok;
    });

    if (workingIndex !== undefined) {
      const workingBitrate = sources[workingIndex] ? sources[workingIndex].bitrate : 0;
      const workingLabel = workingBitrate ? workingBitrate + " kbps" : "резервный";
      return {
        state: "fallback",
        title: (bestBitrate ? bestBitrate + " kbps" : "Лучший источник") +
          " не отвечает, доступен " + workingLabel,
      };
    }

    const reason = bestProbe && bestProbe.reason;
    return {
      state: "offline",
      title: "Источники недоступны" + (reason ? " · " + (REASONS[reason] || reason) : ""),
    };
  }

  function createRow(station) {
    const playback = store.state.playback;
    const isActive = playback.stationId === station.id;
    const isFavorite = store.state.favorites.has(station.id);
    const group = store.getGroupOfStation(station.id);
    const health = healthInfo(station);

    const nameLine = dom.el("span", { class: "station-row__name" },
      dom.el("span", { text: station.name }),
      group ? dom.el("span", { class: "station-row__group", text: group.name }) : null
    );

    const main = dom.el("button", {
      class: "station-row__main",
      type: "button",
      "data-command": "station:play",
      "data-station-id": station.id,
      "aria-label": (isActive ? "Пауза или продолжение: " : "Включить станцию: ") + station.name + ".",
      title: isActive ? "Пауза / продолжить" : "Включить станцию",
    },
      dom.el("span", { class: "station-row__emoji", "aria-hidden": "true" }, station.emoji),
      dom.el("span", { class: "station-row__body" },
        nameLine,
        dom.el("span", { class: "station-row__meta" },
          station.genre + " · " + bitrateSummary(station))
      )
    );

    const healthDot = dom.el("span", {
      class: "health-dot",
      "data-health": health.state,
      role: "img",
      title: health.title,
      "aria-label": health.title,
    });

    const favoriteButton = dom.el("button", {
      class: "icon-btn icon-btn--sm fav-btn",
      type: "button",
      "data-command": "station:favorite",
      "data-station-id": station.id,
      "aria-pressed": String(isFavorite),
      "aria-label": isFavorite ? "Убрать из избранного" : "Добавить в избранное",
      title: isFavorite ? "Убрать из избранного" : "В избранное",
    }, "★");

    const editButton = dom.el("button", {
      class: "icon-btn icon-btn--sm",
      type: "button",
      "data-command": "station:edit",
      "data-station-id": station.id,
      "aria-label": "Редактировать станцию " + station.name,
      title: "Редактировать",
    }, "✎");

    const row = dom.el("li", {
      class: "station-row" + (isActive ? " is-active" : ""),
      "data-station-id": station.id,
    }, main, dom.el("div", { class: "station-row__actions" },
      healthDot,
      favoriteButton,
      editButton
    ));

    return row;
  }

  function updateEmptyState(container, visible, total, message) {
    if (!container) return;
    const title = container.querySelector(".empty-state__title");
    const text = container.querySelector(".empty-state__text");
    const isEmpty = visible.length === 0;
    container.hidden = !isEmpty;
    if (!isEmpty) return;

    if (total === 0) {
      if (title) title.textContent = "Пока нет станций";
      if (text) text.textContent = "Добавьте свою станцию: понадобится адрес потока и, по желанию, резервные адреса.";
    } else {
      if (title) title.textContent = message.title;
      if (text) text.textContent = message.text;
    }
  }

  function render() {
    if (!list) return;

    const all = store.state.stations;
    const visible = store.getVisibleStations();
    const favorites = all.filter(function (station) {
      return store.state.favorites.has(station.id);
    });

    list.innerHTML = "";
    const fragment = document.createDocumentFragment();
    visible.forEach(function (station) { fragment.appendChild(createRow(station)); });
    list.appendChild(fragment);

    if (favoritesList) {
      favoritesList.innerHTML = "";
      const favFragment = document.createDocumentFragment();
      favorites.forEach(function (station) { favFragment.appendChild(createRow(station)); });
      favoritesList.appendChild(favFragment);
    }

    let emptyMessage = { title: "Ничего не найдено", text: "Попробуйте изменить запрос или сбросить фильтры." };
    if (store.state.filters.favoritesOnly) {
      emptyMessage = { title: "В избранном пусто", text: "Нажмите ★ у станции — она появится здесь." };
    } else if (store.state.filters.groupId) {
      const group = store.getGroup(store.state.filters.groupId);
      emptyMessage = {
        title: "В группе пусто",
        text: group ? "Добавьте станции в группу «" + group.name + "»." : "Группа не найдена.",
      };
    }

    updateEmptyState(empty, visible, all.length, emptyMessage);
    updateEmptyState(favoritesEmpty, favorites, all.length, emptyMessage);

    if (countLabel) {
      const filtered = store.state.filters.favoritesOnly || store.state.filters.groupId ||
        store.state.filters.query;
      const text = filtered
        ? visible.length + " из " + all.length + " " + utils.pluralRu(all.length, "station")
        : all.length + " " + utils.pluralRu(all.length, "station");
      countLabel.textContent = text;
    }

    if (searchInput && document.activeElement !== searchInput &&
        searchInput.value !== store.state.filters.query) {
      searchInput.value = store.state.filters.query;
    }

    if (favoritesChip) {
      favoritesChip.setAttribute("aria-pressed", String(store.state.filters.favoritesOnly));
    }

    if (groupChip && groupChipName) {
      const group = store.getGroup(store.state.filters.groupId);
      groupChip.hidden = !group;
      if (group) groupChipName.textContent = group.name;
    }

    applyViewMode();
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      render();
    });
  }

  function init() {
    list = dom.$("#stations-list");
    favoritesList = dom.$("#favorites-list");
    empty = dom.$("#stations-empty");
    favoritesEmpty = dom.$("#favorites-empty");
    countLabel = dom.$("#stations-count");
    searchInput = dom.$("#stations-search");
    favoritesChip = dom.$("#filter-favorites");
    groupChip = dom.$("#group-filter-chip");
    groupChipName = dom.$("#group-filter-name");
    viewButtons = dom.$$(".view-switch__btn");
    if (!list) return;

    MR.commands.registerMany({
      "station:play": function (payload) {
        const stationId = payload && payload.dataset ? payload.dataset.stationId : "";
        if (!stationId) return;
        const playback = store.state.playback;
        if (playback.stationId === stationId && playback.isPlaying) {
          MR.audio.toggle();
        } else {
          MR.audio.playStation(stationId);
        }
      },
      "station:favorite": function (payload) {
        const stationId = payload && payload.dataset ? payload.dataset.stationId : "";
        if (stationId) store.toggleFavorite(stationId);
      },
      "station:edit": function (payload) {
        const stationId = payload && payload.dataset ? payload.dataset.stationId : "";
        if (stationId) MR.stationForm.open({ mode: "edit", stationId: stationId });
      },
      "filter:favorites": function () {
        store.setFilters({ favoritesOnly: !store.state.filters.favoritesOnly });
      },
      "stations:view": function (payload) {
        const view = payload && payload.dataset ? payload.dataset.stationView : "";
        if (view) store.setStationView(view);
      },
    });

    if (searchInput) {
      const applySearch = utils.debounce(function (value) {
        store.setFilters({ query: value });
      }, 150);
      searchInput.addEventListener("input", function (event) {
        applySearch(event.target.value);
      });
    }

    store.on("stations", scheduleRender);
    store.on("favorites", scheduleRender);
    store.on("groups", scheduleRender);
    store.on("filters", scheduleRender);
    store.on("playback", scheduleRender);
    store.on("health", scheduleRender);
    store.on("ui", applyViewMode);

    render();
  }

  MR.stationsUI = {
    init: init,
    render: render,
  };
})(window);
