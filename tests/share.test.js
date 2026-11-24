/**
 * tests/share.test.js — проверки ссылок обмена без браузера.
 * Запуск: node tests/share.test.js
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
global.location = {
  href: "file:///C:/radio/index.html",
  pathname: "/C:/radio/index.html",
  search: "",
  hash: "",
};

const root = path.join(__dirname, "..");
[
  "js/core/utils.js",
  "js/config/app.js",
  "js/config/stations.js",
  "js/config/equalizer.js",
  "js/core/storage.js",
  "js/core/state.js",
  "js/services/share.js",
].forEach((file) => require(path.join(root, file)));

const MR = global.MR;
const store = MR.store;
const share = MR.share;
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

function stationPayload(name, url, bitrate) {
  return {
    v: 1,
    type: "station",
    station: {
      name: name,
      genre: "Эмбиент",
      emoji: "🎧",
      sources: [{ url: url, bitrate: bitrate }],
    },
  };
}

function setHash(payload) {
  const encoded = share.encode(payload);
  global.location.hash = "#share=" + encoded;
  global.location.search = "";
  return encoded;
}

function clearStub() {
  global.location.hash = "";
  global.location.search = "";
}

console.log("\nКодирование");
test("base64url без «+», «/» и «=»", () => {
  const payload = stationPayload("Тест", "https://example.com/a.mp3", 128);
  const encoded = share.encode(payload);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(encoded), encoded);
  assert.strictEqual(encoded.indexOf("="), -1);
  assert.deepStrictEqual(share.decode(encoded), payload);
});

test("UTF-8: кириллица и эмодзи переживают roundtrip", () => {
  const payload = {
    v: 1,
    type: "station",
    station: {
      name: "Наше Радио 🌙",
      genre: "Русский рок",
      emoji: "🎸",
      sources: [{ url: "https://example.com/rus.mp3", bitrate: 320 }],
    },
  };
  const encoded = share.encode(payload);
  assert.deepStrictEqual(share.decode(encoded), payload);
});

test("decode отвергает повреждённую строку", () => {
  assert.throws(() => share.decode("%%%"), /повреждена/);
  assert.throws(() => share.decode(""), /Пустая ссылка/);
});

console.log("\nВалидация");
test("станция: корректный payload нормализуется", () => {
  const result = share.validate({
    v: 1,
    type: "station",
    station: { name: "  Ссылка  ", sources: [{ url: "https://example.com/s.mp3", bitrate: "192 kbps" }] },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.payload.station.name, "Ссылка");
  assert.strictEqual(result.payload.station.genre, "Без жанра");
  assert.strictEqual(result.payload.station.emoji, "📻");
  assert.deepStrictEqual(result.payload.station.sources, [
    { url: "https://example.com/s.mp3", bitrate: 192 },
  ]);
});

test("станция: неверная версия, имя и URL отклоняются", () => {
  assert.strictEqual(share.validate({ v: 99, type: "station" }).ok, false);
  assert.strictEqual(share.validate({ v: 2, type: "station" }).ok, false);
  assert.strictEqual(share.validate({
    v: 1, type: "station",
    station: { name: "", sources: [{ url: "https://example.com/a.mp3" }] },
  }).ok, false);
  assert.strictEqual(share.validate({
    v: 1, type: "station",
    station: { name: "FTP", sources: [{ url: "ftp://example.com/a.mp3" }] },
  }).ok, false);
  assert.strictEqual(share.validate({
    v: 1, type: "station",
    station: { name: "No sources", sources: [] },
  }).ok, false);
});

test("станция: больше шести источников отклоняется", () => {
  const sources = [];
  for (let i = 0; i < 7; i += 1) {
    sources.push({ url: "https://example.com/" + i + ".mp3", bitrate: 128 });
  }
  const result = share.validate({
    v: 1, type: "station",
    station: { name: "Много", sources: sources },
  });
  assert.strictEqual(result.ok, false);
  assert.ok(/слишком много/i.test(result.error));
});

test("группа: пустой состав и неизвестный тип отклоняются", () => {
  assert.strictEqual(share.validate({
    v: 1, type: "group", group: { name: "Пустая" }, stations: [],
  }).ok, false);
  assert.strictEqual(share.validate({ v: 1, type: "playlist" }).ok, false);
  assert.strictEqual(share.validate(null).ok, false);
});

console.log("\nСсылки");
test("buildStationLink: абсолютная ссылка и разбор payload", () => {
  reset();
  const station = store.findStation("fip");
  const link = share.buildStationLink(station);

  assert.ok(link.indexOf("file:///C:/radio/index.html#share=") === 0, link);
  const raw = link.split("#share=")[1];
  const parsed = share.parsePayload(raw);

  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.payload.type, "station");
  assert.strictEqual(parsed.payload.station.name, station.name);
  assert.deepStrictEqual(parsed.payload.station.sources, station.sources);
});

test("buildGroupLink: состав группы из stationIds", () => {
  reset();
  store.addGroup({ name: "Ссылочная", stationIds: ["fip", "dfm"] });
  const group = store.state.groups[0];
  const link = share.buildGroupLink(group);
  const parsed = share.parsePayload(link.split("#share=")[1]);

  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.payload.type, "group");
  assert.strictEqual(parsed.payload.group.name, "Ссылочная");
  assert.deepStrictEqual(
    parsed.payload.stations.map((station) => station.name),
    [store.findStation("fip").name, store.findStation("dfm").name]
  );
});

test("buildStationLink отклоняет станцию без источников", () => {
  assert.throws(() => share.buildStationLink({ name: "Пусто", sources: [] }), /источник/i);
});

console.log("\nРазбор location");
test("parseLocation читает #share=", () => {
  reset();
  setHash(stationPayload("Хеш", "https://example.com/hash.mp3", 128));
  const parsed = share.parseLocation();
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.payload.station.name, "Хеш");
  clearStub();
});

test("parseLocation читает ?share=", () => {
  reset();
  global.location.hash = "";
  global.location.search = "?foo=1&share=" +
    share.encode(stationPayload("Квери", "https://example.com/query.mp3", 96));
  const parsed = share.parseLocation();
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.payload.station.name, "Квери");
  clearStub();
});

test("без share-параметра возвращается ошибка", () => {
  clearStub();
  const parsed = share.parseLocation();
  assert.strictEqual(parsed.ok, false);
  assert.ok(parsed.error);
});

test("слишком длинный payload отклоняется", () => {
  global.location.hash = "#share=" + "A".repeat(share.MAX_PAYLOAD_LENGTH + 1);
  global.location.search = "";
  const parsed = share.parseLocation();
  assert.strictEqual(parsed.ok, false);
  assert.ok(/слишком длинная/i.test(parsed.error));
  clearStub();
});

test("неверная версия payload игнорируется", () => {
  setHash({ v: 99, type: "station", station: { name: "Old", sources: [] } });
  const parsed = share.parseLocation();
  assert.strictEqual(parsed.ok, false);
  assert.ok(/версия/i.test(parsed.error));
  clearStub();
});

console.log("\nПрименение");
test("станция добавляется, дубликат не создаётся", () => {
  reset();
  const payload = stationPayload("Ссылочная станция", "https://example.com/share-a.mp3", 192);
  const before = store.state.stations.length;

  const first = share.apply(payload);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(store.state.stations.length, before + 1);

  const added = store.state.stations.find((station) => station.name === "Ссылочная станция");
  assert.ok(added);
  assert.deepStrictEqual(added.sources, [{ url: "https://example.com/share-a.mp3", bitrate: 192 }]);

  const second = share.apply(payload);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(store.state.stations.length, before + 1);
});

test("станция с существующим URL не дублируется", () => {
  reset();
  const fip = store.findStation("fip");
  const payload = stationPayload("Другое имя", fip.sources[0].url, 128);
  const second = share.apply(payload);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.duplicate, true);
});

test("группа создаёт станции и проставляет stationIds", () => {
  reset();
  const payload = {
    v: 1,
    type: "group",
    group: { name: "Из ссылки" },
    stations: [
      { name: "Групповая один", genre: "Chill", emoji: "🌊", sources: [{ url: "https://example.com/g1.mp3", bitrate: 128 }] },
      { name: "Групповая два", genre: "Jazz", emoji: "🎷", sources: [{ url: "https://example.com/g2.mp3", bitrate: 320 }] },
    ],
  };

  const before = store.state.stations.length;
  const result = share.apply(payload);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(store.state.stations.length, before + 2);

  const group = store.state.groups.find((item) => item.name === "Из ссылки");
  assert.ok(group);
  assert.strictEqual(group.stationIds.length, 2);
  assert.deepStrictEqual(
    group.stationIds.map((id) => store.findStation(id).name),
    ["Групповая один", "Групповая два"]
  );

  // Повторное применение не создаёт дубликатов: станции переиспользуются.
  const again = share.apply(payload);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.merged, true);
  assert.strictEqual(store.state.stations.length, before + 2);
  assert.strictEqual(store.state.groups.filter((item) => item.name === "Из ссылки").length, 1);
});

test("группа переиспользует станцию по URL", () => {
  reset();
  const fip = store.findStation("fip");
  const payload = {
    v: 1,
    type: "group",
    group: { name: "С FIP" },
    stations: [
      { name: "FIP копия", genre: "Jazz", emoji: "🎷", sources: [{ url: fip.sources[0].url, bitrate: 192 }] },
    ],
  };

  const before = store.state.stations.length;
  const result = share.apply(payload);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(store.state.stations.length, before);

  const group = store.state.groups.find((item) => item.name === "С FIP");
  assert.deepStrictEqual(group.stationIds, ["fip"]);
});

test("некорректный payload не меняет состояние", () => {
  reset();
  const before = store.state.stations.length;
  const result = share.apply({ v: 1, type: "station", station: { name: "Bad", sources: [{ url: "javascript:alert(1)" }] } });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(store.state.stations.length, before);
});

console.log("\nАдресная строка");
test("clearLocation убирает #share через replaceState", () => {
  const calls = [];
  global.history = {
    replaceState: function (state, title, url) { calls.push(url); },
  };
  global.location.hash = "#share=abc";
  global.location.search = "";

  share.clearLocation();
  assert.deepStrictEqual(calls, ["file:///C:/radio/index.html"]);

  delete global.history;
  global.location.hash = "";
});

console.log("\n" + passed + " passed, " + failures.length + " failed\n");

if (failures.length > 0) {
  failures.forEach((failure) => {
    console.error("\n" + failure.name);
    console.error(failure.error.stack);
  });
  process.exit(1);
}
