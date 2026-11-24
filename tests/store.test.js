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

function stationInput(station) {
  return {
    name: station.name,
    genre: station.genre,
    emoji: station.emoji,
    sources: station.sources.map((source) => ({
      url: source.url,
      bitrate: source.bitrate,
    })),
    groupId: "",
  };
}

console.log("\nConfig");
test("8 станций с источниками, уникальные id и имена", () => {
  const stations = store.state.stations;
  assert.strictEqual(stations.length, 8);
  assert.strictEqual(new Set(stations.map((s) => s.id)).size, 8);
  assert.strictEqual(new Set(stations.map((s) => s.name.toLowerCase())).size, 8);

  stations.forEach((station) => {
    assert.ok(Array.isArray(station.sources) && station.sources.length > 0, station.name + ": sources");
    station.sources.forEach((source) => {
      assert.ok(MR.utils.isHttpUrl(source.url), station.name + ": url");
      assert.ok(Number.isInteger(source.bitrate) && source.bitrate >= 0, station.name + ": bitrate");
    });
  });

  const fip = stations.find((s) => s.id === "fip");
  assert.strictEqual(store.getStationBitrate(fip), 192);
});

test("10 полос эквалайзера и 7 пресетов", () => {
  assert.strictEqual(MR.defaults.eqBands.length, 10);
  assert.strictEqual(Object.keys(MR.defaults.eqPresets).length, 7);
  assert.strictEqual(MR.defaults.findPreset(new Array(10).fill(0)), "flat");
});

