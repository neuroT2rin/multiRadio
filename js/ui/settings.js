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
  let fileInput = null;
  let versionLabel = null;
  let storageLabel = null;

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

  function handleFile(file) {
    if (!file) return;

    const reader = new FileReader();

    reader.onload = function (event) {
      let data = null;
      try {
        data = JSON.parse(String(event.target.result));
      } catch (error) {
        MR.toast.error("Файл не похож на JSON: " + error.message);
        return;
      }

      const result = store.importData(data);
      if (!result.ok) {
        MR.toast.error("Импорт не выполнен: " + result.error);
        return;
      }

      renderStorage();
      MR.toast.success(
        "Импортировано: " + result.counts.stations + " " +
        utils.pluralRu(result.counts.stations, "station") + ", " +
        result.counts.groups + " " + utils.pluralRu(result.counts.groups, "group") + "."
      );
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
    fileInput = dom.$("#import-file");
    versionLabel = dom.$("#settings-version");
    storageLabel = dom.$("#settings-storage");
    if (!modal) return;

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
    });

    syncControls();
  }

  MR.settingsUI = {
    init: init,
    open: open,
  };
})(window);
