/**
 * ui/station-form.js — добавление и редактирование станции в одном окне.
 * Источники редактируются списком: у каждой ссылки свой битрейт, поэтому
 * внутри одной станции можно держать потоки разного качества.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const config = MR.config;

  const FIELD_IDS = {
    name: "st-name",
    genre: "st-genre",
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
  let sourcesList = null;
  let addSourceButton = null;
  let editingId = null;

  function sourceRows() {
    return sourcesList ? dom.$$(".source-row", sourcesList) : [];
  }

  function fieldFor(key) {
    if (FIELD_IDS[key]) return dom.$("#" + FIELD_IDS[key], modal);

    if (key === "sources") {
      const first = sourceRows()[0];
      return first ? first.querySelector('[data-field="url"]') : null;
    }

    const match = /^sources\.(\d+)\.(url|bitrate)$/.exec(key);
    if (match) {
      const row = sourceRows()[Number(match[1])];
      return row ? row.querySelector('[data-field="' + match[2] + '"]') : null;
    }

    return null;
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

  function createSourceRow(source) {
    const data = source || {};

    const url = dom.el("input", {
      class: "input source-row__url",
      type: "url",
      autocomplete: "off",
      placeholder: "https://example.com/stream.mp3",
      attrs: { inputmode: "url" },
    });
    url.dataset.field = "url";
    url.value = data.url || "";

    const bitrate = dom.el("input", {
      class: "input source-row__bitrate",
      type: "number",
      step: "1",
      placeholder: "128",
      attrs: {
        min: String(config.audio.minBitrate),
        max: String(config.audio.maxBitrate),
        inputmode: "numeric",
        list: "bitrate-options",
      },
    });
    bitrate.dataset.field = "bitrate";
    bitrate.value = data.bitrate ? String(data.bitrate) : "";

    const remove = dom.el("button", {
      class: "icon-btn icon-btn--sm source-row__remove",
      type: "button",
      text: "✕",
      title: "Удалить источник",
    });

    const urlError = dom.el("p", { class: "field__error source-row__error" });
    const bitrateError = dom.el("p", { class: "field__error source-row__error" });

    return dom.el("div", { class: "source-row" },
      url,
      dom.el("span", { class: "source-row__rate" },
        bitrate,
        dom.el("span", { class: "source-row__unit", text: "kbps" })
      ),
      remove,
      urlError,
      bitrateError
    );
  }

  function reindexRows() {
    const rows = sourceRows();
    const max = config.audio.maxSources;

    rows.forEach(function (row, index) {
      row.dataset.sourceIndex = String(index);

      const url = row.querySelector('[data-field="url"]');
      const bitrate = row.querySelector('[data-field="bitrate"]');
      const remove = row.querySelector(".source-row__remove");
      const errors = row.querySelectorAll(".source-row__error");

      if (url) url.setAttribute("aria-label", "URL источника " + (index + 1));
      if (bitrate) {
        bitrate.setAttribute("aria-label", "Битрейт источника " + (index + 1) + ", кбит/с");
      }
      if (remove) {
        remove.setAttribute("aria-label", "Удалить источник " + (index + 1));
        remove.disabled = rows.length === 1;
      }
      if (errors[0]) errors[0].setAttribute("data-error-for", "sources." + index + ".url");
      if (errors[1]) errors[1].setAttribute("data-error-for", "sources." + index + ".bitrate");
    });

    if (addSourceButton) addSourceButton.disabled = rows.length >= max;
  }

  function renderSources(sources) {
    if (!sourcesList) return;
    sourcesList.innerHTML = "";

    const list = Array.isArray(sources) && sources.length ? sources : [{ url: "", bitrate: 0 }];
    list.slice(0, config.audio.maxSources).forEach(function (source) {
      sourcesList.appendChild(createSourceRow(source));
    });

    reindexRows();
  }

  function addSource() {
    if (sourceRows().length >= config.audio.maxSources) return;
    sourcesList.appendChild(createSourceRow({ url: "", bitrate: 0 }));
    reindexRows();

    const rows = sourceRows();
    const last = rows[rows.length - 1];
    const input = last ? last.querySelector('[data-field="url"]') : null;
    if (input) input.focus();
  }

  function removeSource(button) {
    if (sourceRows().length <= 1) return;
    const row = button.closest(".source-row");
    if (!row) return;
    row.remove();
    clearErrors();
    reindexRows();
  }

  function collectSources() {
    return sourceRows().map(function (row) {
      const url = row.querySelector('[data-field="url"]');
      const bitrate = row.querySelector('[data-field="bitrate"]');
      return {
        url: url ? url.value.trim() : "",
        bitrate: bitrate ? bitrate.value : "",
      };
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
      ? "Изменения сохранятся сразу; играет источник с максимальным битрейтом."
      : "У каждой ссылки свой битрейт — играет лучший из доступных.";
    submitButton.textContent = station ? "Сохранить" : "Добавить";
    deleteButton.hidden = !station;

    const group = station ? store.getGroupOfStation(station.id) : null;
    const preselectedGroup = station ? (group ? group.id : "") : (store.state.filters.groupId || "");

    dom.$("#st-name", modal).value = station ? station.name : "";
    dom.$("#st-emoji", modal).value = station ? station.emoji : "📻";
    dom.$("#st-genre", modal).value = station ? station.genre : "";
    renderSources(station ? station.sources : []);

    fillGroupOptions(preselectedGroup);
    MR.modal.open(modal, { initialFocus: dom.$("#st-name", modal) });
  }

  function collect() {
    return {
      name: dom.$("#st-name", modal).value,
      emoji: dom.$("#st-emoji", modal).value,
      genre: dom.$("#st-genre", modal).value,
      sources: collectSources(),
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
      MR.audio.playStation(station.id);
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
    sourcesList = dom.$("#st-sources");
    addSourceButton = dom.$("#st-add-source");
    if (!modal || !form) return;

    MR.commands.register("station:add", function () { open({ mode: "add" }); });

    form.addEventListener("submit", handleSubmit);
    deleteButton.addEventListener("click", handleDelete);

    if (addSourceButton) addSourceButton.addEventListener("click", addSource);

    if (sourcesList) {
      sourcesList.addEventListener("click", function (event) {
        const button = event.target.closest(".source-row__remove");
        if (button) removeSource(button);
      });

      sourcesList.addEventListener("input", function (event) {
        const field = event.target;
        if (!field || !field.dataset || !field.dataset.field) return;

        field.removeAttribute("aria-invalid");
        const row = field.closest(".source-row");
        if (row) {
          const key = "sources." + row.dataset.sourceIndex + "." + field.dataset.field;
          const errorNode = dom.$('[data-error-for="' + key + '"]', modal);
          if (errorNode) errorNode.textContent = "";
        }

        const general = dom.$('[data-error-for="sources"]', modal);
        if (general) general.textContent = "";
        if (summary) {
          summary.hidden = true;
          summary.textContent = "";
        }
      });
    }

    // Живое снятие ошибки при редактировании статического поля.
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
