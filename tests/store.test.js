/**
 * tests/store.test.js — проверки логики без браузера.
 * Запуск: node tests/store.test.js
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

global.window = global;
global.localStorage = createStorage();
global.Audio = function () {};

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

console.log("\nConfig");
test("8 станций, уникальные id и имена, валидные URL", () => {
  const stations = store.state.stations;
  assert.strictEqual(stations.length, 8);
  assert.strictEqual(new Set(stations.map((s) => s.id)).size, 8);
  assert.strictEqual(new Set(stations.map((s) => s.name.toLowerCase())).size, 8);
  stations.forEach((s) => {
    assert.ok(MR.utils.isHttpUrl(s.primary), s.name + ": primary");
    s.fallbacks.forEach((url) => assert.ok(MR.utils.isHttpUrl(url), s.name + ": fallback"));
  });
});

test("10 полос эквалайзера и 7 пресетов", () => {
  assert.strictEqual(MR.defaults.eqBands.length, 10);
  assert.strictEqual(Object.keys(MR.defaults.eqPresets).length, 7);
  assert.strictEqual(MR.defaults.findPreset(new Array(10).fill(0)), "flat");
});

console.log("\nСтанции");
test("станция без URL отклоняется", () => {
  const result = store.addStation({ name: "Test", primary: "ftp://bad" });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.primary);
});

test("дубликат имени без учёта регистра отклоняется", () => {
  const result = store.addStation({ name: "groove salad", primary: "https://example.com/a.mp3" });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.name);
});

test("кириллица превращается в читаемый id", () => {
  const result = store.addStation({ name: "Наше Радио Тест", primary: "https://example.com/nashe.mp3" });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.station.id, "nashe-radio-test");
});

test("добавление с резервами и группой", () => {
  const group = store.addGroup({ name: "Для теста", stationIds: [] }).group;
  const result = store.addStation({
    name: "Deep Focus",
    primary: "https://example.com/focus.mp3",
    fallbacks: ["https://example.com/focus2.mp3", "bad-url"],
    groupId: group.id,
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.fallbacks);

  const good = store.addStation({
    name: "Deep Focus",
    primary: "https://example.com/focus.mp3",
    fallbacks: ["https://example.com/focus2.mp3"],
    groupId: group.id,
  });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.station.fallbacks.length, 1);
  assert.strictEqual(store.getGroupOfStation(good.station.id).id, group.id);
});

test("редактирование возвращает streamChanged", () => {
  const station = store.findStation("groove-salad");
  const result = store.updateStation(station.id, {
    name: station.name,
    genre: station.genre,
    bitrate: station.bitrate,
    primary: "https://ice2.somafm.com/groovesalad-128-mp3",
    fallbacks: station.fallbacks,
    groupId: "",
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.streamChanged, true);
});

test("удаление чистит избранное, группы и здоровье", () => {
  const station = store.addStation({ name: "Temp", primary: "https://example.com/temp.mp3" }).station;
  store.toggleFavorite(station.id);
  store.setHealth(station.id, { primary: { ok: true }, fallbacks: [] });
  store.removeStation(station.id);
  assert.strictEqual(store.state.favorites.has(station.id), false);
  assert.strictEqual(store.getHealth(station.id), null);
  store.state.groups.forEach((g) => assert.ok(!g.stationIds.includes(station.id)));
});

console.log("\nГруппы");
test("создание группы", () => {
  reset();
  const result = store.addGroup({ name: "  Вечер  ", stationIds: ["groove-salad"] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.group.name, "Вечер");
  assert.deepStrictEqual(result.group.stationIds, ["groove-salad"]);
});

test("дубликат группы отклоняется", () => {
  reset();
  store.addGroup({ name: "Вечер" });
  const result = store.addGroup({ name: "вечер" });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.name);
});

test("станция переезжает между группами без дублей", () => {
  reset();
  const a = store.addGroup({ name: "A", stationIds: ["groove-salad", "drone-zone"] }).group;
  const b = store.addGroup({ name: "B", stationIds: ["drone-zone"] }).group;
  assert.deepStrictEqual(store.getGroup(a.id).stationIds, ["groove-salad"]);
  assert.deepStrictEqual(store.getGroup(b.id).stationIds, ["drone-zone"]);
  store.assignStationToGroup("groove-salad", b.id);
  assert.deepStrictEqual(store.getGroup(a.id).stationIds, []);
  assert.deepStrictEqual(store.getGroup(b.id).stationIds, ["drone-zone", "groove-salad"]);
});

test("редактирование группы переименовывает и меняет состав", () => {
  reset();
  const group = store.addGroup({ name: "Утро", stationIds: ["groove-salad", "fip"] }).group;
  const result = store.updateGroup(group.id, { name: "Утро 2", stationIds: ["fip", "dfm"] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(store.getGroup(group.id).name, "Утро 2");
  assert.deepStrictEqual(store.getGroup(group.id).stationIds, ["fip", "dfm"]);
});

test("удаление группы сбрасывает активный фильтр", () => {
  reset();
  const group = store.addGroup({ name: "Фильтр", stationIds: ["fip"] }).group;
  store.setFilters({ groupId: group.id });
  store.deleteGroup(group.id);
  assert.strictEqual(store.state.filters.groupId, null);
});

test("фильтр и поиск работают вместе", () => {
  reset();
  const group = store.addGroup({ name: "Soma", stationIds: ["groove-salad", "drone-zone"] }).group;
  store.setFilters({ groupId: group.id, query: "drone" });
  const visible = store.getVisibleStations();
  assert.strictEqual(visible.length, 1);
  assert.strictEqual(visible[0].id, "drone-zone");
});

test("избранное фильтруется", () => {
  reset();
  store.toggleFavorite("fip");
  store.toggleFavorite("dfm");
  store.setFilters({ favoritesOnly: true });
  assert.strictEqual(store.getVisibleStations().length, 2);
  store.toggleFavorite("fip");
  assert.strictEqual(store.getVisibleStations().length, 1);
});

console.log("\nСохранение и импорт");
test("сохранение и восстановление снимка", () => {
  reset();
  store.addGroup({ name: "Снимок", stationIds: ["fip"] });
  store.toggleFavorite("dfm");
  store.setVolume(0.42);
  store.setEqGain(0, 7);
  store.setBgEnabled(false);
  store.setVisualizerMode("orbit");
  store.saveNow();

  const saved = MR.storage.get(MR.config.storageKey, null);
  assert.ok(saved && saved.version === 2);
  assert.strictEqual(saved.favorites.length, 1);

  const counts = store.hydrate(saved);
  assert.strictEqual(counts.groups, 1);
  assert.strictEqual(store.state.volume, 0.42);
  assert.strictEqual(store.state.eqGains[0], 7);
  assert.strictEqual(store.state.ui.bgEnabled, false);
  assert.strictEqual(store.state.ui.mode, "orbit");
  assert.deepStrictEqual(store.getGroup(store.state.groups[0].id).stationIds, ["fip"]);
});

test("миграция v1: stationGroups превращается в членство", () => {
  MR.storage.remove(MR.config.storageKey);
  const legacy = {
    version: 1,
    volume: 0.65,
    equalizer: [{ gain: 3 }, { gain: -2 }],
    favorites: ["fip"],
    groups: [{ id: "group-1", name: "Старая", stationIds: [] }],
    stationGroups: { "groove-salad": "group-1" },
    stations: [
      { id: "fip", name: "FIP", genre: "Jazz", bitrate: "128", primary: "https://icecast.radiofrance.fr/fip-midfi.mp3", fallbacks: [], emoji: "🎷" },
      { id: "groove-salad", name: "Groove Salad", genre: "Chill", bitrate: "128", primary: "https://ice1.somafm.com/groovesalad-128-mp3", fallbacks: [], emoji: "🌊" },
    ],
  };

  const result = store.importData(legacy);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(store.state.stations.length, 2);
  assert.strictEqual(store.state.volume, 0.65);
  assert.strictEqual(store.state.eqGains[0], 3);
  assert.strictEqual(store.state.eqGains[1], -2);
  assert.deepStrictEqual(store.getGroup("group-1").stationIds, ["groove-salad"]);
});

test("импорт отвергает неизвестную версию", () => {
  const result = store.importData({ version: 99 });
  assert.strictEqual(result.ok, false);
  assert.ok(/версия/i.test(result.error));
});

test("сброс возвращает стандартный набор", () => {
  store.addStation({ name: "Временная", primary: "https://example.com/x.mp3" });
  store.resetAll();
  assert.strictEqual(store.state.stations.length, 8);
  assert.strictEqual(store.state.groups.length, 0);
  assert.strictEqual(store.state.favorites.size, 0);
  assert.strictEqual(store.state.volume, 0.8);
});

test("служебные функции не падают без данных", () => {
  assert.strictEqual(store.getHealthSummary().total, store.state.stations.length);
  assert.strictEqual(store.getStationUrls(null).length, 0);
  assert.strictEqual(store.findStation("nope"), null);
  assert.strictEqual(store.getGroupOfStation("nope"), null);
});

console.log("\n" + passed + " passed, " + failures.length + " failed\n");

if (failures.length > 0) {
  failures.forEach((failure) => {
    console.error("\n" + failure.name);
    console.error(failure.error.stack);
  });
  process.exit(1);
}
