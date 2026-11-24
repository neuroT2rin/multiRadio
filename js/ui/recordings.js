/**
 * ui/recordings.js — вкладка «Записи»: архив фрагментов эфира.
 *
 * Список читается из `MR.recordings` асинхронно при открытии вкладки и после
 * события `record:saved`. Прослушивание — обычный `<audio>` с blob URL:
 * второй AudioContext не создаём. Blob URL освобождаются при удалении,
 * перерисовке и выгрузке страницы.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;

  /** id записи → { audio, url, durationSec, seek, time, button, blobUrl } */
  const players = new Map();

  let listEl = null;
  let emptyEl = null;
  let countEl = null;
  let clearBtn = null;
  let fallbackEl = null;
  let loadingEl = null;
  let offs = [];
  let loaded = false;
  let loadToken = 0;

  /* ------------------------------------------------------------------------
     Форматирование
     ------------------------------------------------------------------------ */

  /** Миллисекунды → «MM:SS» (или «H:MM:SS» для долгих записей). */
  function formatClock(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = function (value) { return value < 10 ? "0" + value : String(value); };

    if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(seconds);
    return pad(minutes) + ":" + pad(seconds);
  }

  /** Дата и время записи: «24 нояб., 21:42». */
  function formatDate(timestamp) {
    if (!timestamp) return "—";
    const date = new Date(timestamp);
    const day = date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return day + ", " + time;
  }

  /* ------------------------------------------------------------------------
     Blob URL: освобождение
     ------------------------------------------------------------------------ */

  function release(id) {
    const player = players.get(id);
    if (!player) return;

    try { player.audio.pause(); } catch (error) { /* элемент уже удалён */ }
    try {
      player.audio.removeAttribute("src");
      player.audio.load();
    } catch (error) {
      // Некоторые браузеры не дают load() без src — не критично.
    }

    if (player.url) {
      try { URL.revokeObjectURL(player.url); } catch (error) { /* уже отозван */ }
    }

    players.delete(id);
  }

  function releaseAll() {
    Array.from(players.keys()).forEach(release);
  }

  /* ------------------------------------------------------------------------
     Отрисовка
     ------------------------------------------------------------------------ */

  function updateChrome(count) {
    if (countEl) {
      countEl.textContent = count + " " + utils.pluralRu(count, "record");
    }
    if (clearBtn) clearBtn.hidden = count === 0;
    if (emptyEl) emptyEl.hidden = count > 0;
  }

  function createCard(entry) {
    const url = URL.createObjectURL(entry.blob);
    const durationSec = Math.max(0, (Number(entry.durationMs) || 0) / 1000);

    const audio = dom.el("audio", { preload: "metadata" });
    audio.src = url;

    const toggle = dom.el("button", {
      class: "icon-btn icon-btn--sm record-card__toggle",
      type: "button",
      text: "▶",
      attrs: { "aria-label": "Слушать запись", "aria-pressed": "false" },
    });

    const seek = dom.el("input", {
      type: "range",
      class: "record-card__seek",
      min: "0",
      max: String(Math.max(0, Math.floor(durationSec))),
      step: "0.1",
      value: "0",
      attrs: { "aria-label": "Перемотка записи" },
    });
    seek.disabled = !(durationSec > 0);

    const time = dom.el("span", {
      class: "record-card__time",
      text: "00:00 / " + formatClock(entry.durationMs),
    });

    const download = dom.el("a", {
      class: "icon-btn icon-btn--sm record-card__download",
      href: url,
      download: MR.recordings.fileName(entry),
      text: "⤓",
      attrs: { "aria-label": "Скачать запись", title: "Скачать файл" },
    });

    const removeBtn = dom.el("button", {
      class: "icon-btn icon-btn--sm record-card__remove",
      type: "button",
      text: "✕",
      attrs: { "aria-label": "Удалить запись", title: "Удалить запись" },
    });

    const player = {
      audio: audio,
      url: url,
      durationSec: durationSec,
      button: toggle,
      seek: seek,
      time: time,
    };
    players.set(entry.id, player);

    function totalLabel() {
      return formatClock(player.durationSec * 1000);
    }

    function syncTime() {
      time.textContent = formatClock(audio.currentTime * 1000) + " / " + totalLabel();
    }

    function syncDuration() {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        player.durationSec = audio.duration;
      }
      seek.max = String(Math.max(0, Math.floor(player.durationSec)));
      seek.disabled = !(player.durationSec > 0);
      syncTime();
    }

    function setPlaying(active) {
      toggle.textContent = active ? "⏸" : "▶";
      toggle.setAttribute("aria-pressed", String(active));
      toggle.setAttribute("aria-label", active ? "Пауза записи" : "Слушать запись");
    }

    toggle.addEventListener("click", function () {
      if (!audio.paused) {
        audio.pause();
        return;
      }

      // Одновременно звучит только одна запись.
      players.forEach(function (other, otherId) {
        if (otherId !== entry.id) {
          try { other.audio.pause(); } catch (error) { /* noop */ }
        }
      });

      const started = audio.play();
      if (started && typeof started.catch === "function") {
        started.catch(function () {
          setPlaying(false);
          store.emit("notice", {
            level: "warning",
            message: "Не удалось включить запись. Попробуйте ещё раз.",
          });
        });
      }
    });

    audio.addEventListener("play", function () { setPlaying(true); });
    audio.addEventListener("pause", function () { setPlaying(false); });
    audio.addEventListener("ended", function () {
      audio.currentTime = 0;
      seek.value = "0";
      syncTime();
    });
    audio.addEventListener("timeupdate", function () {
      if (!seek.disabled) {
        seek.value = String(audio.currentTime);
      }
      syncTime();
    });
    audio.addEventListener("loadedmetadata", syncDuration);
    audio.addEventListener("durationchange", syncDuration);
    audio.addEventListener("error", function () {
      store.emit("notice", {
        level: "warning",
        message: "Запись не удалось прочитать — файл повреждён или пуст.",
      });
    });

    seek.addEventListener("input", function () {
      if (seek.disabled) return;
      const position = Math.max(0, Number(seek.value) || 0);
      try {
        audio.currentTime = position;
      } catch (error) {
        // Позиция за пределами длительности — оставляем как есть.
      }
      syncTime();
    });

    removeBtn.addEventListener("click", function () { removeCard(entry.id); });

    const head = dom.el(
      "div",
      { class: "record-card__head" },
      dom.el("span", { class: "record-card__station", text: entry.stationName }),
      dom.el("span", {
        class: "record-card__meta",
        text: formatDate(entry.createdAt) + " · " + formatClock(entry.durationMs) +
          " · " + utils.formatBytes(entry.size),
      })
    );

    const row = dom.el(
      "div",
      { class: "record-card__player" },
      toggle,
      seek,
      time,
      download,
      removeBtn
    );

    return dom.el(
      "li",
      { class: "record-card", dataset: { recordId: entry.id } },
      head,
      row,
      audio
    );
  }

  function render(items) {
    if (!listEl) return;

    releaseAll();
    listEl.textContent = "";

    items.forEach(function (entry) {
      if (!entry || !entry.blob) return;
      listEl.appendChild(createCard(entry));
    });

    updateChrome(listEl.querySelectorAll(".record-card").length);
  }

  /* ------------------------------------------------------------------------
     Загрузка и действия
     ------------------------------------------------------------------------ */

  function load() {
    if (!listEl) return Promise.resolve();

    const token = (loadToken += 1);
    loaded = false;

    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;

    return MR.recordings.list()
      .then(function (items) {
        if (token !== loadToken) return null;
        render(items);
        return MR.recordings.isPersistent();
      })
      .then(function (persistent) {
        if (token !== loadToken) return;
        if (fallbackEl) fallbackEl.hidden = Boolean(persistent);
      })
      .catch(function () {
        if (token !== loadToken) return;
        render([]);
        if (fallbackEl) fallbackEl.hidden = false;
      })
      .then(function () {
        if (token !== loadToken) return;
        loaded = true;
        if (loadingEl) loadingEl.hidden = true;
      });
  }

  function onSaved(entry) {
    if (!isVisible() || !listEl) return;

    // Вкладку ещё не открывали — просто подгрузим список целиком.
    if (!loaded || !entry || !entry.blob) {
      load();
      return;
    }

    if (!entry.id || listEl.querySelector('[data-record-id="' + entry.id + '"]')) return;

    listEl.insertBefore(createCard(entry), listEl.firstChild);
    updateChrome(listEl.querySelectorAll(".record-card").length);
  }

  function removeCard(id) {
    MR.modal.confirm({
      title: "Удалить запись?",
      message: "Файл будет удалён из архива. Отменить это нельзя.",
      confirmLabel: "Удалить",
      cancelLabel: "Отмена",
      danger: true,
    }).then(function (ok) {
      if (!ok) return null;
      return MR.recordings.remove(id);
    }).then(function (result) {
      if (!result) return;
      if (result.ok === false) {
        store.emit("notice", { level: "error", message: "Не удалось удалить запись." });
        return;
      }

      release(id);
      const node = listEl ? listEl.querySelector('[data-record-id="' + id + '"]') : null;
      if (node && node.parentNode) node.parentNode.removeChild(node);
      updateChrome(listEl ? listEl.querySelectorAll(".record-card").length : 0);
      store.emit("notice", { level: "success", message: "Запись удалена." });
    }).catch(function () {
      store.emit("notice", { level: "error", message: "Не удалось удалить запись." });
    });
  }

  function clearAll() {
    MR.modal.confirm({
      title: "Очистить архив?",
      message: "Все сохранённые записи будут удалены из этого браузера. Отменить это нельзя.",
      confirmLabel: "Удалить всё",
      cancelLabel: "Отмена",
      danger: true,
    }).then(function (ok) {
      if (!ok) return null;
      return MR.recordings.clear();
    }).then(function (result) {
      if (!result) return;
      if (result.ok === false) {
        store.emit("notice", { level: "error", message: "Не удалось очистить архив." });
        return;
      }

      render([]);
      store.emit("notice", { level: "success", message: "Архив записей очищен." });
    }).catch(function () {
      store.emit("notice", { level: "error", message: "Не удалось очистить архив." });
    });
  }

  function isVisible() {
    return store.state.view === "recordings";
  }

  /* ------------------------------------------------------------------------
     Жизненный цикл
     ------------------------------------------------------------------------ */

  function init() {
    listEl = dom.$("#recordings-list");
    if (!listEl) return;

    emptyEl = dom.$("#recordings-empty");
    countEl = dom.$("#recordings-count");
    clearBtn = dom.$("#recordings-clear");
    fallbackEl = dom.$("#recordings-fallback");
    loadingEl = dom.$("#recordings-loading");

    MR.commands.register("recordings:clear", clearAll);

    offs.push(store.on("view", function () {
      if (isVisible()) load();
    }));

    offs.push(store.on("record:saved", onSaved));

    updateChrome(0);

    if (isVisible()) load();
  }

  function dispose() {
    offs.forEach(function (off) {
      if (typeof off === "function") off();
    });
    offs = [];
    loadToken += 1;
    loaded = false;
    releaseAll();
  }

  MR.recordingsUI = {
    init: init,
    dispose: dispose,
    formatClock: formatClock,
  };
})(window);