console.log("\nСтанции");
test("станция без валидного источника отклоняется", () => {
  const result = store.addStation({
    name: "Test",
    sources: [{ url: "ftp://bad", bitrate: 128 }],
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors["sources.0.url"]);
});

test("дубликат имени без учёта регистра отклоняется", () => {
  const result = store.addStation({
    name: "groove salad",
    sources: [{ url: "https://example.com/a.mp3", bitrate: 128 }],
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.name);
});

test("кириллица превращается в читаемый id", () => {
  const result = store.addStation({
    name: "Наше Радио Тест",
    sources: [{ url: "https://example.com/nashe.mp3", bitrate: 128 }],
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.station.id, "nashe-radio-test");
});

test("источники с битрейтами и группой", () => {
  const group = store.addGroup({ name: "Для теста", stationIds: [] }).group;
  const result = store.addStation({
    name: "Deep Focus",
    sources: [
      { url: "https://example.com/focus.mp3", bitrate: "192 kbps" },
      { url: "https://example.com/focus2.mp3", bitrate: 320 },
    ],
    groupId: group.id,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.station.sources.length, 2);
  assert.strictEqual(result.station.sources[0].bitrate, 192);
  assert.strictEqual(result.station.sources[1].bitrate, 320);
  assert.strictEqual(store.getGroupOfStation(result.station.id).id, group.id);
});

test("некорректный битрейт отклоняется", () => {
  const result = store.addStation({
    name: "Bad Bitrate",
    sources: [{ url: "https://example.com/bad.mp3", bitrate: "abc" }],
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors["sources.0.bitrate"]);
});

test("дубликат URL внутри станции отклоняется", () => {
  const result = store.addStation({
    name: "Duplicate Inside",
    sources: [
      { url: "https://example.com/same.mp3", bitrate: 128 },
      { url: "https://example.com/same.mp3", bitrate: 320 },
    ],
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors["sources.1.url"]);
});

test("поток другой станции нельзя добавить повторно", () => {
  const result = store.addStation({
    name: "Duplicate Across",
    sources: [{ url: "https://example.com/focus.mp3", bitrate: 128 }],
  });
  assert.strictEqual(result.ok, false);
  assert.ok(/уже добавлен/.test(result.errors["sources.0.url"]));
});

test("порядок воспроизведения — по убыванию битрейта", () => {
  const result = store.addStation({
    name: "Bitrate Order",
    sources: [
      { url: "https://example.com/order-a.mp3", bitrate: 128 },
      { url: "https://example.com/order-b.mp3", bitrate: 320 },
      { url: "https://example.com/order-c.mp3", bitrate: 0 },
      { url: "https://example.com/order-d.mp3", bitrate: 192 },
    ],
  });

  assert.strictEqual(result.ok, true);
  const ordered = store.getPlaybackSources(result.station);
  assert.deepStrictEqual(ordered.map((source) => source.bitrate), [320, 192, 128, 0]);
  assert.deepStrictEqual(ordered.map((source) => source.url), [
    "https://example.com/order-b.mp3",
    "https://example.com/order-d.mp3",
    "https://example.com/order-a.mp3",
    "https://example.com/order-c.mp3",
  ]);
  assert.strictEqual(store.getStationBitrate(result.station), 320);
  assert.deepStrictEqual(store.getStationUrls(result.station), [
    "https://example.com/order-a.mp3",
    "https://example.com/order-b.mp3",
    "https://example.com/order-c.mp3",
    "https://example.com/order-d.mp3",
  ]);
});

test("редактирование возвращает streamChanged", () => {
  const station = store.findStation("groove-salad");
  const input = stationInput(station);
  input.sources[0] = { url: "https://example.com/new-primary.mp3", bitrate: 320 };

  const result = store.updateStation(station.id, input);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.streamChanged, true);
  assert.strictEqual(store.findStation(station.id).sources[0].bitrate, 320);

  const again = store.updateStation(station.id, stationInput(store.findStation(station.id)));
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.streamChanged, false);
});

test("старый формат primary/fallbacks + bitrate нормализуется", () => {
  const result = store.addStation({
    name: "Legacy Input",
    bitrate: "128 kbps",
    primary: "https://example.com/legacy.mp3",
    fallbacks: ["https://example.com/legacy2.mp3"],
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.station.sources, [
    { url: "https://example.com/legacy.mp3", bitrate: 128 },
    { url: "https://example.com/legacy2.mp3", bitrate: 128 },
  ]);
});

test("удаление чистит избранное, группы и здоровье", () => {
  const station = store.addStation({
    name: "Temp",
    sources: [{ url: "https://example.com/temp.mp3", bitrate: 128 }],
  }).station;
  store.toggleFavorite(station.id);
  store.setHealth(station.id, { sources: [{ ok: true }], checkedAt: Date.now() });
  store.removeStation(station.id);
  assert.strictEqual(store.state.favorites.has(station.id), false);
  assert.strictEqual(store.getHealth(station.id), null);
  store.state.groups.forEach((group) => assert.ok(!group.stationIds.includes(station.id)));
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

console.log("\nЗдоровье источников");
test("сводка учитывает лучший битрейт", () => {
  reset();
  store.setHealth("fip", {
    sources: [{ ok: false, reason: "timeout" }, { ok: true }],
    checkedAt: Date.now(),
  });
  let summary = store.getHealthSummary();
  assert.strictEqual(summary.checked, 1);
  assert.strictEqual(summary.online, 0);
  assert.strictEqual(summary.fallbackOnly, 1);
  assert.strictEqual(summary.offline, 0);

  store.setHealth("fip", {
    sources: [{ ok: true }, { ok: false, reason: "media-error" }],
    checkedAt: Date.now(),
  });
  summary = store.getHealthSummary();
  assert.strictEqual(summary.online, 1);
  assert.strictEqual(summary.fallbackOnly, 0);

  store.setHealth("fip", {
    sources: [{ ok: false, reason: "timeout" }, { ok: false, reason: "media-error" }],
    checkedAt: Date.now(),
  });
  summary = store.getHealthSummary();
  assert.strictEqual(summary.offline, 1);
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
  assert.ok(Array.isArray(saved.stations[0].sources));
  assert.strictEqual(saved.favorites.length, 1);

  const counts = store.hydrate(saved);
  assert.strictEqual(counts.groups, 1);
  assert.strictEqual(store.state.volume, 0.42);
  assert.strictEqual(store.state.eqGains[0], 7);
  assert.strictEqual(store.state.ui.bgEnabled, false);
  assert.strictEqual(store.state.ui.mode, "orbit");
  assert.deepStrictEqual(store.getGroup(store.state.groups[0].id).stationIds, ["fip"]);
  assert.ok(store.findStation("fip").sources.length >= 1);
});

test("миграция v1: stationGroups и старые источники", () => {
  MR.storage.remove(MR.config.storageKey);
  const legacy = {
    version: 1,
    volume: 0.65,
    equalizer: [{ gain: 3 }, { gain: -2 }],
    favorites: ["fip"],
    groups: [{ id: "group-1", name: "Старая", stationIds: [] }],
    stationGroups: { "groove-salad": "group-1" },
    stations: [
      { id: "fip", name: "FIP", genre: "Jazz", bitrate: "128", primary: "https://icecast.radiofrance.fr/fip-midfi.mp3", fallbacks: ["https://icecast.radiofrance.fr/fip-hifi.aac"], emoji: "🎷" },
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

  const fip = store.findStation("fip");
  assert.deepStrictEqual(fip.sources, [
    { url: "https://icecast.radiofrance.fr/fip-midfi.mp3", bitrate: 128 },
    { url: "https://icecast.radiofrance.fr/fip-hifi.aac", bitrate: 128 },
  ]);
});

test("импорт отвергает неизвестную версию", () => {
  const result = store.importData({ version: 99 });
  assert.strictEqual(result.ok, false);
  assert.ok(/версия/i.test(result.error));
});

test("сброс возвращает стандартный набор", () => {
  store.addStation({
    name: "Временная",
    sources: [{ url: "https://example.com/x.mp3", bitrate: 128 }],
  });
  store.resetAll();
  assert.strictEqual(store.state.stations.length, 8);
  assert.strictEqual(store.state.groups.length, 0);
  assert.strictEqual(store.state.favorites.size, 0);
  assert.strictEqual(store.state.volume, 0.8);
});

test("служебные функции не падают без данных", () => {
  assert.strictEqual(store.getHealthSummary().total, store.state.stations.length);
  assert.strictEqual(store.getStationUrls(null).length, 0);
  assert.strictEqual(store.getStationSources(null).length, 0);
  assert.strictEqual(store.getStationBitrate(null), 0);
  assert.strictEqual(store.findStation("nope"), null);
  assert.strictEqual(store.getGroupOfStation("nope"), null);
});

console.log("\nБуфер эфира");
test("по умолчанию буфер включён на 3 минуты", () => {
  reset();
  assert.strictEqual(store.state.ui.bufferEnabled, true);
  assert.strictEqual(store.state.ui.bufferMinutes, 3);
  assert.deepStrictEqual(MR.config.timemachine.options, [1, 2, 3, 5, 10]);
});

test("hydrate валидирует bufferEnabled и bufferMinutes", () => {
  store.hydrate({ version: 2, ui: { bufferEnabled: false, bufferMinutes: 7 } });
  assert.strictEqual(store.state.ui.bufferEnabled, false);
  assert.strictEqual(store.state.ui.bufferMinutes, 3);

  store.hydrate({ version: 2, ui: { bufferEnabled: true, bufferMinutes: 5 } });
  assert.strictEqual(store.state.ui.bufferEnabled, true);
  assert.strictEqual(store.state.ui.bufferMinutes, 5);
});

test("действия буфера возвращают фактическое значение и сохраняются", () => {
  reset();
  assert.strictEqual(store.setBufferMinutes(5), 5);
  assert.strictEqual(store.setBufferEnabled(false), false);
  assert.strictEqual(store.setBufferMinutes(7), 3);

  const saved = store.serialize();
  assert.strictEqual(saved.ui.bufferEnabled, false);
  assert.strictEqual(saved.ui.bufferMinutes, 3);

  store.setBufferEnabled(true);
  assert.strictEqual(store.state.ui.bufferEnabled, true);
});

console.log("\n" + passed + " passed, " + failures.length + " failed\n");

if (failures.length > 0) {
  failures.forEach((failure) => {
    console.error("\n" + failure.name);
    console.error(failure.error.stack);
  });
  process.exit(1);
}
