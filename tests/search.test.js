/**
 * tests/search.test.js — логика поиска станций без браузера.
 * Запуск: node tests/search.test.js
 *
 * Проверяет нормализацию записей каталогов, слияние дублей по URL и
 * метаданным, выбор основного источника, фильтры встроенного каталога,
 * добавление в коллекцию и устойчивость search() к упавшим каталогам.
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
global.Audio = function AudioStub() {};

const root = path.join(__dirname, "..");
[
  "js/core/utils.js",
  "js/config/app.js",
  "js/config/stations.js",
  "js/config/equalizer.js",
  "js/config/search-providers.js",
  "js/core/storage.js",
  "js/core/state.js",
  "js/services/radio-search.js",
].forEach((file) => require(path.join(root, file)));

const MR = global.MR;
const store = MR.store;
const search = MR.radioSearch;
const providersConfig = MR.searchProviders;

store.init();
search.init();

let passed = 0;
const failures = [];
const queue = [];

function section(title) {
  queue.push({ section: title });
}

function test(name, fn) {
  queue.push({ name: name, fn: fn });
}

async function run() {
  for (const item of queue) {
    if (item.section) {
      console.log("\n" + item.section);
      continue;
    }
    try {
      await item.fn();
      passed += 1;
      console.log("  ✓ " + item.name);
    } catch (error) {
      failures.push({ name: item.name, error: error });
      console.log("  ✗ " + item.name + " — " + error.message);
    }
  }

  search.dispose();

  console.log("\n" + passed + " passed, " + failures.length + " failed");
  if (failures.length) {
    failures.forEach((item) => {
      console.error("\n" + item.name + "\n" + (item.error.stack || item.error.message));
    });
    process.exit(1);
  }
}

function reset() {
  store.resetAll();
  return store.state;
}

function record(overrides) {
  return Object.assign({
    name: "Test FM",
    url: "https://example.com/stream.mp3",
    bitrate: 128,
    countryCode: "US",
    language: "en",
    genre: "Test",
    tags: ["test"],
    homepage: "https://example.com/",
  }, overrides || {});
}

function provider(id, label) {
  return { id: id, label: label || id };
}

section("Каталоги");

test("не меньше шести каталогов с уникальными id", () => {
  const ids = providersConfig.providers.map((item) => item.id);
  assert.ok(ids.length >= 6, "каталогов: " + ids.length);
  assert.strictEqual(new Set(ids).size, ids.length, "id каталогов уникальны");
  providersConfig.providers.forEach((item) => {
    assert.ok(item.label, item.id + ": подпись");
    assert.ok(item.adapter, item.id + ": адаптер");
  });
});

test("встроенный каталог: 25–60 записей и валидные URL", () => {
  const catalog = providersConfig.fallbackCatalog;
  assert.ok(catalog.length >= 25, "записей: " + catalog.length);
  assert.ok(catalog.length <= 60, "записей: " + catalog.length);
  catalog.forEach((item) => {
    assert.ok(item.name, "название");
    assert.ok(MR.utils.isHttpUrl(item.url), item.name + ": URL " + item.url);
    assert.ok(item.provider, item.name + ": каталог");
    assert.ok(Number.isInteger(item.bitrate), item.name + ": битрейт");
  });
});

test("резервный каталог отдаёт 25–60 станций после слияния", () => {
  const stations = search.getFallbackMatches({});
  assert.ok(stations.length >= 25, "станций: " + stations.length);
  assert.ok(stations.length <= 60, "станций: " + stations.length);
  stations.forEach((station) => {
    assert.ok(station.sources.length > 0, station.name + ": источники");
    assert.ok(station.providers.length > 0, station.name + ": бейджи");
    assert.ok(station.bitrates.length > 0, station.name + ": битрейты");
    assert.ok(station.primaryUrl, station.name + ": основной URL");
  });
});

section("Нормализация");

test("normalizeRecord отбрасывает записи без названия и URL", () => {
  assert.strictEqual(search.normalizeRecord({ name: "", url: "https://a.b/c" }, provider("p1")), null);
  assert.strictEqual(search.normalizeRecord({ name: "A", url: "ftp://a.b/c" }, provider("p1")), null);
  assert.strictEqual(search.normalizeRecord(null, provider("p1")), null);
});

test("normalizeRecord приводит страну, теги, битрейт и каталог", () => {
  const item = search.normalizeRecord(record({
    countryCode: "us",
    tags: "Chill, Ambient, chill",
    bitrate: "320 kbps",
    codec: "MP3",
    language: "EN",
  }), provider("somafm", "SomaFM"));

  assert.strictEqual(item.countryCode, "US");
  assert.strictEqual(item.country, "США");
  assert.deepStrictEqual(item.tags, ["chill", "ambient"]);
  assert.strictEqual(item.bitrate, 320);
  assert.strictEqual(item.codec, "mp3");
  assert.strictEqual(item.language, "en");
  assert.strictEqual(item.provider, "somafm");
  assert.strictEqual(item.providerLabel, "SomaFM");
});

test("normalizeRecord обрезает битрейт по лимиту", () => {
  const item = search.normalizeRecord(record({ bitrate: 4096 }), provider("p1"));
  assert.strictEqual(item.bitrate, MR.config.audio.maxBitrate);
});

section("Слияние");

test("одинаковый URL от разных каталогов — один источник и два бейджа", () => {
  const first = search.normalizeRecord(record({ bitrate: 128 }), provider("p1", "Первый"));
  const second = search.normalizeRecord(record({ bitrate: 320 }), provider("p2", "Второй"));
  const stations = search.mergeRecords([first, second]);

  assert.strictEqual(stations.length, 1);
  assert.strictEqual(stations[0].sources.length, 1);
  assert.strictEqual(stations[0].sources[0].bitrate, 320);
  assert.deepStrictEqual(
    stations[0].providers.map((item) => item.label).sort(),
    ["Второй", "Первый"]
  );
});

test("разные URL одной станции сливаются по метаданным", () => {
  const first = search.normalizeRecord(record({
    url: "https://example.com/a.mp3",
    bitrate: 128,
  }), provider("p1", "Первый"));
  const second = search.normalizeRecord(record({
    url: "https://example.com/b.aac",
    bitrate: 320,
    codec: "aac",
  }), provider("p2", "Второй"));

  const stations = search.mergeRecords([first, second]);
  assert.strictEqual(stations.length, 1);
  assert.strictEqual(stations[0].sources.length, 2);
  assert.deepStrictEqual(stations[0].bitrates, [128, 320]);
  assert.strictEqual(stations[0].primaryUrl, "https://example.com/b.aac");
  assert.strictEqual(stations[0].primaryBitrate, 320);
});

test("одинаковое название в разных странах не сливается", () => {
  const first = search.normalizeRecord(record({
    countryCode: "US",
    country: "США",
    homepage: "",
  }), provider("p1"));
  const second = search.normalizeRecord(record({
    url: "https://example.com/other.mp3",
    countryCode: "RU",
    country: "Россия",
    homepage: "",
  }), provider("p2"));

  const stations = search.mergeRecords([first, second]);
  assert.strictEqual(stations.length, 2);
});

test("без якоря (homepage, страна, язык) станции не сливаются", () => {
  const first = search.normalizeRecord(record({
    homepage: "",
    countryCode: "",
    country: "",
    language: "",
    genre: "",
    tags: [],
  }), provider("p1"));
  const second = search.normalizeRecord(record({
    url: "https://example.com/b.mp3",
    homepage: "",
    countryCode: "",
    country: "",
    language: "",
    genre: "",
    tags: [],
  }), provider("p2"));

  assert.strictEqual(search.mergeRecords([first, second]).length, 2);
});

test("pickPrimarySource выбирает максимальный битрейт", () => {
  const primary = search.pickPrimarySource([
    { url: "https://a/1.mp3", bitrate: 128 },
    { url: "https://a/2.mp3", bitrate: 320 },
    { url: "https://a/3.mp3", bitrate: 192 },
  ]);
  assert.strictEqual(primary.url, "https://a/2.mp3");
  assert.strictEqual(primary.bitrate, 320);
  assert.strictEqual(search.pickPrimarySource([]), null);
});

section("Фильтры резервного каталога");

test("поиск по названию находит Groove Salad", () => {
  const names = search.getFallbackMatches({ query: "groove" }).map((item) => item.name);
  assert.ok(names.indexOf("Groove Salad") !== -1, names.join(", "));
});

test("фильтр страны RU возвращает российские станции", () => {
  const stations = search.getFallbackMatches({ countryCode: "RU" });
  assert.ok(stations.length >= 10, "станций: " + stations.length);
  stations.forEach((station) => assert.strictEqual(station.countryCode, "RU"));
});

test("фильтр языка fr возвращает Radio France", () => {
  const stations = search.getFallbackMatches({ language: "fr" });
  assert.ok(stations.length >= 5, "станций: " + stations.length);
  stations.forEach((station) => assert.strictEqual(station.language, "fr"));
});

test("фильтр жанра jazz включает FIP", () => {
  const names = search.getFallbackMatches({ genre: "jazz" }).map((item) => item.name);
  assert.ok(names.indexOf("FIP") !== -1, names.join(", "));
});

test("Radio Paradise Main Mix собран из трёх битрейтов", () => {
  const station = search.getFallbackMatches({}).find((item) => item.name === "Radio Paradise: Main Mix");
  assert.ok(station, "станция найдена");
  assert.deepStrictEqual(station.bitrates, [128, 192, 320]);
  assert.strictEqual(station.sources.length, 3);
});

section("Добавление в коллекцию");

test("addRecord добавляет станцию с эмодзи и источниками", () => {
  reset();
  const station = search.getFallbackMatches({ query: "Record Deep" })[0];
  const result = search.addRecord(station);

  assert.strictEqual(result.ok, true);
  const added = store.state.stations.find((item) => item.id === result.station.id);
  assert.ok(added, "станция в store");
  assert.strictEqual(added.emoji, "🎧");
  assert.strictEqual(added.sources.length, station.sources.length);
});

test("повторное добавление не дублирует станцию", () => {
  const station = search.getFallbackMatches({ query: "Record Deep" })[0];
  const before = store.state.stations.length;
  const result = search.addRecord(station);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "exists");
  assert.strictEqual(store.state.stations.length, before);
});

test("findStationByRecord видит станцию по URL", () => {
  const station = search.getFallbackMatches({ query: "Record Deep" })[0];
  assert.ok(search.findStationByRecord(station));
  assert.strictEqual(search.findStationByRecord({ sources: [{ url: "https://nope.example/x" }] }), null);
});

section("Устойчивость поиска");

test("search без сети отдаёт резервный каталог и список ошибок", async () => {
  reset();
  const originalFetch = global.fetch;
  global.fetch = () => Promise.reject(new Error("network down"));

  try {
    const result = await search.search({}, {});
    assert.ok(result.results.length >= 25, "результатов: " + result.results.length);
    assert.ok(result.errors.length >= 1, "ошибки: " + result.errors.length);
    result.errors.forEach((item) => assert.ok(item.label, "подпись каталога"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("fallbackOnly не обращается к сети", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = () => { calls += 1; return Promise.reject(new Error("no")); };

  try {
    const result = await search.search({ query: "fip" }, { fallbackOnly: true });
    assert.strictEqual(calls, 0);
    assert.strictEqual(result.aborted, false);
    assert.ok(result.results.length >= 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("отменённый поиск не зависает и помечен aborted", async () => {
  const controller = new AbortController();
  const originalFetch = global.fetch;
  global.fetch = (url, options) => {
    if (options && options.signal && options.signal.aborted) {
      return Promise.reject(new Error("aborted"));
    }
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };

  try {
    controller.abort();
    const result = await search.search({}, { signal: controller.signal });
    assert.strictEqual(result.aborted, true);
    assert.ok(result.results.length >= 25);
  } finally {
    global.fetch = originalFetch;
  }
});

test("поиск не бросает исключение при упавших каталогах", async () => {
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error("sync failure"); };

  try {
    await assert.doesNotReject(() => search.search({ countryCode: "FR" }, {}));
  } finally {
    global.fetch = originalFetch;
  }
});

run();
