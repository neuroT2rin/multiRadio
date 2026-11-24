/**
 * ui/settings.js — настройки, импорт/экспорт и сброс данных.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const config = MR.config;
  const utils = MR.utils;

  let modal = null;
  let bgCheckbox = null;
  let modeSelect = null;
  let compatCheckbox = null;
  let bufferCheckbox = null;
  let bufferMinutesSelect = null;
  let fileInput = null;
  let versionLabel = null;
  let storageLabel = null;
  let importModal = null;
  let importWarning = null;
  let importResolve = null;
  let dropZone = null;
  let dragDepth = 0;

  const JSON_WARNING = "Нужен JSON-файл с настройками.";

  function hasFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === "Files") return true;
    }
    return false;
  }

  function isJsonFile(file) {
    if (!file) return false;
    return /\.json$/i.test(file.name || "") || file.type === "application/json";
  }

  function pickJsonFile(files) {
    if (!files || !files.length) return null;
    for (let i = 0; i < files.length; i += 1) {
      if (isJsonFile(files[i])) return files[i];
    }
    return null;
  }

  /** Подсветка зоны импорта, пока файл ведут над открытыми настройками. */
  function updateDropHint(target) {
    if (!dropZone) return;
    const overModal = Boolean(modal && MR.modal.isOpen(modal) && target && modal.contains(target));
    dropZone.classList.toggle("is-dragover", overModal);
  }

  function clearDropHint() {
    if (dropZone) dropZone.classList.remove("is-dragover");
  }

  /** Сброс переноса: счётчик глубины и подсветка зоны импорта. */
  function resetDrag() {
    dragDepth = 0;
    clearDropHint();
  }

  function onDragEnter(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();

    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    dragDepth += 1;
  }

  function onDragOver(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();

    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    // Если dragenter потерялся при быстром движении — считаем, что файл уже над окном.
    if (dragDepth === 0) dragDepth = 1;
    updateDropHint(event.target);
  }

  function onDragLeave(event) {
    // relatedTarget === null — курсор ушёл за пределы окна.
    if (!event.relatedTarget) {
      resetDrag();
      return;
    }

    if (dragDepth === 0) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) clearDropHint();
  }

  function onDrop(event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    resetDrag();

    // Пока открыт выбор режима импорта, новые файлы игнорируем.
    if (importModal && MR.modal.isOpen(importModal)) return;

    const file = pickJsonFile(event.dataTransfer && event.dataTransfer.files);
    if (!file) {
      MR.toast.warning(JSON_WARNING);
      return;
    }

    handleFile(file);
  }

  function renderStorage() {
    if (!storageLabel) return;
    const bytes = MR.storage.size(config.storageKey);
    if (MR.storage.isAvailable()) {
      storageLabel.textContent = bytes > 0 ? utils.formatBytes(bytes) + " · localStorage" : "пусто · localStorage";
    } else {
      storageLabel.textContent = "в памяти · localStorage недоступен";
    }
  }

  function syncControls() {
    if (bgCheckbox) bgCheckbox.checked = Boolean(store.state.ui.bgEnabled);
    if (modeSelect) modeSelect.value = store.state.ui.mode;
    if (compatCheckbox) compatCheckbox.checked = Boolean(store.state.ui.compatMode);

    const bufferEnabled = store.state.ui.bufferEnabled !== false;
    if (bufferCheckbox) bufferCheckbox.checked = bufferEnabled;
    if (bufferMinutesSelect) {
      bufferMinutesSelect.value = String(store.state.ui.bufferMinutes);
      bufferMinutesSelect.disabled = !bufferEnabled;
    }

    renderStorage();
  }

  function open() {
    syncControls();
    MR.modal.open(modal);
  }

  function downloadJson(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = "multiradio-settings-" + date + ".json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportSettings() {
    const data = store.exportData();
    data.exportedAt = new Date().toISOString();
    downloadJson(data);
    renderStorage();
    MR.toast.success("Настройки экспортированы в JSON-файл.");
  }

  function askImportMode(preview) {
    return new Promise(function (resolve) {
      importResolve = resolve;

      if (importWarning) {
        importWarning.textContent =
          "В файле: " + preview.stations + " " +
          utils.pluralRu(preview.stations, "station") + " и " +
          preview.groups + " " + utils.pluralRu(preview.groups, "group") + ". " +
          "Сейчас сохранено: " + store.state.stations.length + " " +
          utils.pluralRu(store.state.stations.length, "station") + " и " +
          store.state.groups.length + " " +
          utils.pluralRu(store.state.groups.length, "group") + ". " +
          "«Заменить» сотрёт текущие станции и группы.";
      }

      MR.modal.open(importModal);
    });
  }

  function settleImport(mode) {
    const resolve = importResolve;
    importResolve = null;

    if (importModal) MR.modal.close(importModal);
    if (resolve) resolve(mode);
  }

  function handleFile(file) {
    if (!file) return;

    const reader = new FileReader();

    reader.onload = async function (event) {
      let data = null;
      try {
        data = JSON.parse(String(event.target.result));
      } catch (error) {
        MR.toast.error("Файл не похож на JSON: " + error.message);
        return;
      }

      const version = Number(data && data.version);
      if (version !== 1 && version !== 2) {
        MR.toast.error("Неподдерживаемая версия файла: " + ((data && data.version) || "—"));
        return;
      }

      const preview = {
        stations: Array.isArray(data.stations) ? data.stations.length : 0,
        groups: Array.isArray(data.groups) ? data.groups.length : 0,
      };

      const mode = await askImportMode(preview);
      if (!mode) return;

      const result = store.importData(data, { mode });
      if (!result.ok) {
        MR.toast.error("Импорт не выполнен: " + result.error);
        return;
      }

      renderStorage();

      if (mode === "merge") {
        MR.toast.success(
          "Объединено: +" + result.counts.stations + " " +
          utils.pluralRu(result.counts.stations, "station") + ", групп: " +
          result.counts.groups + "."
        );
      } else {
        MR.toast.success(
          "Заменено: " + result.counts.stations + " " +
          utils.pluralRu(result.counts.stations, "station") + ", " +
          result.counts.groups + " " + utils.pluralRu(result.counts.groups, "group") + "."
        );
      }
    };

    reader.onerror = function () {
      MR.toast.error("Не удалось прочитать файл.");
    };

    reader.readAsText(file);
  }

  async function resetAll() {
    const confirmed = await MR.modal.confirm({
      title: "Сбросить всё?",
      message: "Будут удалены добавленные станции, группы, избранное и настройки звука. Вернутся восемь стандартных станций.",
      confirmLabel: "Сбросить",
      cancelLabel: "Отмена",
      danger: true,
    });

    if (!confirmed) return;

    if (store.state.playback.stationId) MR.audio.stop();
    store.resetAll();
    syncControls();
    MR.toast.success("Настройки сброшены к стандартным.");
  }

  async function restoreStations() {
    const confirmed = await MR.modal.confirm({
      title: "Вернуть стандартные станции?",
      message: "Список станций будет заменён восемью встроенными. Свои станции будут удалены, группы и избранное сохранятся, если их станции остались.",
      confirmLabel: "Вернуть станции",
      cancelLabel: "Отмена",
      danger: false,
    });

    if (!confirmed) return;

    if (store.state.playback.stationId) MR.audio.stop();
    store.restoreDefaultStations();
    renderStorage();
    MR.toast.success("Стандартный список восстановлен.");
  }

  function init() {
    modal = dom.$("#modal-settings");
    bgCheckbox = dom.$("#setting-bg");
    modeSelect = dom.$("#setting-mode");
    compatCheckbox = dom.$("#setting-compat");
    bufferCheckbox = dom.$("#setting-buffer");
    bufferMinutesSelect = dom.$("#setting-buffer-minutes");
    fileInput = dom.$("#import-file");
    versionLabel = dom.$("#settings-version");
    storageLabel = dom.$("#settings-storage");
    importModal = dom.$("#modal-import");
    importWarning = dom.$("#import-warning");
    dropZone = dom.$("#import-drop");
    if (!modal) return;

    // Единый глобальный путь: JSON можно бросить в любое место окна.
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);

    if (importModal) {
      const cancel = dom.$("#import-cancel");
      const merge = dom.$("#import-merge");
      const replace = dom.$("#import-replace");
      const backdrop = importModal.querySelector(".modal__backdrop");

      if (cancel) cancel.addEventListener("click", function () { settleImport(null); });
      if (merge) merge.addEventListener("click", function () { settleImport("merge"); });
      if (replace) replace.addEventListener("click", function () { settleImport("replace"); });
      if (backdrop) backdrop.addEventListener("click", function () { settleImport(null); });
      importModal.addEventListener("keydown", function (event) {
        if (event.key === "Escape") settleImport(null);
      });
    }

    MR.commands.registerMany({
      "settings:open": open,
      "settings:export": exportSettings,
      "settings:import": function () {
        if (fileInput) fileInput.click();
      },
      "settings:reset": resetAll,
      "settings:restore-stations": restoreStations,
    });

    if (versionLabel) versionLabel.textContent = config.version;

    if (bgCheckbox) {
      bgCheckbox.addEventListener("change", function () {
        store.setBgEnabled(bgCheckbox.checked);
      });
    }

    if (modeSelect) {
      modeSelect.addEventListener("change", function () {
        store.setVisualizerMode(modeSelect.value);
      });
    }

    if (compatCheckbox) {
      compatCheckbox.addEventListener("change", function () {
        store.setCompatMode(compatCheckbox.checked);
        MR.toast.info(
          compatCheckbox.checked
            ? "Режим совместимости включён: звук без Web Audio."
            : "Режим совместимости выключен: эквалайзер и спектр вернутся при следующем запуске потока."
        );
      });
    }

    if (bufferCheckbox) {
      bufferCheckbox.addEventListener("change", function () {
        const enabled = store.setBufferEnabled(bufferCheckbox.checked);
        if (bufferMinutesSelect) bufferMinutesSelect.disabled = !enabled;
        MR.toast.info(
          enabled
            ? "Буфер эфира включён: храним последние " + store.state.ui.bufferMinutes + " мин."
            : "Буфер эфира выключен: память освобождена."
        );
      });
    }

    if (bufferMinutesSelect) {
      bufferMinutesSelect.addEventListener("change", function () {
        store.setBufferMinutes(Number(bufferMinutesSelect.value));
      });
    }

    if (fileInput) {
      fileInput.addEventListener("change", function (event) {
        const file = event.target.files && event.target.files[0];
        handleFile(file);
        fileInput.value = "";
      });
    }

    store.on("ui", function () {
      if (bgCheckbox) bgCheckbox.checked = Boolean(store.state.ui.bgEnabled);
      if (modeSelect) modeSelect.value = store.state.ui.mode;
      if (compatCheckbox) compatCheckbox.checked = Boolean(store.state.ui.compatMode);
      if (bufferCheckbox) bufferCheckbox.checked = store.state.ui.bufferEnabled !== false;
      if (bufferMinutesSelect) {
        bufferMinutesSelect.value = String(store.state.ui.bufferMinutes);
        bufferMinutesSelect.disabled = store.state.ui.bufferEnabled === false;
      }
    });

    syncControls();
  }

  MR.settingsUI = {
    init: init,
    open: open,
  };
})(window);
