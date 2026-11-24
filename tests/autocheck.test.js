/**
 * tests/autocheck.test.js — настройка автопроверки станций без браузера.
 * Запуск: node tests/autocheck.test.js
 */
"use strict";

const path = require("path");
const assert = require("assert");

/* --- Минимальное окружение браузера --- */
function createStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
    get size() { return map.size; },
  };
}

function FakeAudio() {
  this.preload = "";
  this.muted = false;
  this.volume = 1;
  this.src = "";
}

FakeAudio.prototype.addEventListener = function () {};
FakeAudio.prototype.load = function () {};
FakeAudio.prototype.pause = function () {};
FakeAudio.prototype.removeAttribute = function () {};

global.window = global;
global.localStorage = createStorage();
global.Audio = FakeAudio;

const root = path.join(__dirname, "..");
[
  "js/core/utils.js",
  "js/config/app.js",
  "js/config/stations.js",
  "js/config/equalizer.js",
  "js/core/storage.js",
  "js/core/state.js",
].forEach((file) => require(path.join(root, file)));

const MR = global.MR;
const store = MR.store;
store.init();

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ✓ " + name);
  } catch (error) {
    failures.push({ name, error });
    console.log("  ✗ " + name + " — " + error.message);
  }
}

function reset() {
  store.resetAll();
  return store.state;
}

function readSaved() {
  return JSON.parse(global.localStorage.getItem(MR.config.storageKey));
}

/** Подменяет таймеры, чтобы проверить автостарт без ожидания 90 секунд. */
function installFakeTimers() {
  const original = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
  };
  const timeouts = [];
  const intervals = [];

  global.setTimeout = function (fn, ms) {
    const timer = { fn, ms, cleared: false };
    timeouts.push(timer);
    return timer;
  };
  global.clearTimeout = function (timer) {
    if (timer && typeof timer === "object") timer.cleared = true;
  };
  global.setInterval = function (fn, ms) {
    const timer = { fn, ms, cleared: false };
    intervals.push(timer);
    return timer;
  };
  global.clearInterval = function (timer) {
    if (timer && typeof timer === "object") timer.cleared = true;
  };

  return {
    timeouts: timeouts,
    intervals: intervals,
    flushTimeouts() {
      timeouts.slice().forEach((timer) => {
        if (!timer.cleared) timer.fn();
      });
    },
    flushIntervals() {
      intervals.slice().forEach((timer) => {
        if (!timer.cleared) timer.fn();
      });
    },
    restore() {
      Object.assign(global, original);
    },
  };
}

console.log("\nАвтопроверка станций");
test("по умолчанию автопроверка включена", () => {
  reset();
  assert.strictEqual(store.state.ui.autoHealthCheck, true);
  assert.strictEqual(store.serialize().ui.autoHealthCheck, true);
});

test("hydrate: отсутствие поля включает автопроверку", () => {
  store.hydrate({ version: 2, ui: { bufferEnabled: false } });
  assert.strictEqual(store.state.ui.autoHealthCheck, true);
});

test("hydrate: false выключает автопроверку", () => {
  store.hydrate({ version: 2, ui: { autoHealthCheck: false } });
  assert.strictEqual(store.state.ui.autoHealthCheck, false);
});

test("hydrate: только явный false выключает автопроверку", () => {
  store.hydrate({ version: 2, ui: { autoHealthCheck: true } });
  assert.strictEqual(store.state.ui.autoHealthCheck, true);

  store.hydrate({ version: 2, ui: { autoHealthCheck: 0 } });
  assert.strictEqual(store.state.ui.autoHealthCheck, true);
});

test("setAutoHealthCheck возвращает фактическое значение", () => {
  reset();
  assert.strictEqual(store.setAutoHealthCheck(false), false);
  assert.strictEqual(store.state.ui.autoHealthCheck, false);
  assert.strictEqual(store.setAutoHealthCheck(true), true);
  assert.strictEqual(store.state.ui.autoHealthCheck, true);
  assert.strictEqual(store.setAutoHealthCheck(0), false);
  assert.strictEqual(store.setAutoHealthCheck("yes"), true);
});

test("setAutoHealthCheck сохраняется и сбрасывается", () => {
  reset();
  let events = 0;
  const off = store.on("ui", function () { events += 1; });

  store.setAutoHealthCheck(false);
  off();
  assert.strictEqual(events, 1);

  store.saveNow();
  assert.strictEqual(readSaved().ui.autoHealthCheck, false);

  store.resetAll();
  assert.strictEqual(store.state.ui.autoHealthCheck, true);
  assert.strictEqual(readSaved().ui.autoHealthCheck, true);
});

console.log("\nАвтозапуск проверки");
test("автостарт не срабатывает при выключенной автопроверке", () => {
  reset();
  store.setAutoHealthCheck(false);

  const visibilityListeners = [];
  global.document = {
    visibilityState: "visible",
    addEventListener(type, handler) {
      if (type === "visibilitychange") visibilityListeners.push(handler);
    },
  };

  const fakeTimers = installFakeTimers();
  try {
    require(path.join(root, "js/services/health.js"));
    MR.health.init();

    assert.strictEqual(MR.health.isRunning, false, "до тиков проверка не идёт");

    fakeTimers.flushTimeouts(); // первичная проверка через 250 мс
    assert.strictEqual(MR.health.isRunning, false, "первичный автостарт выключен");

    fakeTimers.flushIntervals(); // плановая проверка раз в 90 с
    assert.strictEqual(MR.health.isRunning, false, "плановый тик выключен");

    visibilityListeners.forEach((listener) => listener({ type: "visibilitychange" }));
    assert.strictEqual(MR.health.isRunning, false, "проверка при возврате на вкладку выключена");
    assert.strictEqual(store.state.healthProgress.running, false);

    // Включение настройки возвращает плановые тики без пересоздания таймеров.
    store.setAutoHealthCheck(true);
    fakeTimers.flushIntervals();
    assert.strictEqual(MR.health.isRunning, true, "после включения тик запускает проверку");
  } finally {
    MR.health.dispose();
    fakeTimers.restore();
  }
});

console.log("\n" + passed + " passed, " + failures.length + " failed\n");

if (failures.length > 0) {
  failures.forEach((failure) => {
    console.error("\n" + failure.name);
    console.error(failure.error.stack);
  });
  process.exit(1);
}
