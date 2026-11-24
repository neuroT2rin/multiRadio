/**
 * ui/groups.js — создание, редактирование и фильтрация групп станций.
 *
 * Исправляет прежние проблемы:
 *  • создание через prompt() и «тихие» дубликаты;
 *  • рассинхрон station.stationIds и state.stationGroups;
 *  • фильтр группы не переключал вкладку и не отображался в списке.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;

  let container = null;
  let empty = null;
  let modal = null;
  let form = null;
  let nameInput = null;
  let checklist = null;
  let submitButton = null;
  let deleteButton = null;
  let shareButton = null;
  let title = null;
  let subtitle = null;
  let errorBox = null;
  let editingId = null;
  let searchInput = null;
  let query = "";
  /** id группы, у которой раскрыт список станций (не более одной). */
  let expandedGroupId = null;

  /* ------------------------------------------------------------------------
     Модальное окно
     ------------------------------------------------------------------------ */

  function buildChecklist(selectedIds) {
    checklist.innerHTML = "";

    if (store.state.stations.length === 0) {
      checklist.appendChild(dom.el("p", { class: "field__hint", text: "Сначала добавьте хотя бы одну станцию." }));
      return;
    }

    const selected = new Set(selectedIds || []);

    store.state.stations.forEach(function (station) {
      const input = dom.el("input", {
        type: "checkbox",
        value: station.id,
        checked: selected.has(station.id),
      });

      const label = dom.el("label", { class: "check-item" },
        input,
        dom.el("span", { text: station.emoji + " " + station.name })
      );

      checklist.appendChild(label);
    });
  }

  function clearErrors() {
    const nameError = dom.$('[data-error-for="name"]', modal);
    if (nameError) nameError.textContent = "";
    if (nameInput) nameInput.removeAttribute("aria-invalid");
    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = "";
    }
  }

  function showErrors(errors) {
    const nameError = dom.$('[data-error-for="name"]', modal);
    if (nameError) nameError.textContent = errors.name || "";
    if (nameInput) {
      if (errors.name) nameInput.setAttribute("aria-invalid", "true");
      else nameInput.removeAttribute("aria-invalid");
    }

    if (errors.general) {
      errorBox.hidden = false;
      errorBox.textContent = errors.general;
    }

    if (errors.name) nameInput.focus();
  }

  function openEditor(groupId) {
    editingId = groupId || null;
    const group = groupId ? store.getGroup(groupId) : null;

    if (groupId && !group) {
      MR.toast.error("Группа не найдена — возможно, её уже удалили.");
      return;
    }

    title.textContent = group ? "Редактировать группу" : "Создать группу";
    subtitle.textContent = group
      ? "Переименуйте группу или измените состав станций."
      : "Название и станции, которые войдут в группу.";
    nameInput.value = group ? group.name : "";
    submitButton.textContent = group ? "Сохранить" : "Создать";
    deleteButton.hidden = !group;
    if (shareButton) {
      shareButton.hidden = !group;
      if (group) shareButton.dataset.groupId = group.id;
      else delete shareButton.dataset.groupId;
    }

    clearErrors();
    buildChecklist(group ? group.stationIds : []);

    MR.modal.open(modal, { initialFocus: nameInput });
  }

  function closeEditor() {
    editingId = null;
    MR.modal.close(modal);
  }

  function collectInput() {
    const stationIds = dom.$$('input[type="checkbox"]:checked', checklist).map(function (input) {
      return input.value;
    });
    return { name: nameInput.value, stationIds: stationIds };
  }

  function handleSubmit(event) {
    event.preventDefault();

    const input = collectInput();
    const result = editingId
      ? store.updateGroup(editingId, input)
      : store.addGroup(input);

    if (!result.ok) {
      showErrors(result.errors || {});
      return;
    }

    const name = result.group.name;
    const wasEditing = Boolean(editingId);
    closeEditor();

    MR.toast.success(
      wasEditing ? "Группа «" + name + "» обновлена." : "Группа «" + name + "» создана.",
      { timeout: 2800 }
    );
  }

  async function confirmDelete(group) {
    if (!group) return;

    const confirmed = await MR.modal.confirm({
      title: "Удалить группу?",
      message: "Группа «" + group.name + "» будет удалена. Сами станции останутся в общем списке.",
      confirmLabel: "Удалить группу",
      cancelLabel: "Оставить",
      danger: true,
    });

    if (!confirmed) return;

    if (store.deleteGroup(group.id)) {
      MR.toast.success("Группа «" + group.name + "» удалена.");
    }
  }

  /* ------------------------------------------------------------------------
     Список групп
     ------------------------------------------------------------------------ */

  function createGroupCard(group) {
    const stations = group.stationIds
      .map(function (stationId) { return store.findStation(stationId); })
      .filter(Boolean);

    const isFiltered = store.state.filters.groupId === group.id;

    const filterButton = dom.el("button", {
      class: "icon-btn icon-btn--sm",
      type: "button",
      "data-command": "group:filter",
      "data-group-id": group.id,
      "aria-pressed": String(isFiltered),
      "aria-label": isFiltered ? "Сбросить фильтр группы " + group.name : "Показать станции группы " + group.name,
      title: isFiltered ? "Сбросить фильтр" : "Показать станции",
    }, isFiltered ? "◉" : "◎");

    const actions = dom.el("div", { class: "group-card__actions" },
      filterButton,
      dom.el("button", {
        class: "icon-btn icon-btn--sm",
        type: "button",
        "data-command": "group:edit",
        "data-group-id": group.id,
        "aria-label": "Редактировать группу " + group.name,
        title: "Редактировать",
      }, "✎"),
      dom.el("button", {
        class: "icon-btn icon-btn--sm",
        type: "button",
        "data-command": "group:delete",
        "data-group-id": group.id,
        "aria-label": "Удалить группу " + group.name,
        title: "Удалить",
      }, "🗑")
    );

    const isExpanded = expandedGroupId === group.id;
    const bodyId = "group-body-" + group.id;

    const toggle = dom.el("button", {
      class: "group-card__toggle",
      type: "button",
      "data-command": "group:toggle",
      "data-group-id": group.id,
      "aria-expanded": String(isExpanded),
      "aria-controls": bodyId,
      title: isExpanded ? "Скрыть станции группы" : "Показать станции группы",
    },
      dom.el("span", { class: "group-card__chev", "aria-hidden": "true" }, "▸"),
      dom.el("span", { class: "group-card__name", text: group.name }),
      dom.el("span", {
        class: "group-card__count",
        text: stations.length + " " + utils.pluralRu(stations.length, "station"),
      })
    );

    const head = dom.el("div", { class: "group-card__head" }, toggle, actions);

    let body;
    if (stations.length === 0) {
      body = dom.el("p", {
        class: "group-card__empty",
        id: bodyId,
        hidden: !isExpanded,
        text: "Пока пусто — добавьте станции.",
      });
    } else {
      body = dom.el("div", {
        class: "group-card__stations",
        id: bodyId,
        hidden: !isExpanded,
      },
        stations.map(function (station) {
          return dom.el("span", { class: "group-station" },
            dom.el("span", { text: station.emoji + " " + station.name }),
            dom.el("button", {
              class: "group-station__remove",
              type: "button",
              "data-command": "group:remove-station",
              "data-group-id": group.id,
              "data-station-id": station.id,
              "aria-label": "Убрать «" + station.name + "» из группы",
              title: "Убрать из группы",
            }, "✕")
          );
        })
      );
    }

    return dom.el("article", {
      class: "group-card" + (isFiltered ? " is-filtered" : "") + (isExpanded ? " is-expanded" : ""),
      "data-group-id": group.id,
    }, head, body);
  }

  function setEmptyText(titleText, textText) {
    if (!empty) return;
    const title = empty.querySelector(".empty-state__title");
    const text = empty.querySelector(".empty-state__text");
    if (title) title.textContent = titleText;
    if (text) text.textContent = textText;
  }

  function render() {
    if (!container) return;

    if (expandedGroupId && !store.getGroup(expandedGroupId)) {
      expandedGroupId = null;
    }

    const all = store.state.groups;

    if (searchInput) {
      searchInput.hidden = all.length <= 10;
      if (all.length <= 10 && query) {
        query = "";
        searchInput.value = "";
      }
    }

    const groups = query
      ? all.filter(function (group) { return group.name.toLowerCase().indexOf(query) !== -1; })
      : all;

    container.innerHTML = "";
    container.style.maxHeight = "";
    container.classList.remove("is-scrollable");

    if (empty) {
      if (all.length === 0) {
        empty.hidden = false;
        setEmptyText(
          "Групп ещё нет",
          "Создайте группу «Для работы», «Вечер» или любую другую — и фильтруйте станции одним кликом."
        );
      } else if (groups.length === 0) {
        empty.hidden = false;
        setEmptyText("Группы не найдены", "Измените поисковый запрос.");
      } else {
        empty.hidden = true;
      }
    }

    if (groups.length === 0) return;

    const fragment = document.createDocumentFragment();
    groups.forEach(function (group) {
      fragment.appendChild(createGroupCard(group));
    });
    container.appendChild(fragment);

    // Больше пяти групп — показываем пять и включаем прокрутку.
    if (groups.length > 5) {
      const cards = container.querySelectorAll(".group-card");
      if (cards.length > 5) {
        const listRect = container.getBoundingClientRect();
        const fifthRect = cards[4].getBoundingClientRect();
        container.style.maxHeight = Math.ceil(fifthRect.bottom - listRect.top) + "px";
        container.classList.add("is-scrollable");
      }
    }
  }

  /* ------------------------------------------------------------------------
     Команды
     ------------------------------------------------------------------------ */

  function toggleGroupFilter(groupId) {
    if (!store.getGroup(groupId)) {
      MR.toast.error("Группа не найдена.");
      return;
    }

    if (store.state.filters.groupId === groupId) {
      store.setFilters({ groupId: null });
      return;
    }

    // Фильтр имеет смысл только на вкладке станций.
    store.setView("stations");
    store.setFilters({ favoritesOnly: false, groupId: groupId });
  }

  function init() {
    container = dom.$("#groups-list");
    empty = dom.$("#groups-empty");
    modal = dom.$("#modal-group");
    form = dom.$("#group-form");
    nameInput = dom.$("#gr-name");
    checklist = dom.$("#group-station-options");
    submitButton = dom.$("#group-submit");
    deleteButton = dom.$("#group-delete");
    shareButton = dom.$("#group-share");
    title = dom.$("#group-modal-title");
    subtitle = dom.$("#group-modal-subtitle");
    errorBox = dom.$("#group-form-error");
    searchInput = dom.$("#groups-search");
    if (!container || !modal) return;

    if (searchInput) {
      const applyQuery = utils.debounce(function (value) {
        query = String(value || "").trim().toLowerCase();
        render();
      }, 120);
      searchInput.addEventListener("input", function (event) {
        applyQuery(event.target.value);
      });
    }

    const titleElement = dom.$("#group-modal-title");
    if (titleElement) titleElement.setAttribute("aria-live", "polite");

    MR.commands.registerMany({
      "group:create": function () { openEditor(null); },
      "group:edit": function (payload) {
        const groupId = payload && payload.dataset ? payload.dataset.groupId : "";
        if (groupId) openEditor(groupId);
      },
      "group:delete": function (payload) {
        const groupId = payload && payload.dataset ? payload.dataset.groupId : "";
        const group = store.getGroup(groupId);
        if (group) confirmDelete(group);
      },
      "group:filter": function (payload) {
        const groupId = payload && payload.dataset ? payload.dataset.groupId : "";
        if (groupId) toggleGroupFilter(groupId);
      },
      "group:toggle": function (payload) {
        const groupId = payload && payload.dataset ? payload.dataset.groupId : "";
        if (!groupId || !store.getGroup(groupId)) return;
        // Одновременно раскрыта не более чем одна группа.
        expandedGroupId = expandedGroupId === groupId ? null : groupId;
        render();
      },
      "group:clear-filter": function () {
        store.setFilters({ groupId: null });
      },
      "group:remove-station": function (payload) {
        const dataset = (payload && payload.dataset) || {};
        if (!dataset.groupId || !dataset.stationId) return;
        if (store.removeStationFromGroup(dataset.stationId, dataset.groupId)) {
          const station = store.findStation(dataset.stationId);
          MR.toast.info("«" + (station ? station.name : "Станция") + "» убрана из группы.", { timeout: 2400 });
        }
      },
    });

    form.addEventListener("submit", handleSubmit);

    if (deleteButton) {
      deleteButton.addEventListener("click", function () {
        const group = editingId ? store.getGroup(editingId) : null;
        closeEditor();
        if (group) confirmDelete(group);
      });
    }

    store.on("groups", render);
    store.on("stations", render);
    store.on("filters", render);

    render();
  }

  MR.groupsUI = {
    init: init,
    render: render,
    openEditor: openEditor,
  };
})(window);
