/**
 * ui/station-form.js — добавление и редактирование станции в одном окне.
 * Заменяет цепочку prompt(), которая ломала форму и не проверяла URL.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;

  const FIELD_IDS = {
    name: "st-name",
    genre: "st-genre",
    bitrate: "st-bitrate",
    primary: "st-primary",
    fallbacks: "st-fallbacks",
    groupId: "st-group",
  };

  let modal = null;
  let form = null;
  let title = null;
  let subtitle = null;
  let submitButton = null;
  let deleteButton = null;
  let groupSelect = null;
  let summary = null;
  let editingId = null;

  function fieldFor(key) {
    const id = FIELD_IDS[key];
    return id ? dom.$("#" + id, modal) : null;
  }

  function clearErrors() {
    dom.$$("[data-error-for]", modal).forEach(function (node) { node.textContent = ""; });
    dom.$$("[aria-invalid]", modal).forEach(function (node) { node.removeAttribute("aria-invalid"); });
    if (summary) {
      summary.hidden = true;
      summary.textContent = "";
    }
  }

  function showErrors(errors) {
    clearErrors();
    let firstInvalid = null;

    Object.keys(errors || {}).forEach(function (key) {
      if (key === "general") {
        if (summary) {
          summary.hidden = false;
          summary.textContent = errors.general;
        }
        return;
      }

      const errorNode = dom.$('[data-error-for="' + key + '"]', modal);
      if (errorNode) errorNode.textContent = errors[key];

      const field = fieldFor(key);
      if (field) {
        field.setAttribute("aria-invalid", "true");
        if (!firstInvalid) firstInvalid = field;
      }
    });

    if (firstInvalid) firstInvalid.focus();
  }

  function fillGroupOptions(selectedId) {
    if (!groupSelect) return;
    groupSelect.innerHTML = "";
    groupSelect.appendChild(dom.el("option", { value: "", text: "Без группы" }));

    store.state.groups.forEach(function (group) {
      groupSelect.appendChild(dom.el("option", {
        value: group.id,
        text: group.name,
        selected: group.id === selectedId,
      }));
    });
  }

  function open(options) {
    const opts = options || {};
    const mode = opts.mode === "edit" ? "edit" : "add";
    const station = mode === "edit" ? store.findStation(opts.stationId) : null;

    if (mode === "edit" && !station) {
      MR.toast.error("Станция не найдена.");
      return;
    }

    editingId = station ? station.id : null;
    clearErrors();

    title.textContent = station ? "Редактировать станцию" : "Добавить станцию";
    subtitle.textContent = station
      ? "Изменения сохранятся сразу, поток можно перезапустить."
      : "Основной поток и резервные источники.";
    submitButton.textContent = station ? "Сохранить" : "Добавить";
    deleteButton.hidden = !station;

    const group = station ? store.getGroupOfStation(station.id) : null;
    const preselectedGroup = station ? (group ? group.id : "") : (store.state.filters.groupId || "");

    dom.$("#st-name", modal).value = station ? station.name : "";
    dom.$("#st-emoji", modal).value = station ? station.emoji : "📻";
    dom.$("#st-genre", modal).value = station ? station.genre : "";
    dom.$("#st-bitrate", modal).value = station ? station.bitrate : "";
    dom.$("#st-primary", modal).value = station ? station.primary : "";
    dom.$("#st-fallbacks", modal).value = station ? station.fallbacks.join("\n") : "";

    fillGroupOptions(preselectedGroup);
    MR.modal.open(modal, { initialFocus: dom.$("#st-name", modal) });
  }

  function collect() {
    return {
      name: dom.$("#st-name", modal).value,
      emoji: dom.$("#st-emoji", modal).value,
      genre: dom.$("#st-genre", modal).value,
      bitrate: dom.$("#st-bitrate", modal).value,
      primary: dom.$("#st-primary", modal).value,
      fallbacks: utils.parseUrlList(dom.$("#st-fallbacks", modal).value),
      groupId: groupSelect ? groupSelect.value : "",
    };
  }

  function highlightCreatedStation(stationId) {
    requestAnimationFrame(function () {
      const row = document.querySelector('.station-row[data-station-id="' + stationId + '"]');
      if (row) row.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  function handleSubmit(event) {
    event.preventDefault();

    const input = collect();
    const result = editingId
      ? store.updateStation(editingId, input)
      : store.addStation(input);

    if (!result.ok) {
      showErrors(result.errors || {});
      return;
    }

    const wasEditing = Boolean(editingId);
    const station = result.station;
    const streamChanged = Boolean(result.streamChanged);

    MR.modal.close(modal);
    editingId = null;

    MR.toast.success(
      wasEditing ? "Станция «" + station.name + "» сохранена." : "Станция «" + station.name + "» добавлена.",
      { timeout: 2800 }
    );

    if (!wasEditing) {
      // Новая станция должна быть видна, даже если включён фильтр.
      store.setView("stations");
      store.setFilters({ favoritesOnly: false, groupId: null, query: "" });
      highlightCreatedStation(station.id);
      return;
    }

    if (streamChanged && store.state.playback.stationId === station.id && store.state.playback.isPlaying) {
      store.setPlayback({ status: "connecting", urlIndex: 0, url: station.primary });
      MR.audio.playStation(station.id, { urlIndex: 0 });
      MR.toast.info("Поток изменился — воспроизведение перезапущено.");
    }
  }

  async function handleDelete() {
    if (!editingId) return;

    const station = store.findStation(editingId);
    if (!station) {
      MR.modal.close(modal);
      return;
    }

    const stationId = editingId;

    // Сначала закрываем форму, затем спрашиваем подтверждение.
    MR.modal.close(modal);
    editingId = null;

    const confirmed = await MR.modal.confirm({
      title: "Удалить станцию?",
      message: "Станция «" + station.name + "» будет удалена из списка, избранного и групп.",
      confirmLabel: "Удалить станцию",
      cancelLabel: "Оставить",
      danger: true,
    });

    if (!confirmed) return;

    if (store.state.playback.stationId === stationId) {
      MR.audio.stop();
    }

    if (store.removeStation(stationId)) {
      MR.toast.success("Станция «" + station.name + "» удалена.");
    }
  }

  function init() {
    modal = dom.$("#modal-station");
    form = dom.$("#station-form");
    title = dom.$("#station-modal-title");
    subtitle = dom.$("#station-modal-subtitle");
    submitButton = dom.$("#station-submit");
    deleteButton = dom.$("#station-delete");
    groupSelect = dom.$("#st-group");
    summary = dom.$("#station-form-error");
    if (!modal || !form) return;

    MR.commands.register("station:add", function () { open({ mode: "add" }); });

    form.addEventListener("submit", handleSubmit);
    deleteButton.addEventListener("click", handleDelete);

    // Живое снятие ошибки при редактировании поля.
    form.addEventListener("input", function (event) {
      const field = event.target;
      if (!field || !field.id) return;
      field.removeAttribute("aria-invalid");
      const key = Object.keys(FIELD_IDS).find(function (name) { return FIELD_IDS[name] === field.id; });
      if (!key) return;
      const errorNode = dom.$('[data-error-for="' + key + '"]', modal);
      if (errorNode) errorNode.textContent = "";
    });
  }

  MR.stationForm = {
    init: init,
    open: open,
  };
})(window);
