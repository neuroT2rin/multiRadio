/**
 * tests/browser-smoke.js — дымовой тест в Chrome через CDP.
 * Запуск: node tests/browser-smoke.js <url> <ws-endpoint> <screenshots-dir>
 */
"use strict";

const fs = require("fs");
const path = require("path");

const pageUrl = process.argv[2];
const wsEndpoint = process.argv[3];
const shotsDir = process.argv[4] || path.join(__dirname, "screenshots");

fs.mkdirSync(shotsDir, { recursive: true });

const consoleErrors = [];
const exceptions = [];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || "").join(" "));
      }
      if (message.method === "Runtime.exceptionThrown") {
        exceptions.push(message.params.exceptionDetails.text + " " +
          (message.params.exceptionDetails.exception && message.params.exceptionDetails.exception.description || ""));
      }
    });
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP timeout: " + method));
        }
      }, 15000);
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Генерирует WAV data-URL, чтобы проверить звук и анализатор без сети. */
function makeWavDataUrl(seconds, sampleRate) {
  const total = Math.floor(seconds * sampleRate);
  const buffer = Buffer.alloc(44 + total * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + total * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(total * 2, 40);

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const pulse = 0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * t);
    const sample = (Math.sin(2 * Math.PI * 110 * t) * 0.22 +
      Math.sin(2 * Math.PI * 440 * t) * 0.12 +
      Math.sin(2 * Math.PI * 1800 * t) * 0.05) * pulse;
    buffer.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
  }

  return "data:audio/wav;base64," + buffer.toString("base64");
}

