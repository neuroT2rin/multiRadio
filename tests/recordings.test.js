/**
 * tests/recordings.test.js — чистые функции архива записей и fallback без IDB.
 * Запуск: node tests/recordings.test.js
 *
 * В Node нет IndexedDB, поэтому здесь же проверяется аварийный режим:
 * модуль должен работать на массиве в памяти и честно сообщать persistent=false.
 */
"use strict";

const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");

/* --- Минимальное окружение браузера --- */
global.window = global;
require(path.join(root, "js/core/utils.js"));
require(path.join(root, "js/config/app.js"));

const MR = global.MR;

MR.dom = { el: function () { return {}; } };
MR.store = {
  state: { view: "recordings" },
  on: function () { return function off() {}; },
  emit: function () {},
};
MR.commands = { register: function () {} };
MR.modal = { confirm: function () { return Promise.resolve(false); } };

require(path.join(root, "js/services/recordings.js"));
require(path.join(root, "js/ui/recordings.js"));

const recordings = MR.recordings;
const formatClock = MR.recordingsUI.formatClock;

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ✓ " + name);
  } catch (error) {
    failures.push({ name: name, error: error });
    console.log("  ✗ " + name + " — " + error.message);
  }
}

function localDate(year, month, day, hours, minutes) {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

async function main() {
  console.log("Архив записей");

  await test("fileName: имя файла из станции, даты и mime", function () {
    const name = recordings.fileName({
      stationName: "Наше Радио",
      mimeType: "audio/webm;codecs=opus",
      createdAt: localDate(2026, 11, 24, 21, 42),
    });
    assert.strictEqual(name, "multiradio-nashe-radio-20261124-2142.webm");
  });

  await test("fileName: расширение по mime (ogg/m4a/wav/неизвестный)", function () {
    const base = { stationName: "FIP", createdAt: localDate(2026, 1, 2, 3, 4) };
    assert.strictEqual(
      recordings.fileName({ ...base, mimeType: "audio/ogg;codecs=opus" }),
      "multiradio-fip-20260102-0304.ogg"
    );
    assert.strictEqual(
      recordings.fileName({ ...base, mimeType: "audio/mp4" }),
      "multiradio-fip-20260102-0304.m4a"
    );
    assert.strictEqual(
      recordings.fileName({ ...base, mimeType: "audio/wav" }),
      "multiradio-fip-20260102-0304.wav"
    );
    assert.strictEqual(
      recordings.fileName({ ...base, mimeType: "" }),
      "multiradio-fip-20260102-0304.webm"
    );
  });

  await test("fileName: без имени станции берётся id", function () {
    const name = recordings.fileName({
      stationId: "lofi-beats",
      mimeType: "audio/webm",
      createdAt: localDate(2026, 5, 6, 7, 8),
    });
    assert.strictEqual(name, "multiradio-lofi-beats-20260506-0708.webm");
  });

  await test("formatClock: MM:SS и H:MM:SS", function () {
    assert.strictEqual(formatClock(0), "00:00");
    assert.strictEqual(formatClock(65000), "01:05");
    assert.strictEqual(formatClock(3599000), "59:59");
    assert.strictEqual(formatClock(3723000), "1:02:03");
    assert.strictEqual(formatClock(undefined), "00:00");
    assert.strictEqual(formatClock(-5000), "00:00");
  });

  await test("supported() в Node без IndexedDB → false", async function () {
    assert.strictEqual(await recordings.supported(), false);
  });

  await test("save/list/remove/clear работают в памяти при недоступном IDB", async function () {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });

    const older = await recordings.save({
      stationName: "Старая",
      createdAt: 1000,
      durationMs: 5000,
      mimeType: "audio/webm",
      blob: blob,
    });
    assert.strictEqual(older.ok, true);
    assert.strictEqual(older.persistent, false);
    assert.ok(older.entry.id);

    const newer = await recordings.save({
      stationName: "Новая",
      createdAt: 2000,
      durationMs: 7000,
      mimeType: "audio/webm",
      blob: blob,
    });
    assert.strictEqual(newer.ok, true);

    const items = await recordings.list();
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].stationName, "Новая", "свежие записи первыми");
    assert.strictEqual(items[1].stationName, "Старая");
    assert.strictEqual(items[0].size, 4, "размер берётся из blob");

    const found = await recordings.get(newer.entry.id);
    assert.strictEqual(found.stationId, "");

    const removed = await recordings.remove(newer.entry.id);
    assert.strictEqual(removed.ok, true);
    assert.strictEqual((await recordings.list()).length, 1);
    assert.strictEqual(await recordings.get(newer.entry.id), null);

    const cleared = await recordings.clear();
    assert.strictEqual(cleared.ok, true);
    assert.deepStrictEqual(await recordings.list(), []);

    assert.strictEqual(await recordings.isPersistent(), false);
  });

  await test("save пустого blob → { ok: false, error: 'empty' }", async function () {
    const result = await recordings.save({ stationName: "Пустая" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "empty");
  });

  console.log("");
  if (failures.length) {
    console.log("Провалено: " + failures.length + " из " + (passed + failures.length));
    failures.forEach(function (item) {
      console.error("\n" + item.name + "\n" + (item.error.stack || item.error));
    });
    process.exit(1);
  }

  console.log("Все проверки пройдены: " + passed + "/" + passed);
}

main().catch(function (error) {
  console.error(error.stack || error);
  process.exit(1);
});
