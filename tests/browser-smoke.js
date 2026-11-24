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
  const ws = new WebSocket(wsEndpoint);
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

  // Валидация и добавление станции
  await evaluate(`document.querySelector('[data-command="station:add"]').click()`);
  await sleep(200);
  await evaluate(`(() => {
    document.querySelector('#st-name').value = 'Тестовая станция';
    document.querySelector('#st-primary').value = 'ftp://bad';
    document.querySelector('#station-submit').click();
  })()`);
  await sleep(200);
  results.stationValidation = await evaluate(`(() => ({
    error: document.querySelector('[data-error-for="primary"]').textContent,
    invalid: document.querySelector('#st-primary').getAttribute('aria-invalid'),
  }))()`);

  await evaluate(`(() => {
    document.querySelector('#st-primary').value = 'https://example.com/stream.mp3';
    document.querySelector('#st-fallbacks').value = 'https://example.com/stream2.mp3';
    document.querySelector('#station-submit').click();
  })()`);
  await sleep(400);
  results.stationAdded = await evaluate(`(() => ({
    rows: document.querySelectorAll('#stations-list .station-row').length,
    modalClosed: document.querySelector('#modal-station').hidden,
    hasNew: [...document.querySelectorAll('.station-row__name')].some(el => el.textContent.includes('Тестовая')),
  }))()`);

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

    modes.forEach((mode) => {
      MR.store.setVisualizerMode(mode);
      MR.bg.draw(fake, 16, performance.now());
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
      drawn[mode] = count;
    });

    MR.store.setVisualizerMode('spectrum');
    return {
      drawn: drawn,
      menuItems: document.querySelectorAll('.nav-item[data-mode]').length,
      settingsOptions: document.querySelectorAll('#setting-mode option').length,
    };
  })()`);

  // Режим визуализации: страница скрыта, остаются «Вид» и «Визуализация».
  results.vizMode = await evaluate(`(() => {
    document.querySelector('#viz-toggle').click();
    const radioGroup = document.querySelector('.nav-group:not(.nav-group--view)');
    return {
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
  await evaluate(`document.querySelector('#modal-settings [data-close-modal]').click()`);

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
    station.primary = ${JSON.stringify(wav)};
    station.fallbacks = [];
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
    };
  })()`);
  await screenshot("playing.png");

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

  results.recorder = await evaluate(`(() => ({
    supported: MR.recorder.supported(),
    button: Boolean(document.querySelector('#record-btn')),
    capture: Boolean(MR.audio.getCaptureStream()),
  }))()`);

  await evaluate(`MR.audio.stop()`);

  results.stats = await evaluate(`(() => {
    const summary = MR.stats.getSummary();
    return {
      totalSeconds: Number(summary.totalSeconds.toFixed(2)),
      stations: summary.stations.length,
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