async function main() {
  // /json/version отдаёт браузерный endpoint, которому недоступен Runtime.*.
  // Если пришёл он — берём WebSocket страницы из /json/list.
  let endpoint = wsEndpoint;
  if (/\/devtools\/browser\//.test(endpoint)) {
    try {
      const httpBase = endpoint.replace(/^ws/, "http").replace(/\/devtools\/browser\/.*$/, "");
      const response = await fetch(httpBase + "/json/list");
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page && page.webSocketDebuggerUrl) endpoint = page.webSocketDebuggerUrl;
    } catch (error) {
      console.error("Не удалось получить страницу из /json/list:", error.message);
    }
  }

  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });

  await cdp.send("Page.navigate", { url: pageUrl });
  await sleep(2500);

  async function evaluate(expression) {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error("Eval failed: " + result.exceptionDetails.text +
        " :: " + (result.exceptionDetails.exception && result.exceptionDetails.exception.description));
    }
    return result.result.value;
  }

  async function screenshot(name) {
    const result = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(shotsDir, name), Buffer.from(result.data, "base64"));
  }

  const results = {};
  global.__smokeResults = results;

  results.initial = await evaluate(`(() => ({
    title: document.title,
    rows: document.querySelectorAll('#stations-list .station-row').length,
    bands: document.querySelectorAll('#eq-controls .eq-band').length,
    presets: document.querySelectorAll('#eq-presets .eq-preset').length,
    groups: document.querySelectorAll('#groups-list .group-card').length,
    modeChecked: document.querySelector('.nav-item[data-mode="spectrum"]').getAttribute('aria-checked'),
    vizToggle: Boolean(document.querySelector('#viz-toggle')),
    visualizerPanel: Boolean(document.querySelector('.visualizer-card')),
    progressExists: Boolean(document.querySelector('#health-progress')),
    networkState: document.querySelector('#network-badge').dataset.state,
    streamStatus: document.querySelector('#stream-status').dataset.state,
    miniSize: (() => { const c = document.querySelector('#mini-canvas'); return c ? [c.width, c.height] : null; })(),
  }))()`);

  await screenshot("desktop.png");

  // Меню
  await evaluate(`document.querySelector('.nav-btn').click()`);
  await sleep(200);
  results.navOpen = await evaluate(`(() => {
    const group = document.querySelector('.nav-group');
    return { open: group.classList.contains('is-open'),
             expanded: group.querySelector('.nav-btn').getAttribute('aria-expanded'),
             visible: group.querySelector('.nav-menu').getBoundingClientRect().height > 40 };
  })()`);
  await screenshot("menu.png");
  await evaluate(`document.body.click()`);

  // Создание группы
  await evaluate(`document.querySelector('[data-command="group:create"]').click()`);
  await sleep(200);
  results.groupModal = await evaluate(`(() => ({
    open: !document.querySelector('#modal-group').hidden,
    title: document.querySelector('#group-modal-title').textContent,
    checkboxes: document.querySelectorAll('#group-station-options input').length,
  }))()`);

  await evaluate(`(() => {
    const name = document.querySelector('#gr-name');
    name.value = 'Вечерний чилл';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelectorAll('#group-station-options input')[0].checked = true;
    document.querySelector('#group-submit').click();
  })()`);
  await sleep(300);
  results.groupCreated = await evaluate(`(() => ({
    modalClosed: document.querySelector('#modal-group').hidden,
    cards: document.querySelectorAll('#groups-list .group-card').length,
    name: document.querySelector('.group-card__name')?.textContent || '',
    collapsedChips: document.querySelectorAll('.group-card__stations:not([hidden]) .group-station').length,
    ariaExpanded: document.querySelector('.group-card__toggle').getAttribute('aria-expanded'),
    toasts: document.querySelectorAll('.toast--success').length,
  }))()`);

  // Аккордеон: по умолчанию станции скрыты, раскрываются кликом по группе.
  await evaluate(`document.querySelector('.group-card__toggle').click()`);
  await sleep(150);
  results.groupExpanded = await evaluate(`(() => ({
    chips: document.querySelectorAll('.group-station').length,
    expanded: document.querySelector('.group-card').classList.contains('is-expanded'),
    ariaExpanded: document.querySelector('.group-card__toggle').getAttribute('aria-expanded'),
  }))()`);

  // Фильтр группы
  await evaluate(`document.querySelector('.group-card [data-command="group:filter"]').click()`);
  await sleep(300);
  results.groupFilter = await evaluate(`(() => ({
    chipHidden: document.querySelector('#group-filter-chip').hidden,
    chipName: document.querySelector('#group-filter-name').textContent,
    rows: document.querySelectorAll('#stations-list .station-row').length,
    view: document.querySelector('#tab-stations').getAttribute('aria-selected'),
  }))()`);
  await evaluate(`document.querySelector('#group-filter-chip').click()`);
  await sleep(200);

  // Панель групп: прокрутка после 5, поиск после 10
  await evaluate(`(() => {
    for (let i = 0; i < 5; i += 1) MR.store.addGroup({ name: "Тест-группа " + i, stationIds: [] });
  })()`);
  results.groupsScroll = await evaluate(`(() => {
    const list = document.querySelector('#groups-list');
    return {
      scrollable: list.classList.contains('is-scrollable'),
      maxHeight: list.style.maxHeight,
      searchHidden: document.querySelector('#groups-search').hidden,
      cards: document.querySelectorAll('#groups-list .group-card').length,
    };
  })()`);

  await evaluate(`(() => {
    for (let i = 5; i < 10; i += 1) MR.store.addGroup({ name: "Тест-группа " + i, stationIds: [] });
  })()`);
  results.groupsSearch = await evaluate(`(() => ({
    visible: !document.querySelector('#groups-search').hidden,
    total: MR.store.state.groups.length,
  }))()`);

  await evaluate(`(() => {
    const input = document.querySelector('#groups-search');
    input.value = "Тест-группа 9";
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(220);
  results.groupsFiltered = await evaluate(`document.querySelectorAll('#groups-list .group-card').length`);

  await evaluate(`(() => {
    const input = document.querySelector('#groups-search');
    input.value = "";
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(180);

  // Валидация и добавление станции: у каждой ссылки свой битрейт
  await evaluate(`document.querySelector('[data-command="station:add"]').click()`);
  await sleep(200);
  await evaluate(`(() => {
    document.querySelector('#st-name').value = 'Тестовая станция';
    document.querySelector('#st-sources .source-row [data-field="url"]').value = 'ftp://bad';
    document.querySelector('#station-submit').click();
  })()`);
  await sleep(200);
  results.stationValidation = await evaluate(`(() => ({
    error: document.querySelector('[data-error-for="sources.0.url"]').textContent,
    invalid: document.querySelector('#st-sources .source-row [data-field="url"]').getAttribute('aria-invalid'),
  }))()`);

  await evaluate(`(() => {
    const rows = document.querySelectorAll('#st-sources .source-row');
    rows[0].querySelector('[data-field="url"]').value = 'https://example.com/stream.mp3';
    rows[0].querySelector('[data-field="bitrate"]').value = '320';
    document.querySelector('#st-add-source').click();
    const next = document.querySelectorAll('#st-sources .source-row')[1];
    next.querySelector('[data-field="url"]').value = 'https://example.com/stream2.mp3';
    next.querySelector('[data-field="bitrate"]').value = '128';
  })()`);
  await sleep(150);
  await screenshot("station-form.png");
  await evaluate(`document.querySelector('#station-submit').click()`);
  await sleep(400);
  results.stationAdded = await evaluate(`(() => {
    const station = MR.store.state.stations.find((item) => item.name === 'Тестовая станция');
    return {
      rows: document.querySelectorAll('#stations-list .station-row').length,
      modalClosed: document.querySelector('#modal-station').hidden,
      hasNew: [...document.querySelectorAll('.station-row__name')].some(el => el.textContent.includes('Тестовая')),
      sources: station ? station.sources.length : 0,
      bestBitrate: station ? MR.store.getStationBitrate(station) : 0,
      order: station ? MR.store.getPlaybackSources(station).map((source) => source.bitrate) : [],
    };
  })()`);

  // При запуске выбирается источник с максимальным битрейтом.
  results.bestBitratePlayback = await evaluate(`(() => {
    const station = MR.store.state.stations.find((item) => item.name === 'Тестовая станция');
    MR.audio.playStation(station.id);
    const playback = MR.store.state.playback;
    const result = {
      urlIndex: playback.urlIndex,
      bitrate: playback.bitrate,
      url: playback.url,
      label: playback.sourceLabel,
      ordered: MR.store.getPlaybackSources(station).map((source) => source.bitrate),
    };
    MR.audio.stop();
    return result;
  })()`);

  // Вид списка: плитка ↔ список
  results.stationViews = await evaluate(`(() => {
    const gridBtn = document.querySelector('[data-command="stations:view"][data-station-view="grid"]');
    const listBtn = document.querySelector('[data-command="stations:view"][data-station-view="list"]');
    gridBtn.click();
    const grid = document.querySelector('#stations-list').classList.contains('stations-list--grid');
    const gridPressed = gridBtn.getAttribute('aria-pressed');
    listBtn.click();
    return {
      grid: grid,
      gridPressed: gridPressed,
      backToList: !document.querySelector('#stations-list').classList.contains('stations-list--grid'),
    };
  })()`);

  // Эквалайзер
  await evaluate(`document.querySelector('#tab-equalizer').click()`);
  await sleep(300);
  results.eq = await evaluate(`(() => ({
    panelVisible: !document.querySelector('#panel-equalizer').hidden,
    bands: document.querySelectorAll('#eq-controls .eq-band').length,
    sliders: document.querySelectorAll('.eq-band__slider').length,
    presets: document.querySelectorAll('#eq-presets .eq-preset').length,
  }))()`);
  await screenshot("equalizer.png");
  await evaluate(`document.querySelector('#tab-stations').click()`);

  // Фон: переключатель теперь живёт только в меню «Вид».
  results.bg = await evaluate(`(() => {
    const toggle = document.querySelector('.nav-item[data-command="ui:toggle-bg"]');
    const before = toggle.getAttribute('aria-checked');
    toggle.click();
    return { before, after: toggle.getAttribute('aria-checked'),
             hiddenClass: document.querySelector('#bg-visualizer').classList.contains('is-hidden') };
  })()`);
  await evaluate(`document.querySelector('.nav-item[data-command="ui:toggle-bg"]').click()`);

  // Режимы визуализации потока: переключение из меню и отрисовка в каждом.
  results.miniModes = await evaluate(`(() => {
    const fake = {
      active: true, silent: false, level: 0.7, bass: 0.6, treble: 0.4,
      spectrum: Array.from({ length: 64 }, (_, i) => 0.2 + 0.6 * Math.abs(Math.sin(i * 0.4))),
      wave: new Uint8Array(1024).fill(128),
    };
    const canvas = document.querySelector('#mini-canvas');
    const ctx = canvas.getContext('2d');
    const pixels = () => {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
      return count;
    };

    const drawn = {};
    ['ribbon', 'sparkle', 'wave'].forEach((mode) => {
      document.querySelector('.nav-item[data-command="ui:mini-mode"][data-mini-mode="' + mode + '"]').click();
      MR.mini.draw(fake);
      drawn[mode] = pixels();
    });

    return {
      drawn: drawn,
      state: MR.store.state.ui.miniMode,
      checked: document.querySelector('.nav-item[data-command="ui:mini-mode"][data-mini-mode="wave"]').getAttribute('aria-checked'),
    };
  })()`);

  // Фоновые режимы: каждая ветка background.js рисует пиксели.
  results.bgModes = await evaluate(`(() => {
    const modes = MR.config.visualizerModes.slice();
    const fake = {
      active: true, silent: false, level: 0.5, bass: 0.4, treble: 0.35, beat: false,
      spectrum: Array.from({ length: 64 }, (_, i) => 0.3 + 0.4 * Math.abs(Math.sin(i * 0.3))),
      wave: new Uint8Array(1024).fill(128),
    };
    const canvas = document.querySelector('#bg-canvas');
    const ctx = canvas.getContext('2d');
    const drawn = {};
    const applied = {};

    modes.forEach((mode) => {
      MR.store.setVisualizerMode(mode);
      MR.bg.draw(fake, 16, performance.now());
      applied[mode] = MR.bg.mode;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
      drawn[mode] = count;
    });

    MR.store.setVisualizerMode('spectrum');
    return {
      drawn: drawn,
      applied: applied,
      tunnelFilled: drawn.tunnel > 0 && applied.tunnel === 'tunnel',
      menuItems: document.querySelectorAll('.nav-item[data-mode]').length,
      settingsOptions: document.querySelectorAll('#setting-mode option').length,
    };
  })()`);

  // Режим «Голос»: пункт меню, aria-checked, отрисовка (не пустой canvas).
  results.voiceMode = await evaluate(`(() => {
    const item = document.querySelector('.nav-item[data-command="ui:mode"][data-mode="voice"]');
    item.click();

    const fake = {
      active: true, silent: false, level: 0.45, bass: 0.2, mid: 0.55, treble: 0.4, beat: false,
      spectrum: Array.from({ length: 64 }, (_, i) => 0.15 + 0.55 * Math.abs(Math.sin(i * 0.5 + 0.7))),
      wave: new Uint8Array(1024).fill(128).map((_, i) => 128 + Math.round(46 * Math.sin(i * 0.09))),
    };
    const canvas = document.querySelector('#bg-canvas');
    const ctx = canvas.getContext('2d');
    MR.bg.draw(fake, 16, performance.now());

    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let pixels = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) pixels += 1;

    return {
      checked: item.getAttribute('aria-checked'),
      checkedCount: document.querySelectorAll('.nav-item[data-command="ui:mode"][aria-checked="true"]').length,
      state: MR.store.state.ui.mode,
      mode: MR.bg.mode,
      pixels: pixels,
      canvas: [canvas.width, canvas.height],
      empty: pixels === 0,
    };
  })()`);
  await screenshot("voice.png");
  await evaluate(`document.querySelector('.nav-item[data-command="ui:mode"][data-mode="spectrum"]').click()`);

  // Режим визуализации: страница скрыта, остаются «Вид» и «Визуализация».
  results.vizMode = await evaluate(`(() => {
    const toggle = document.querySelector('#viz-toggle');
    const before = toggle.getBoundingClientRect().left;
    toggle.click();
    const after = toggle.getBoundingClientRect().left;
    const radioGroup = document.querySelector('.nav-group:not(.nav-group--view)');
    return {
      buttonShift: Math.round((after - before) * 100) / 100,
      bodyClass: document.body.classList.contains('is-viz-mode'),
      pressed: document.querySelector('#viz-toggle').getAttribute('aria-pressed'),
      mainHidden: getComputedStyle(document.querySelector('#main')).display === 'none',
      footerHidden: getComputedStyle(document.querySelector('.app-footer')).display === 'none',
      brandHidden: getComputedStyle(document.querySelector('.brand')).display === 'none',
      viewVisible: getComputedStyle(document.querySelector('.nav-group--view')).display !== 'none',
      radioHidden: getComputedStyle(radioGroup).display === 'none',
      bgVisible: !document.querySelector('#bg-visualizer').classList.contains('is-hidden'),
    };
  })()`);
  await sleep(400);
  await screenshot("viz-mode.png");
  results.vizModeExit = await evaluate(`(() => {
    document.querySelector('#viz-toggle').click();
    return {
      bodyClass: document.body.classList.contains('is-viz-mode'),
      pressed: document.querySelector('#viz-toggle').getAttribute('aria-pressed'),
      mainBack: getComputedStyle(document.querySelector('#main')).display !== 'none',
    };
  })()`);

  // Настройки
  await evaluate(`document.querySelector('[data-command="settings:open"]').click()`);
  await sleep(250);
  results.settings = await evaluate(`(() => ({
    open: !document.querySelector('#modal-settings').hidden,
    version: document.querySelector('#settings-version').textContent,
    storage: document.querySelector('#settings-storage').textContent,
    toggles: document.querySelectorAll('#modal-settings input').length,
  }))()`);
  await screenshot("settings.png");

  // Drag-and-drop импорта в открытые настройки
  await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify({ version: 2, stations: [], groups: [], favorites: [] })], "settings.json", { type: "application/json" }));
    document.querySelector("#modal-settings").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })
    );
  })()`);
  await sleep(350);
  results.importDrop = await evaluate(`(() => {
    const open = !document.querySelector('#modal-import').hidden;
    document.querySelector('#import-cancel').click();
    return { open: open, closed: document.querySelector('#modal-import').hidden };
  })()`);

  // Глобальный drag-and-drop: подсветка зоны импорта, без полноэкранного оверлея
  await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
    const zone = document.querySelector('#import-drop');
    zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
  await sleep(100);
  results.dropHint = await evaluate(`(() => ({
    noOverlay: !document.querySelector('#drop-overlay'),
    dropHint: document.querySelector('#import-drop').classList.contains('is-dragover'),
  }))()`);
  await screenshot("import-drop-hint.png");

  results.dropHintLeave = await evaluate(`(() => {
    document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }));
    return {
      noOverlay: !document.querySelector('#drop-overlay'),
      dropHint: document.querySelector('#import-drop').classList.contains('is-dragover'),
    };
  })()`);

  await evaluate(`document.querySelector('#modal-settings [data-close-modal]').click()`);
  await sleep(150);

  // Не-JSON: предупреждение, без изменения данных и без модалки импорта
  results.dropNonJson = await evaluate(`(() => {
    const before = MR.store.state.stations.length;
    const dt = new DataTransfer();
    dt.items.add(new File(["notes"], "notes.txt", { type: "text/plain" }));
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    document.body.dispatchEvent(event);
    const toast = document.querySelector('#toast-region .toast:last-child');
    return {
      before: before,
      after: MR.store.state.stations.length,
      prevented: event.defaultPrevented,
      noOverlay: !document.querySelector('#drop-overlay'),
      importHidden: document.querySelector('#modal-import').hidden,
      toastWarnsJson: Boolean(toast && toast.textContent.includes('JSON')),
    };
  })()`);

  // JSON в любое место страницы: открывается выбор режима импорта
  await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify({ version: 2, stations: [], groups: [], favorites: [] })], "settings.json", { type: "application/json" }));
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
  await sleep(350);
  results.dropJsonGlobal = await evaluate(`(() => {
    const open = !document.querySelector('#modal-import').hidden;
    document.querySelector('#import-cancel').click();
    return {
      open: open,
      closed: document.querySelector('#modal-import').hidden,
      noOverlay: !document.querySelector('#drop-overlay'),
      settingsClosed: document.querySelector('#modal-settings').hidden,
    };
  })()`);

  // Импорт: слияние не стирает текущие станции и группы
  results.importMerge = await evaluate(`(() => {
    const before = MR.store.state.stations.length;
    const result = MR.store.importData({
      version: 2,
      stations: [
        { id: "import-test", name: "Импорт-тест", genre: "Jazz", bitrate: "128 kbps", emoji: "🎷", primary: "https://example.com/import.mp3", fallbacks: [] },
      ],
      groups: [{ id: "import-group", name: "Импорт-группа", stationIds: ["import-test"] }],
      favorites: ["import-test"],
    }, { mode: "merge" });
    return {
      ok: result.ok,
      mode: result.mode,
      added: result.counts.stations,
      total: MR.store.state.stations.length,
      grew: MR.store.state.stations.length === before + 1,
      modal: Boolean(document.querySelector("#modal-import")),
      importedSources: ((MR.store.state.stations.find((item) => item.name === "Импорт-тест") || {}).sources || []).length,
    };
  })()`);

  // Светлая тема: переключение и возврат
  await evaluate(`document.querySelector('#theme-toggle').click()`);
  await sleep(350);
  results.theme = await evaluate(`(() => ({
    theme: document.documentElement.dataset.theme,
    pressed: document.querySelector('#theme-toggle').getAttribute('aria-pressed'),
    cardBg: getComputedStyle(document.querySelector('.card')).backgroundImage.includes('255, 255, 255'),
    status: MR.store.state.playback.status,
  }))()`);
  await screenshot("light.png");
  await evaluate(`document.querySelector('#theme-toggle').click()`);
  results.themeBack = await evaluate(`document.documentElement.dataset.theme`);

  // Голосовой поиск: локальный матчер без микрофона
  results.voiceSearch = await evaluate(`(() => ({
    supported: MR.voiceSearch.supported,
    jazz: (MR.voiceSearch.match('привет, хочу послушать джаз') || {}).name || null,
    calm: (MR.voiceSearch.match('что-нибудь спокойное для работы') || {}).name || null,
    rock: (MR.voiceSearch.match('включи рок') || {}).name || null,
  }))()`);

  // Таймер сна: запуск и отмена
  results.sleepTimer = await evaluate(`(() => {
    document.querySelector('[data-command="timer:start"][data-minutes="15"]').click();
    const started = document.querySelector('#sleep-timer-label').textContent;
    document.querySelector('[data-command="timer:cancel"]').click();
    return {
      started: started,
      cancelled: document.querySelector('#sleep-timer-label').textContent,
    };
  })()`);

  // Локальный звук: проверяем весь путь <audio> → Web Audio → анализатор → canvas.
  const wav = makeWavDataUrl(20, 8000);
  await evaluate(`(() => {
    const station = MR.store.state.stations[0];
    station.sources = [{ url: ${JSON.stringify(wav)}, bitrate: 128 }];
    MR.audio.playStation(station.id);
  })()`);

  let localState = "";
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    localState = await evaluate(`document.querySelector('#stream-status').dataset.state`);
    if (localState === "playing" || localState === "error" || localState === "blocked") break;
  }
  await sleep(700);

  results.localPlayback = await evaluate(`(() => {
    const analysis = MR.analyser.read(performance.now());
    const bg = document.querySelector('#bg-canvas');
    const bgCtx = bg.getContext('2d');
    const bgData = bgCtx.getImageData(Math.floor(bg.width / 2) - 80, Math.floor(bg.height * 0.46) - 80, 160, 160).data;
    let bgPixels = 0;
    for (let i = 3; i < bgData.length; i += 4) if (bgData[i] > 0) bgPixels += 1;

    const mini = document.querySelector('#mini-canvas');
    const miniCtx = mini.getContext('2d');
    const miniData = miniCtx.getImageData(0, 0, mini.width, mini.height).data;
    let miniPixels = 0;
    for (let i = 3; i < miniData.length; i += 4) if (miniData[i] > 0) miniPixels += 1;

    return {
      state: document.querySelector('#stream-status').dataset.state,
      label: document.querySelector('#stream-status').textContent,
      station: document.querySelector('#station-name').textContent,
      compat: MR.store.state.ui.compatMode,
      graphReady: MR.audio.isGraphReady,
      analyserAttached: MR.analyser.isAttached,
      level: Number(analysis.level.toFixed(3)),
      bass: Number(analysis.bass.toFixed(3)),
      eqBands: analysis.eqBands.map(v => Number(v.toFixed(2))),
      silent: analysis.silent,
      bgPixels,
      miniPixels,
      playerPlaying: document.querySelector('.player-card').classList.contains('is-playing'),
      bitrateChip: document.querySelector('#station-bitrate-chip').textContent,
      sourceChip: document.querySelector('#station-source-chip').textContent,
      playbackBitrate: MR.store.state.playback.bitrate,
      infoSources: document.querySelectorAll('#info-sources .info-source').length,
    };
  })()`);
  await screenshot("playing.png");

  // Карточка «Источники и сеть»: список источников с битрейтами и состоянием.
  results.infoSourcesLayout = await evaluate(`(() => {
    const node = document.querySelector('#info-sources');
    const rect = node.getBoundingClientRect();
    return {
      hidden: node.hidden,
      items: node.querySelectorAll('.info-source').length,
      top: Math.round(rect.top + window.scrollY),
      height: Math.round(rect.height),
      docHeight: document.documentElement.scrollHeight,
    };
  })()`);
  await evaluate(`(() => {
    const node = document.querySelector('#info-sources');
    const top = node.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - 320));
  })()`);
  await sleep(250);
  await screenshot("info-sources.png");
  results.infoSourcesScroll = await evaluate(`Math.round(window.scrollY)`);
  await evaluate(`window.scrollTo(0, 0)`);

  results.timemachineEarly = await evaluate(`({
    available: MR.timemachine.availableSeconds(),
    capturing: MR.timemachine.isCapturing(),
    status: MR.store.state.playback.status,
  })`);

  await evaluate(`document.querySelector('#theme-toggle').click()`);
  await sleep(300);
  await screenshot("light-playing.png");
  await evaluate(`document.querySelector('#theme-toggle').click()`);
  await sleep(200);

  results.eqDisabledAfterPlay = await evaluate(
    `[...document.querySelectorAll('.eq-band__slider')].filter(s => s.disabled).length`
  );

  results.timemachine = await evaluate(`(() => ({
    available: Math.round(MR.timemachine.availableSeconds()),
    capturing: MR.timemachine.isCapturing(),
    slider: Boolean(document.querySelector('#timemachine')),
    lagHidden: document.querySelector('#timemachine-lag').hidden,
  }))()`);

  results.timemachineRewind = await evaluate(`(async () => {
    const available = MR.timemachine.availableSeconds();
    const ok = available > 2 ? MR.timemachine.playFrom(1.5) : false;
    const slider = document.querySelector('#timemachine');
    const statusAfter = MR.store.state.playback.status;
    const buffered = MR.timemachine.isBuffered();
    const liveVisible = !document.querySelector('#timemachine-live').hidden;
    const maxBefore = Number(slider.max);
    const valueBefore = Number(slider.value);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const maxAfter = Number(slider.max);
    const valueAfter = Number(slider.value);
    MR.timemachine.returnLive();
    return {
      rewind: ok, buffered: buffered, liveVisible: liveVisible,
      statusAfter: statusAfter, maxBefore: maxBefore, valueBefore: valueBefore,
      maxAfter: maxAfter, valueAfter: valueAfter,
    };
  })()`);

  // Пауза сохраняет буфер: данные, позиция и активный ползунок остаются.
  await sleep(1200);
  await evaluate(`MR.audio.pause()`);
  await sleep(300);
  results.timemachinePause = await evaluate(`(() => {
    const slider = document.querySelector('#timemachine');
    return {
      status: MR.store.state.playback.status,
      available: Math.round(MR.timemachine.availableSeconds() * 10) / 10,
      capturing: MR.timemachine.isCapturing(),
      sliderDisabled: slider.disabled,
      sliderHidden: slider.hidden,
    };
  })()`);

  // Перемотка на паузе только готовит буфер, но не запускает звук.
  results.timemachineSeekPaused = await evaluate(`(() => {
    const available = MR.timemachine.availableSeconds();
    const ok = available >= 2 ? MR.timemachine.seek(2) : false;
    const slider = document.querySelector('#timemachine');
    const lag = document.querySelector('#timemachine-lag');
    return {
      ok: ok,
      available: Math.round(available * 10) / 10,
      buffered: MR.timemachine.isBuffered(),
      playing: MR.timemachine.isBufferPlaying(),
      status: MR.store.state.playback.status,
      rewind: Number(MR.timemachine.getRewind().toFixed(1)),
      liveVisible: !document.querySelector('#timemachine-live').hidden,
      sliderDisabled: slider.disabled,
      sliderHidden: slider.hidden,
      title: slider.title,
      lagVisible: !lag.hidden && lag.getBoundingClientRect().width > 0,
      lagText: lag.textContent,
      lagTitle: lag.getAttribute('title'),
      lagAria: lag.getAttribute('aria-label'),
    };
  })()`);

  // Play после паузы продолжает буфер с выбранного места.
  await evaluate(`MR.audio.toggle()`);
  await sleep(600);
  results.timemachineResume = await evaluate(`(() => ({
    playing: MR.timemachine.isBufferPlaying(),
    buffered: MR.timemachine.isBuffered(),
    status: MR.store.state.playback.status,
    liveVisible: !document.querySelector('#timemachine-live').hidden,
  }))()`);

  results.timemachineStop = await evaluate(`(() => {
    MR.timemachine.returnLive();
    const bufferedAfterReturn = MR.timemachine.isBuffered();
    const availableAfterReturn = Math.round(MR.timemachine.availableSeconds() * 10) / 10;
    const lagHiddenAfterReturn = document.querySelector('#timemachine-lag').hidden;
    MR.audio.stop();
    return {
      bufferedAfterReturn: bufferedAfterReturn,
      availableAfterReturn: availableAfterReturn,
      lagHiddenAfterReturn: lagHiddenAfterReturn,
      statusAfterStop: MR.store.state.playback.status,
      availableAfterStop: MR.timemachine.availableSeconds(),
      sliderHidden: document.querySelector('#timemachine').hidden,
    };
  })()`);

  // Регрессия: буфер продолжается за старой границей WAV, а не прыгает в live.
  // К этому месту буфер сброшен stop(), поэтому включаем локальный WAV заново.
  results.timemachineContinuousRestart = await evaluate(`(() => {
    const station = MR.store.state.stations[0];
    MR.audio.playStation(station.id);
    return { station: station.name, status: MR.store.state.playback.status };
  })()`);

  let continuousAvailable = 0;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    continuousAvailable = await evaluate(`MR.timemachine.availableSeconds()`);
    if (continuousAvailable >= 8) break;
  }

  // Инструментируем планировщик буфера: стыки сегментов должны быть бесшовными.
  await evaluate(`(() => {
    window.__tmSchedule = [];
    const proto = (window.AudioContext || window.webkitAudioContext).prototype;
    if (proto.__tmPatched) return true;
    proto.__tmPatched = true;
    const create = proto.createBufferSource;
    proto.createBufferSource = function () {
      const source = create.apply(this, arguments);
      const start = source.start.bind(source);
      source.start = function (when) {
        window.__tmSchedule.push({
          when: Number.isFinite(when) ? when : 0,
          duration: source.buffer ? source.buffer.duration : 0,
        });
        return start.apply(source, arguments);
      };
      return source;
    };
    return true;
  })()`);

  results.timemachineContinuousStart = await evaluate(`(() => {
    const ok = MR.timemachine.playFrom(2);
    const slider = document.querySelector('#timemachine');
    const lag = document.querySelector('#timemachine-lag');
    return {
      ok: ok,
      available: Math.round(MR.timemachine.availableSeconds() * 10) / 10,
      buffered: MR.timemachine.isBuffered(),
      playing: MR.timemachine.isBufferPlaying(),
      rewind: Number(MR.timemachine.getRewind().toFixed(2)),
      status: MR.store.state.playback.status,
      liveVisible: !document.querySelector('#timemachine-live').hidden,
      sliderMax: Number(slider.max),
      lagVisible: !lag.hidden,
      lagText: lag.textContent,
      lagTitle: lag.getAttribute('title'),
      lagAria: lag.getAttribute('aria-label'),
    };
  })()`);

  // Бейдж отставания: виден при активном буфере, не перекрывает ползунок и
  // кнопку LIVE, скрыт после возврата в эфир.
  await screenshot("timemachine-lag.png");
  results.timemachineLagLayout = await evaluate(`(() => {
    const lag = document.querySelector('#timemachine-lag');
    const live = document.querySelector('#timemachine-live');
    const slider = document.querySelector('#timemachine');
    const lagRect = lag.getBoundingClientRect();
    const liveRect = live.getBoundingClientRect();
    const sliderRect = slider.getBoundingClientRect();
    const visualizerRect = document.querySelector('.mini-visualizer').getBoundingClientRect();
    return {
      visible: !lag.hidden && lagRect.width > 0 && lagRect.height > 0,
      afterLive: lagRect.left >= liveRect.right - 1,
      aboveSlider: lagRect.bottom <= sliderRect.top,
      insideVisualizer: lagRect.left >= visualizerRect.left && lagRect.right <= visualizerRect.right,
      pointerEvents: getComputedStyle(lag).pointerEvents,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  })()`);

  // Узкий экран: бейдж остаётся в углу визуализатора и не создаёт скролл.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  });
  await sleep(300);
  results.timemachineLagMobile = await evaluate(`(() => {
    const lag = document.querySelector('#timemachine-lag');
    const live = document.querySelector('#timemachine-live');
    const slider = document.querySelector('#timemachine');
    const lagRect = lag.getBoundingClientRect();
    const liveRect = live.getBoundingClientRect();
    const sliderRect = slider.getBoundingClientRect();
    return {
      visible: !lag.hidden && lagRect.width > 0,
      text: lag.textContent,
      afterLive: lagRect.left >= liveRect.right - 1,
      aboveSlider: lagRect.bottom <= sliderRect.top,
      insideViewport: lagRect.right <= window.innerWidth,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  })()`);
  await screenshot("timemachine-lag-mobile.png");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(300);

  // Светлая тема: чип читаем и остаётся статичным (без анимаций).
  await evaluate(`document.querySelector('#theme-toggle').click()`);
  await sleep(250);
  results.timemachineLagLight = await evaluate(`(() => {
    const lag = document.querySelector('#timemachine-lag');
    const style = getComputedStyle(lag);
    return {
      theme: document.documentElement.dataset.theme,
      visible: !lag.hidden && lag.getBoundingClientRect().width > 0,
      color: style.color,
      background: style.backgroundColor,
      animation: style.animationName,
      transition: style.transitionDuration,
    };
  })()`);
  await screenshot("timemachine-lag-light.png");
  await evaluate(`document.querySelector('#theme-toggle').click()`);
  await sleep(200);

  // Первый сегмент был ≈2 с: через 3 с старая реализация уже ушла бы в live.  await sleep(3000);
  results.timemachineContinuousMid = await evaluate(`(() => ({
    buffered: MR.timemachine.isBuffered(),
    status: MR.store.state.playback.status,
    rewind: Number(MR.timemachine.getRewind().toFixed(2)),
  }))()`);

  // Транзиентная «буферизация» беззвучного эфира не должна выглядеть
  // прерыванием, пока звучит буфер.
  results.timemachineBufferingQuiet = await evaluate(`(() => {
    MR.store.setPlayback({ status: "buffering", isPlaying: true });
    return {
      buffered: MR.timemachine.isBuffered(),
      status: MR.store.state.playback.status,
      label: document.querySelector('#stream-status').textContent,
    };
  })()`);

  // Слушаем дольше длины первого сегмента (в сумме ≈9.3 с): лента должна
  // продолжаться без пропусков, эфир — оставаться заглушённым.
  await sleep(6300);
  results.timemachineContinuous = await evaluate(`(() => {
    const analysis = MR.analyser.read(performance.now());
    const slider = document.querySelector('#timemachine');
    const rewind = Number(MR.timemachine.getRewind().toFixed(2));
    const buffered = MR.timemachine.isBuffered();
    const status = MR.store.state.playback.status;
    const schedule = (window.__tmSchedule || []).slice();
    const gaps = [];
    for (let i = 1; i < schedule.length; i += 1) {
      const previous = schedule[i - 1];
      gaps.push(Number((schedule[i].when - (previous.when + previous.duration)).toFixed(4)));
    }
    return {
      buffered: buffered,
      playing: MR.timemachine.isBufferPlaying(),
      status: status,
      streamState: document.querySelector('#stream-status').dataset.state,
      rewind: rewind,
      liveVisible: !document.querySelector('#timemachine-live').hidden,
      liveSilent: analysis.silent,
      liveLevel: Number(analysis.level.toFixed(3)),
      sliderMax: Number(slider.max),
      sliderValue: Number(slider.value),
      segments: schedule.length,
      scheduleGaps: gaps,
      gapless: gaps.length > 0 && gaps.every((gap) => Math.abs(gap) <= 0.005),
      ok: buffered && status === "playing" && rewind >= 1.5 && rewind <= 4,
    };
  })()`);

  results.timemachineContinuousReturn = await evaluate(`(() => {
    MR.timemachine.returnLive();
    const bufferedAfter = MR.timemachine.isBuffered();
    const playingAfter = MR.timemachine.isBufferPlaying();
    return {
      bufferedAfter: bufferedAfter,
      playingAfter: playingAfter,
      status: MR.store.state.playback.status,
      lagHiddenAfter: document.querySelector('#timemachine-lag').hidden,
    };
  })()`);

  // LIVE снова включает живой эфир: анализатор перестаёт видеть тишину,
  // а статус буферизации эфира больше не скрывается.
  await sleep(500);
  results.timemachineContinuousLiveBack = await evaluate(`(() => {
    const analysis = MR.analyser.read(performance.now());
    MR.store.setPlayback({ status: "buffering", isPlaying: true });
    const result = {
      buffered: MR.timemachine.isBuffered(),
      status: MR.store.state.playback.status,
      bufferingShown: MR.store.state.playback.status === "buffering",
      silent: analysis.silent,
      level: Number(analysis.level.toFixed(3)),
    };
    MR.store.setPlayback({ status: "playing", isPlaying: true });
    MR.audio.stop();
    result.statusAfterStop = MR.store.state.playback.status;
    return result;
  })()`);

  // Настройки буфера: выключение освобождает память, длительность влияет на окно.
  await evaluate(`document.querySelector('[data-command="settings:open"]').click()`);
  await sleep(250);
  results.timemachineSettings = await evaluate(`(async () => {
    const checkbox = document.querySelector('#setting-buffer');
    const select = document.querySelector('#setting-buffer-minutes');
    const defaults = {
      enabled: MR.store.state.ui.bufferEnabled,
      minutes: MR.store.state.ui.bufferMinutes,
      maxSeconds: MR.timemachine.maxSeconds(),
      options: [...select.options].map((option) => option.value).join(','),
    };

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const disabled = {
      enabled: MR.store.state.ui.bufferEnabled,
      available: MR.timemachine.availableSeconds(),
      sliderHidden: document.querySelector('#timemachine').hidden,
      lagHidden: document.querySelector('#timemachine-lag').hidden,
      selectDisabled: select.disabled,
    };

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    select.value = '5';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const enabled = {
      enabled: MR.store.state.ui.bufferEnabled,
      minutes: MR.store.state.ui.bufferMinutes,
      maxSeconds: MR.timemachine.maxSeconds(),
      sliderHidden: document.querySelector('#timemachine').hidden,
      selectDisabled: select.disabled,
    };

    select.value = '3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#modal-settings [data-close-modal]').click();

    return {
      defaults: defaults,
      disabled: disabled,
      enabled: enabled,
      restored: {
        enabled: MR.store.state.ui.bufferEnabled,
        minutes: MR.store.state.ui.bufferMinutes,
        modalClosed: document.querySelector('#modal-settings').hidden,
      },
    };
  })()`);

  // Автопроверка станций: тумблер, сохранение и ручной запуск при выключенной авто.
  // Таймаут проверки источника уменьшен только на время теста, чтобы не ждать сеть.
  await evaluate(`document.querySelector('[data-command="settings:open"]').click()`);
  await sleep(250);
  results.autoHealthCheck = await evaluate(`(async () => {
    const checkbox = document.querySelector('#setting-auto-health');
    const modal = document.querySelector('#modal-settings');
    const initial = {
      modalOpen: !modal.hidden,
      exists: Boolean(checkbox),
      checked: checkbox ? checkbox.checked : null,
      state: MR.store.state.ui.autoHealthCheck,
      serialized: MR.store.serialize().ui.autoHealthCheck,
    };

    const probeTimeout = MR.config.health.probeTimeoutMs;
    MR.config.health.probeTimeoutMs = 700;

    try {
      // Ручная проверка запускается при включённой настройке...
      const manualPromise = MR.health.run({ manual: true }).then(
        (value) => ({ settled: value }),
        (error) => ({ error: String((error && error.message) || error) })
      );
      const runningAtStart = MR.health.isRunning;

      // ...и выключение автопроверки не должно её прервать.
      if (checkbox) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));

      const toast = document.querySelector('#toast-region .toast:last-child');
      const offDuringRun = {
        state: MR.store.state.ui.autoHealthCheck,
        checkbox: checkbox ? checkbox.checked : null,
        serialized: MR.store.serialize().ui.autoHealthCheck,
        running: MR.health.isRunning,
        infoToast: Boolean(toast && toast.textContent.includes('Автопроверка')),
      };

      const manual = await manualPromise;

      if (checkbox) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));

      return {
        initial: initial,
        runningAtStart: runningAtStart,
        offDuringRun: offDuringRun,
        manual: manual,
        progressAfter: { running: MR.store.state.healthProgress.running },
        on: {
          state: MR.store.state.ui.autoHealthCheck,
          checkbox: checkbox ? checkbox.checked : null,
          serialized: MR.store.serialize().ui.autoHealthCheck,
        },
      };
    } finally {
      MR.config.health.probeTimeoutMs = probeTimeout;
      document.querySelector('#modal-settings [data-close-modal]').click();
    }
  })()`);

  results.recorder = await evaluate(`(() => ({
    supported: MR.recorder.supported(),
    button: Boolean(document.querySelector('#record-btn')),
    capture: Boolean(MR.audio.getCaptureStream()),
  }))()`);

  // Архив записей: фейковый WAV сохраняется в IndexedDB, вкладка «Записи»
  // показывает карточку с перемоткой, скачиванием и удалением.
  const recordWav = makeWavDataUrl(1, 8000);
  results.recordingsSave = await evaluate(`(async () => {
    const base64 = ${JSON.stringify(recordWav)}.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "audio/wav" });
    const saved = await MR.recordings.save({
      id: "smoke-record-1",
      stationId: "smoke",
      stationName: "Тест-запись",
      createdAt: Date.now(),
      durationMs: 1000,
      mimeType: "audio/wav",
      size: blob.size,
      blob: blob,
    });
    return {
      ok: saved.ok,
      persistent: await MR.recordings.isPersistent(),
      supported: await MR.recordings.supported(),
      stored: (await MR.recordings.list()).length,
      name: MR.recordings.fileName(saved.entry),
    };
  })()`);

  await evaluate(`document.querySelector('#tab-recordings').click()`);
  await sleep(500);
  results.recordingsView = await evaluate(`(() => {
    const cards = document.querySelectorAll('#recordings-list .record-card');
    const seek = document.querySelector('.record-card__seek');
    const download = document.querySelector('.record-card__download');
    return {
      view: MR.store.state.view,
      panelVisible: !document.querySelector('#panel-recordings').hidden,
      tabSelected: document.querySelector('#tab-recordings').getAttribute('aria-selected'),
      count: document.querySelector('#recordings-count').textContent,
      rows: cards.length,
      station: cards.length ? cards[0].querySelector('.record-card__station').textContent : '',
      seek: Boolean(seek),
      seekMax: seek ? Number(seek.max) : null,
      download: download ? download.getAttribute('download') : '',
      fallbackHidden: document.querySelector('#recordings-fallback').hidden,
      loadingHidden: document.querySelector('#recordings-loading').hidden,
      emptyHidden: document.querySelector('#recordings-empty').hidden,
      clearVisible: !document.querySelector('#recordings-clear').hidden,
    };
  })()`);

  // Реальная запись: stop не должен сам начинать скачивание, только архив.
  results.recordingsRecorder = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const before = (await MR.recordings.list()).length;

    if (!MR.store.state.playback.isPlaying) {
      MR.audio.playStation(MR.store.state.stations[0].id);
      for (let i = 0; i < 16 && !MR.store.state.playback.isPlaying; i += 1) await wait(300);
    }

    const originalClick = HTMLAnchorElement.prototype.click;
    let downloadClicks = 0;
    HTMLAnchorElement.prototype.click = function () { downloadClicks += 1; };

    let started = false;
    try {
      document.querySelector('#record-btn').click();
      started = MR.recorder.isRecording();
      await wait(1200);
      if (MR.recorder.isRecording()) document.querySelector('#record-btn').click();
      await wait(1400);
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }

    const items = await MR.recordings.list();
    const toasts = [...document.querySelectorAll('#toast-region .toast')]
      .map((node) => node.textContent);
    return {
      playing: MR.store.state.playback.isPlaying,
      started: started,
      stopped: !MR.recorder.isRecording(),
      downloadClicks: downloadClicks,
      before: before,
      after: items.length,
      firstDuration: items[0] ? items[0].durationMs : 0,
      firstSize: items[0] ? items[0].size : 0,
      cards: document.querySelectorAll('#recordings-list .record-card').length,
      savedToast: toasts.some((text) => text.indexOf('архив') !== -1),
      recordChipHidden: document.querySelector('#record-chip').hidden,
    };
  })()`);

  // Удаление одной записи через подтверждение.
  await evaluate(`(() => {
    const card = document.querySelector('[data-record-id="smoke-record-1"]');
    if (card) card.querySelector('.record-card__remove').click();
  })()`);
  await sleep(250);
  results.recordingsConfirm = await evaluate(`(() => ({
    open: !document.querySelector('#modal-confirm').hidden,
    title: document.querySelector('#confirm-title').textContent,
  }))()`);
  await evaluate(`document.querySelector('#confirm-ok').click()`);
  await sleep(500);
  results.recordingsDelete = await evaluate(`(async () => ({
    rows: document.querySelectorAll('#recordings-list .record-card').length,
    stored: (await MR.recordings.list()).length,
    hasFake: Boolean(document.querySelector('[data-record-id="smoke-record-1"]')),
    count: document.querySelector('#recordings-count').textContent,
  }))()`);

  await screenshot("recordings.png");

  // Очистка всего архива.
  await evaluate(`document.querySelector('#recordings-clear').click()`);
  await sleep(250);
  await evaluate(`document.querySelector('#confirm-ok').click()`);
  await sleep(500);
  results.recordingsClear = await evaluate(`(async () => ({
    rows: document.querySelectorAll('#recordings-list .record-card').length,
    stored: (await MR.recordings.list()).length,
    emptyVisible: !document.querySelector('#recordings-empty').hidden,
    clearHidden: document.querySelector('#recordings-clear').hidden,
    count: document.querySelector('#recordings-count').textContent,
  }))()`);
  await screenshot("recordings-empty.png");
  await evaluate(`document.querySelector('#tab-stations').click()`);
  await sleep(200);

  await evaluate(`MR.audio.stop()`);

  results.stats = await evaluate(`(() => {
    const summary = MR.stats.getSummary();
    return {
      totalSeconds: Number(summary.totalSeconds.toFixed(2)),
      stations: summary.stations.length,
    };
  })()`);

  // Панель статистики: быстрое действие открывает модалку, закрытие работает.
  results.statsPanelQuick = await evaluate(`(async () => {
    const modal = document.querySelector('#modal-stats');
    const quick = document.querySelector('.quick-actions [data-command="stats:open"]');
    const sidebarCard = Boolean(document.querySelector('.content-side .stats-card'));
    quick.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const opened = !modal.hidden;
    const total = document.querySelector('#stats-total').textContent;
    const focusInside = modal.contains(document.activeElement);
    document.querySelector('#modal-stats .modal__close').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      button: Boolean(quick),
      sidebarCard: sidebarCard,
      opened: opened,
      total: total,
      focusInside: focusInside,
      closed: modal.hidden,
    };
  })()`);

  // Меню «Данные»: «Статистика» — первый пункт.
  results.statsPanelMenu = await evaluate(`(async () => {
    const group = [...document.querySelectorAll('.nav-group')]
      .find((item) => item.querySelector('.nav-btn').textContent.includes('Данные'));
    group.querySelector('.nav-btn').click();
    const first = group.querySelector('.nav-menu .nav-item');
    const menuOpen = group.classList.contains('is-open');
    const firstIsStats = first.dataset.command === 'stats:open';
    first.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      menuOpen: menuOpen,
      firstIsStats: firstIsStats,
      opened: !document.querySelector('#modal-stats').hidden,
      menuClosed: !group.classList.contains('is-open'),
    };
  })()`);
  await screenshot("stats-panel.png");

  // Светлая тема: панель остаётся читаемой и не теряет фон.
  await evaluate(`document.querySelector('#theme-toggle').click()`);
  await sleep(300);
  results.statsPanelLight = await evaluate(`(() => {
    const panel = document.querySelector('#modal-stats .modal__panel');
    return {
      theme: document.documentElement.dataset.theme,
      lightBg: getComputedStyle(panel).backgroundImage.includes('255, 255, 255'),
      open: !document.querySelector('#modal-stats').hidden,
    };
  })()`);
  await screenshot("stats-panel-light.png");
  await evaluate(`document.querySelector('#theme-toggle').click()`);
  await sleep(200);

  // Сброс: подтверждение, значения обнулились, панель осталась открытой.
  results.statsPanelReset = await evaluate(`(async () => {
    const modal = document.querySelector('#modal-stats');
    document.querySelector('#modal-stats [data-command="stats:reset"]').click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const confirmOpen = !document.querySelector('#modal-confirm').hidden;
    document.querySelector('#confirm-ok').click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const summary = MR.stats.getSummary();
    const result = {
      confirmOpen: confirmOpen,
      confirmClosed: document.querySelector('#modal-confirm').hidden,
      panelOpen: !modal.hidden,
      totalSeconds: summary.totalSeconds,
      stations: summary.stations.length,
      genres: summary.genres.length,
      totalText: document.querySelector('#stats-total').textContent,
      emptyVisible: !document.querySelector('#stats-empty').hidden,
    };
    MR.modal.close('#modal-stats');
    return result;
  })()`);

  // ===== Поиск станций по каталогам =====
  // Открытие из «Быстрых действий» и меню «Радио».
  results.searchOpen = await evaluate(`(() => {
    const quick = document.querySelector('.quick-action[data-command="search:open"]');
    const menu = document.querySelector('.nav-item[data-command="search:open"]');
    quick.click();
    return {
      quick: Boolean(quick),
      menu: Boolean(menu),
      open: !document.querySelector('#modal-search').hidden,
      title: document.querySelector('#search-modal-title').textContent,
      providers: MR.searchProviders.providers.length,
      fallbackStations: MR.radioSearch.getFallbackMatches({}).length,
      countryOptions: document.querySelectorAll('#search-country option').length,
      languageOptions: document.querySelectorAll('#search-language option').length,
    };
  })()`);
  await sleep(1400);

  results.searchPanel = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('#search-results .search-card'))
      .filter((card) => !card.classList.contains('search-card--skeleton'));
    return {
      cards: cards.length,
      count: document.querySelector('#search-count').textContent,
      names: cards.slice(0, 4).map((card) => card.querySelector('.search-card__name').textContent),
      badges: document.querySelectorAll('#search-results .search-card .station-row__group').length,
      addButtons: document.querySelectorAll('#search-results [data-search-add]').length,
      healthDots: document.querySelectorAll('#search-results .health-dot').length,
      healthStates: Array.from(document.querySelectorAll('#search-results .health-dot'))
        .map((dot) => dot.dataset.health),
      errorHidden: document.querySelector('#search-error').hidden,
      statusHidden: document.querySelector('#search-status').hidden,
    };
  })()`);
  await screenshot("search-panel.png");

  // Ввод названия (debounce 300 мс) и результаты.
  await evaluate(`(() => {
    const input = document.querySelector('#search-query');
    input.value = 'groove';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(1100);
  results.searchQuery = await evaluate(`(() => ({
    cards: document.querySelectorAll('#search-results .search-card:not(.search-card--skeleton)').length,
    names: Array.from(document.querySelectorAll('#search-results .search-card__name'))
      .map((node) => node.textContent),
    count: document.querySelector('#search-count').textContent,
  }))()`);

  // Переключение вида «список / плитка».
  await evaluate(`document.querySelector('[data-search-view="grid"]').click()`);
  await sleep(150);
  results.searchView = await evaluate(`(() => ({
    grid: document.querySelector('#search-results').classList.contains('search-results--grid'),
    listPressed: document.querySelector('[data-search-view="list"]').getAttribute('aria-pressed'),
    gridPressed: document.querySelector('[data-search-view="grid"]').getAttribute('aria-pressed'),
  }))()`);
  await screenshot("search-grid.png");
  await evaluate(`document.querySelector('[data-search-view="list"]').click()`);
  await sleep(100);

  // Добавление станции из результатов и повторный клик по кнопке.
  results.searchAdd = await evaluate(`(async () => {
    const before = MR.store.state.stations.length;
    const findCard = () => Array.from(document.querySelectorAll('#search-results .search-card'))
      .find((node) => {
        const label = node.querySelector('.search-card__name');
        return label && label.textContent === 'FIP Groove';
      }) || Array.from(document.querySelectorAll('#search-results .search-card'))
      .find((node) => node.querySelector('[data-search-add]') && !node.querySelector('[data-search-add]').disabled);

    const firstCard = findCard();
    const name = firstCard.querySelector('.search-card__name').textContent;
    firstCard.querySelector('[data-search-add]').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterFirst = MR.store.state.stations.length;
    const added = MR.store.state.stations.find((station) => station.name === name) || null;

    const addedCard = findCard();
    const addedButton = addedCard ? addedCard.querySelector('[data-search-add]') : null;
    if (addedButton) addedButton.click();
    await new Promise((resolve) => setTimeout(resolve, 150));

    return {
      name: name,
      before: before,
      afterFirst: afterFirst,
      afterSecond: MR.store.state.stations.length,
      buttonDisabled: addedButton ? addedButton.disabled : null,
      buttonText: addedButton ? addedButton.textContent.trim() : '',
      emoji: added ? added.emoji : '',
      sources: added ? added.sources.length : 0,
      toasts: document.querySelectorAll('.toast--success').length,
      storeHas: Boolean(added),
    };
  })()`);

  // Индикатор работоспособности видимых карточек.
  await sleep(1500);
  results.searchHealth = await evaluate(`(() => ({
    states: Array.from(document.querySelectorAll('#search-results .health-dot'))
      .map((dot) => dot.dataset.health),
    allKnown: Array.from(document.querySelectorAll('#search-results .health-dot'))
      .every((dot) => ['checking', 'online', 'fallback', 'offline', 'unknown'].indexOf(dot.dataset.health) !== -1),
  }))()`);

  // Разделённая кнопка «Добавить»: шеврон и меню групп.
  results.searchGroupMenu = await evaluate(`(async () => {
    const cards = Array.from(document.querySelectorAll('#search-results .search-card'))
      .filter((node) => !node.classList.contains('search-card--skeleton'));
    const storeNames = new Set(MR.store.state.stations
      .map((station) => String(station.name).trim().toLowerCase()));
    const cardName = (node) =>
      node.querySelector('.search-card__name').textContent.trim().toLowerCase();
    const pick = (requireNewName) => cards.find((node) => {
      const button = node.querySelector('[data-search-add]');
      if (!button || button.disabled || !node.querySelector('[data-search-add-toggle]')) return false;
      return !requireNewName || !storeNames.has(cardName(node));
    });
    const card = pick(true) || pick(false);
    if (!card) return { found: false };

    const toggle = card.querySelector('[data-search-add-toggle]');
    const expandedBefore = toggle.getAttribute('aria-expanded');
    const hasPopup = toggle.getAttribute('aria-haspopup');
    const label = toggle.getAttribute('aria-label');
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 160));

    const menu = document.querySelector('.search-add-menu');
    const items = menu ? Array.from(menu.querySelectorAll('[data-group-option]')) : [];
    const groupItems = items.filter((node) => node.getAttribute('data-group-option'));
    const panel = document.querySelector('#modal-search .modal__panel').getBoundingClientRect();
    const rect = menu ? menu.getBoundingClientRect() : null;

    return {
      found: true,
      newName: !storeNames.has(cardName(card)),
      hasPopup: hasPopup,
      label: label,
      expandedBefore: expandedBefore,
      expanded: toggle.getAttribute('aria-expanded'),
      menuVisible: Boolean(menu) && !menu.hidden,
      menuRole: menu ? menu.getAttribute('role') : '',
      itemRoles: items.length > 0 && items.every((node) => node.getAttribute('role') === 'menuitem'),
      noGroupLabel: items.length ? items[0].querySelector('.search-add-menu__label').textContent.trim() : '',
      groups: groupItems.length,
      storeGroups: MR.store.state.groups.length,
      groupNamesMatch: MR.store.state.groups.every((group) =>
        groupItems.some((node) => node.textContent.indexOf(group.name) !== -1)),
      hasCreate: Boolean(menu && menu.querySelector('[data-group-create]')),
      separator: Boolean(menu && menu.querySelector('[role="separator"]')),
      currentMarked: Boolean(menu && menu.querySelector('.search-add-menu__item.is-current')),
      currentLabel: menu && menu.querySelector('.search-add-menu__item.is-current')
        ? menu.querySelector('.search-add-menu__item.is-current .search-add-menu__label').textContent.trim()
        : '',
      focusedRole: document.activeElement ? document.activeElement.getAttribute('role') : '',
      insidePanel: rect ? (rect.left >= panel.left - 1 && rect.right <= panel.right + 1) : false,
      insideViewport: rect ? (rect.top >= 0 && rect.bottom <= window.innerHeight + 1) : false,
      menuSize: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
    };
  })()`);
  await screenshot("search-group-menu.png");

  // Выбор группы для ещё не добавленной станции: добавление сразу в группу.
  results.searchGroupAssign = await evaluate(`(async () => {
    const toggle = document.querySelector('#search-results [data-search-add-toggle][aria-expanded="true"]');
    const card = toggle.closest('.search-card');
    const stationName = card.querySelector('.search-card__name').textContent;
    const menu = document.querySelector('.search-add-menu');
    const targetGroup = MR.store.state.groups.find((group) => group.name === 'Вечерний чилл') ||
      MR.store.state.groups[0];
    if (!targetGroup) return { found: false };
    const item = Array.from(menu.querySelectorAll('[data-group-option]'))
      .find((node) => node.getAttribute('data-group-option') === targetGroup.id);
    if (!item) return { found: false, targetGroup: targetGroup.name };

    const toastsBefore = new Set(Array.from(document.querySelectorAll('.toast')));
    const before = MR.store.state.stations.length;
    item.click();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const station = MR.store.state.stations.find((entry) => entry.name === stationName);
    const groupOf = station ? MR.store.getGroupOfStation(station.id) : null;
    const mainButton = card.querySelector('[data-search-add]');
    const newToast = Array.from(document.querySelectorAll('.toast'))
      .find((node) => !toastsBefore.has(node));
    const toastText = newToast ? newToast.querySelector('.toast__text').textContent : '';

    return {
      stationName: stationName,
      targetGroup: targetGroup.name,
      addedCount: MR.store.state.stations.length - before,
      stored: Boolean(station),
      groupName: groupOf ? groupOf.name : '',
      inGroupIds: Boolean(groupOf && groupOf.stationIds.indexOf(station.id) !== -1),
      duplicates: MR.store.state.stations.filter((entry) => entry.name === stationName).length,
      menuClosed: document.querySelector('.search-add-menu').hidden,
      expandedAfter: toggle.getAttribute('aria-expanded'),
      mainDisabled: mainButton.disabled,
      mainLabel: mainButton.querySelector('.search-card__add-label').textContent,
      focusBack: document.activeElement === toggle,
      toastText: toastText,
      toastInGroup: toastText.indexOf(targetGroup.name) !== -1,
    };
  })()`);

  const assignedGroupName = JSON.stringify(results.searchGroupAssign.stationName || "");

  // Повторный выбор другой группы: станция переносится, дубликата нет.
  results.searchGroupMove = await evaluate(`(async () => {
    const stationName = ${assignedGroupName};
    const card = Array.from(document.querySelectorAll('#search-results .search-card'))
      .find((node) => {
        const label = node.querySelector('.search-card__name');
        return label && label.textContent === stationName;
      });
    if (!card) return { found: false };

    const toggle = card.querySelector('[data-search-add-toggle]');
    const stationBefore = MR.store.state.stations.find((entry) => entry.name === stationName);
    const previous = stationBefore ? MR.store.getGroupOfStation(stationBefore.id) : null;
    const before = MR.store.state.stations.length;

    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 160));
    const menu = document.querySelector('.search-add-menu');
    const currentMarked = menu.querySelector('.search-add-menu__item.is-current');
    const other = MR.store.state.groups.find((group) => group.name === 'Тест-группа 3') ||
      MR.store.state.groups.find((group) => !previous || group.id !== previous.id);
    if (!other) return { found: false };
    const item = Array.from(menu.querySelectorAll('[data-group-option]'))
      .find((node) => node.getAttribute('data-group-option') === other.id);
    if (!item) return { found: false, targetGroup: other.name };
    item.click();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const station = MR.store.state.stations.find((entry) => entry.name === stationName);
    const groupOf = station ? MR.store.getGroupOfStation(station.id) : null;
    const oldGroup = previous ? MR.store.getGroup(previous.id) : null;

    return {
      found: true,
      currentMarked: Boolean(currentMarked),
      previousGroup: previous ? previous.name : '',
      targetGroup: other.name,
      addedCount: MR.store.state.stations.length - before,
      sameStationId: Boolean(stationBefore && station && stationBefore.id === station.id),
      groupName: groupOf ? groupOf.name : '',
      inNewGroup: Boolean(groupOf && groupOf.stationIds.indexOf(station.id) !== -1),
      leftOldGroup: oldGroup ? oldGroup.stationIds.indexOf(station.id) === -1 : true,
      duplicates: MR.store.state.stations.filter((entry) => entry.name === stationName).length,
      menuClosed: document.querySelector('.search-add-menu').hidden,
    };
  })()`);

  // Закрытие меню: Esc (модалка остаётся), клик вне, одно меню за раз.
  results.searchGroupClose = await evaluate(`(async () => {
    const toggles = Array.from(document.querySelectorAll('#search-results [data-search-add-toggle]'));
    const toggle = toggles[0];
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    toggle.click();
    await wait(150);
    let menu = document.querySelector('.search-add-menu');
    const opened = !menu.hidden;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(140);
    const escClosed = menu.hidden;
    const modalStillOpen = !document.querySelector('#modal-search').hidden;
    const focusOnToggle = document.activeElement === toggle;
    const expandedAfterEsc = toggle.getAttribute('aria-expanded');

    toggle.click();
    await wait(150);
    const openedAgain = !menu.hidden;
    document.querySelector('#search-modal-title').click();
    await wait(140);
    const outsideClosed = menu.hidden;
    const modalOpenAfterOutside = !document.querySelector('#modal-search').hidden;

    toggles[0].click();
    await wait(140);
    if (toggles[1]) {
      toggles[1].click();
      await wait(140);
    }
    const openMenus = document.querySelectorAll('.search-add-menu:not([hidden])').length;
    const secondExpanded = toggles[1] ? toggles[1].getAttribute('aria-expanded') : '';
    const firstCollapsed = toggles[0].getAttribute('aria-expanded');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(120);

    return {
      opened: opened,
      escClosed: escClosed,
      modalStillOpen: modalStillOpen,
      focusOnToggle: focusOnToggle,
      expandedAfterEsc: expandedAfterEsc,
      openedAgain: openedAgain,
      outsideClosed: outsideClosed,
      modalOpenAfterOutside: modalOpenAfterOutside,
      openMenus: openMenus,
      secondExpanded: secondExpanded,
      firstCollapsed: firstCollapsed,
      finalClosed: document.querySelector('.search-add-menu').hidden,
    };
  })()`);

  // «Создать группу…» из меню: закрывает меню и открывает редактор группы.
  results.searchGroupCreate = await evaluate(`(async () => {
    const toggle = document.querySelector('#search-results [data-search-add-toggle]');
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 160));
    const menu = document.querySelector('.search-add-menu');
    const create = menu.querySelector('[data-group-create]');
    const menuBefore = !menu.hidden;
    create.click();
    await new Promise((resolve) => setTimeout(resolve, 260));

    const groupModal = document.querySelector('#modal-group');
    const result = {
      menuBefore: menuBefore,
      groupOpen: !groupModal.hidden,
      menuClosed: menu.hidden,
      searchStillOpen: !document.querySelector('#modal-search').hidden,
      title: document.querySelector('#group-modal-title').textContent,
      nameInput: document.querySelector('#gr-name').value,
    };

    MR.modal.close('#modal-group');
    await new Promise((resolve) => setTimeout(resolve, 220));
    result.groupClosed = groupModal.hidden;
    result.searchAfterClose = !document.querySelector('#modal-search').hidden;
    result.focusOnToggle = Boolean(document.activeElement) &&
      document.activeElement.getAttribute("data-search-add-toggle") !== null;
    return result;
  })()`);

  await evaluate(`document.querySelector('#modal-search [data-close-modal]').click()`);
  await sleep(250);
  results.searchClosed = await evaluate(`(() => ({
    closed: document.querySelector('#modal-search').hidden,
    modalOpen: MR.modal.hasOpen,
  }))()`);

  // Открытие из меню «Радио» (вторая точка входа).
  results.searchFromMenu = await evaluate(`(() => {
    document.querySelector('.nav-item[data-command="search:open"]').click();
    return { open: !document.querySelector('#modal-search').hidden };
  })()`);
  await sleep(250);
  results.searchFocus = await evaluate(`document.activeElement ? document.activeElement.id : ''`);
  await evaluate(`MR.modal.close('#modal-search')`);
  await sleep(200);

  // Передача станции и группы по ссылке (#share=).
  // 1. Кнопка «Ссылка» в форме редактирования станции открывает #modal-share.
  results.shareStationLink = await evaluate(`(() => {
    const usable = MR.store.state.stations.filter((item) =>
      item.sources.length && item.sources.every((source) => MR.utils.isHttpUrl(source.url)));
    const station = usable.find((item) => item.name === 'Тестовая станция') || usable[0];
    MR.stationForm.open({ mode: 'edit', stationId: station.id });
    const button = document.querySelector('#station-share');
    const visible = Boolean(button) && !button.hidden && button.type === 'button';
    if (button) button.click();
    const input = document.querySelector('#share-link');
    return {
      visible: visible,
      modalOpen: !document.querySelector('#modal-share').hidden,
      title: document.querySelector('#share-title').textContent,
      hasShare: (input.value || '').includes('#share='),
      readonly: input.readOnly,
      linkRowVisible: !document.querySelector('#share-link-row').hidden,
      copyVisible: !document.querySelector('#share-copy').hidden,
      addHidden: document.querySelector('#share-add').hidden,
      formStillOpen: !document.querySelector('#modal-station').hidden,
    };
  })()`);
  await sleep(200);
  // Настоящий клик (trusted gesture), чтобы сработал буфер обмена.
  const copyPoint = await evaluate(`(() => {
    const rect = document.querySelector('#share-copy').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: copyPoint.x, y: copyPoint.y, button: "left", clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: copyPoint.x, y: copyPoint.y, button: "left", clickCount: 1,
  });
  await sleep(350);
  results.shareCopy = await evaluate(`(() => {
    const toast = document.querySelector('#toast-region .toast:last-child');
    return {
      copied: Boolean(toast && toast.classList.contains('toast--success')),
      toast: toast ? toast.textContent : '',
    };
  })()`);
  await screenshot("share-link.png");
  await evaluate(`(() => {
    document.querySelector('#share-cancel').click();
    MR.modal.close('#modal-station');
  })()`);
  await sleep(200);
  results.shareClosed = await evaluate(`(() => ({
    shareClosed: document.querySelector('#modal-share').hidden,
    stationClosed: document.querySelector('#modal-station').hidden,
  }))()`);

  // 2. apply(): станция добавляется, повторный вызов не создаёт дубликат.
  results.shareApplyStation = await evaluate(`(() => {
    const before = MR.store.state.stations.length;
    const payload = {
      v: 1, type: 'station',
      station: {
        name: 'Ссылочная станция', genre: 'Ambient', emoji: '🔗',
        sources: [{ url: 'https://example.com/share-station.mp3', bitrate: 192 }],
      },
    };
    const first = MR.share.apply(payload);
    const afterFirst = MR.store.state.stations.length;
    const duplicate = MR.share.apply(payload);
    const added = MR.store.state.stations.find((item) => item.name === 'Ссылочная станция');
    return {
      firstOk: first.ok,
      duplicate: duplicate.duplicate === true,
      addedCount: afterFirst - before,
      total: MR.store.state.stations.length,
      sources: added ? added.sources : [],
    };
  })()`);

  // 3. Входящая ссылка: hash → предпросмотр → «Добавить» → hash очищен.
  results.shareIncomingOpen = await evaluate(`(() => {
    const link = MR.share.buildStationLink({
      name: 'Хеш-станция', genre: 'Test', emoji: '🔗',
      sources: [{ url: 'https://example.com/hash-share.mp3', bitrate: 128 }],
    });
    location.hash = link.slice(link.indexOf('#'));
    const parsed = MR.share.parseLocation();
    const opened = MR.share.processLocation();
    return {
      parsedOk: parsed.ok,
      opened: opened,
      modalOpen: !document.querySelector('#modal-share').hidden,
      title: document.querySelector('#share-title').textContent,
      addVisible: !document.querySelector('#share-add').hidden,
      preview: document.querySelectorAll('#share-preview .share-source').length,
    };
  })()`);
  await sleep(200);
  await screenshot("share-incoming.png");
  results.shareIncoming = await evaluate(`(() => {
    document.querySelector('#share-add').click();
    return {
      added: Boolean(MR.store.state.stations.find((item) => item.name === 'Хеш-станция')),
      closed: document.querySelector('#modal-share').hidden,
      hashCleared: !String(location.hash).includes('share='),
      toast: [...document.querySelectorAll('.toast')].some((node) =>
        node.textContent.includes('Хеш-станция')),
    };
  })()`);

  // 4. Кнопка «Ссылка» в форме группы и состав группы в payload.
  results.shareGroupLink = await evaluate(`(() => {
    const station = MR.store.state.stations.find((item) =>
      item.sources.length && item.sources.every((source) => MR.utils.isHttpUrl(source.url)));
    MR.store.addGroup({ name: 'Группа для ссылки', stationIds: station ? [station.id] : [] });
    const group = MR.store.state.groups.find((item) => item.name === 'Группа для ссылки');
    MR.groupsUI.openEditor(group.id);
    const button = document.querySelector('#group-share');
    const visible = Boolean(button) && !button.hidden;
    if (button) button.click();
    const link = document.querySelector('#share-link').value || '';
    const parsed = MR.share.parsePayload(link.split('#share=')[1] || '');
    const result = {
      visible: visible,
      modalOpen: !document.querySelector('#modal-share').hidden,
      title: document.querySelector('#share-title').textContent,
      type: parsed.ok ? parsed.payload.type : '',
      stations: parsed.ok && parsed.payload.stations ? parsed.payload.stations.length : 0,
    };
    document.querySelector('#share-cancel').click();
    MR.modal.close('#modal-group');
    return result;
  })()`);

  // 5. apply() группы: существующая станция переиспользуется, группа получает stationIds.
  results.shareApplyGroup = await evaluate(`(() => {
    const payload = {
      v: 1, type: 'group', group: { name: 'Ссылочная группа' },
      stations: [
        { name: 'Ссылочная станция', genre: 'Ambient', emoji: '🔗',
          sources: [{ url: 'https://example.com/share-station.mp3', bitrate: 192 }] },
        { name: 'Групповая станция', genre: 'Chill', emoji: '🎧',
          sources: [{ url: 'https://example.com/share-group-station.mp3', bitrate: 256 }] },
      ],
    };
    const before = MR.store.state.stations.length;
    const result = MR.share.apply(payload);
    const group = MR.store.state.groups.find((item) => item.name === 'Ссылочная группа');
    return {
      ok: result.ok,
      stationsAdded: MR.store.state.stations.length - before,
      reused: result.stationsReused,
      group: Boolean(group),
      stationIds: group ? group.stationIds.length : 0,
      names: group ? group.stationIds.map((id) => (MR.store.findStation(id) || {}).name) : [],
    };
  })()`);

  // Мобильный вид
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(800);
  await screenshot("mobile.png");
  await evaluate(`document.querySelector('#nav-toggle').click()`);
  await sleep(300);
  results.mobileNav = await evaluate(`(() => ({
    open: document.querySelector('#app-header').classList.contains('is-nav-open'),
    visible: document.querySelector('#main-nav').getBoundingClientRect().height > 300,
    expanded: document.querySelector('#nav-toggle').getAttribute('aria-expanded'),
  }))()`);
  await screenshot("mobile-menu.png");

  // Форма станции на мобильной ширине: строки источников не должны ломать вёрстку.
  await evaluate(`(() => {
    document.querySelector('#nav-toggle').click();
    MR.stationForm.open({ mode: "add" });
  })()`);
  await sleep(300);
  results.mobileStationForm = await evaluate(`(() => ({
    open: !document.querySelector('#modal-station').hidden,
    rows: document.querySelectorAll('#st-sources .source-row').length,
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
  }))()`);
  await screenshot("mobile-station-form.png");
  await evaluate(`MR.modal.close('#modal-station')`);

  // Панель статистики на 390px: одна колонка, без горизонтального скролла.
  await evaluate(`MR.commands.run("stats:open")`);
  await sleep(250);
  results.mobileStats = await evaluate(`(() => {
    const modal = document.querySelector('#modal-stats');
    const panel = modal.querySelector('.modal__panel');
    const grid = document.querySelector('.stats-panel__grid');
    return {
      open: !modal.hidden,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      viewport: window.innerWidth,
    };
  })()`);
  await screenshot("mobile-stats.png");
  await evaluate(`MR.modal.close('#modal-stats')`);

  // Поиск станций на 390px: меню групп помещается, без горизонтального скролла.
  await evaluate(`MR.commands.run("search:open")`);
  await sleep(1400);
  results.mobileSearchMenu = await evaluate(`(async () => {
    const card = Array.from(document.querySelectorAll('#search-results .search-card'))
      .find((node) => node.querySelector('[data-search-add-toggle]'));
    if (!card) return { found: false };
    const toggle = card.querySelector('[data-search-add-toggle]');
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const menu = document.querySelector('.search-add-menu');
    const rect = menu.getBoundingClientRect();
    const panel = document.querySelector('#modal-search .modal__panel').getBoundingClientRect();
    return {
      found: true,
      modalOpen: !document.querySelector('#modal-search').hidden,
      menuVisible: !menu.hidden,
      items: menu.querySelectorAll('[data-group-option]').length,
      insideViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1,
      insidePanel: rect.left >= panel.left - 1 && rect.right <= panel.right + 1,
      verticalInside: rect.top >= -1 && rect.bottom <= window.innerHeight + 1,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      menuWidth: Math.round(rect.width),
      viewport: window.innerWidth,
    };
  })()`);
  await screenshot("mobile-search-menu.png");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(150);
  results.mobileSearchMenuClosed = await evaluate(`(() => ({
    menuClosed: document.querySelector('.search-add-menu').hidden,
    modalOpen: !document.querySelector('#modal-search').hidden,
    focusOnToggle: Boolean(document.activeElement &&
      document.activeElement.getAttribute('data-search-add-toggle') !== null),
  }))()`);
  await evaluate(`MR.modal.close('#modal-search')`);
  await sleep(200);

  // На мобильной ширине подвал — колонка: ссылка не должна давать горизонтальный скролл.
  await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
  await sleep(300);
  results.footerGitHubMobile = await evaluate(`(() => {
    const link = document.querySelector('.app-footer .footer-link');
    const rect = link.getBoundingClientRect();
    return {
      visible: rect.width > 0 && rect.height > 0,
      insideViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      column: getComputedStyle(document.querySelector('.footer-inner')).flexDirection === 'column',
      uptimeVisible: document.querySelector('#uptime').getBoundingClientRect().height > 0,
    };
  })()`);
  await screenshot("footer-mobile.png");

  // Десктоп: атрибуты ссылки, подпись и uptime по краям, space-between не сломан.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(300);
  results.footerGitHub = await evaluate(`(() => {
    const link = document.querySelector('.app-footer .footer-link');
    if (!link) return { exists: false };
    const rect = link.getBoundingClientRect();
    const style = getComputedStyle(link);
    const icon = link.querySelector('svg');
    const iconRect = icon ? icon.getBoundingClientRect() : null;
    return {
      exists: true,
      href: link.getAttribute('href'),
      target: link.getAttribute('target'),
      rel: link.getAttribute('rel'),
      ariaLabel: link.getAttribute('aria-label'),
      title: link.getAttribute('title'),
      label: link.textContent.trim(),
      icon: Boolean(icon),
      iconAriaHidden: icon ? icon.getAttribute('aria-hidden') : null,
      iconSize: iconRect ? [Math.round(iconRect.width), Math.round(iconRect.height)] : null,
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      color: style.color,
      justifyContent: getComputedStyle(document.querySelector('.footer-inner')).justifyContent,
      uptime: Boolean(document.querySelector('#uptime')),
    };
  })()`);
  await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
  await sleep(300);
  results.footerGitHubDesktop = await evaluate(`(() => {
    const inner = document.querySelector('.footer-inner');
    const link = document.querySelector('.app-footer .footer-link');
    const rect = link.getBoundingClientRect();
    const innerRect = inner.getBoundingClientRect();
    return {
      visible: rect.width > 0 && rect.height > 0,
      insideFooter: rect.left >= innerRect.left - 1 && rect.right <= innerRect.right + 1,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      justifyContent: getComputedStyle(inner).justifyContent,
    };
  })()`);
  await screenshot("footer-desktop.png");

  // Светлая тема: ссылка и иконка читаемы, цвет берётся из токена.
  await evaluate(`document.querySelector('#theme-toggle').click()`);
  await sleep(300);
  await screenshot("footer-light.png");
  results.footerGitHubLight = await evaluate(`(() => {
    const link = document.querySelector('.app-footer .footer-link');
    return {
      theme: document.documentElement.dataset.theme,
      visible: link.getBoundingClientRect().width > 0,
      color: getComputedStyle(link).color,
    };
  })()`);
  await evaluate(`document.querySelector('#theme-toggle').click()`);

  results.consoleErrors = consoleErrors;
  results.exceptions = exceptions;

  console.log(JSON.stringify(results, null, 2));
  ws.close();
  try { await cdp.send("Browser.close"); } catch (error) { /* браузер уже закрывается */ }
}

main().catch((error) => {
  console.error("SMOKE FAILED:", error.stack || error);
  if (global.__smokeResults) {
    console.error("PARTIAL:", JSON.stringify({
      results: global.__smokeResults,
      consoleErrors,
      exceptions,
    }, null, 2));
  }
  process.exit(1);
});
