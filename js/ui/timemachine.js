/**
 * ui/timemachine.js — тонкий ползунок перемотки внизу визуализатора потока.
 *
 * Справа — живой эфир, левее — буфер последних минут. Позиция ползунка
 * считается от правого края: отмотка Δ остаётся постоянной, поэтому по мере
 * роста буфера ползунок сам сдвигается вправо, к эфиру.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;

  let slider = null;
  let liveButton = null;
  let lagBadge = null;
  let dragging = false;

  /** Целые секунды отставания: «−5 с», начиная с минуты — «−1:05». */
  function formatLag(seconds) {
    const total = Math.max(1, Math.round(seconds));
    if (total >= 60) {
      const minutes = Math.floor(total / 60);
      return "−" + minutes + ":" + String(total % 60).padStart(2, "0");
    }
    return "−" + total + " с";
  }

  /** Бейдж отставания виден только пока слушается буфер. */
  function renderLag(buffered) {
    if (!lagBadge) return;

    const rewind = buffered ? MR.timemachine.getRewind() : 0;
    if (!buffered || !(rewind > 0)) {
      lagBadge.hidden = true;
      lagBadge.textContent = "";
      lagBadge.removeAttribute("title");
      lagBadge.removeAttribute("aria-label");
      return;
    }

    const total = Math.max(1, Math.round(rewind));
    lagBadge.textContent = formatLag(rewind);
    lagBadge.title = "Вы отстаёте от эфира на " + total + " " +
      utils.pluralRu(total, "second");
    lagBadge.setAttribute("aria-label", lagBadge.title);
    lagBadge.hidden = false;
  }

  function render() {
    if (!slider) return;

    // Буфер выключен в настройках или недоступен в compat-режиме:
    // ползунок и кнопка LIVE не нужны.
    if (!MR.timemachine.isEnabled() || store.state.ui.compatMode) {
      slider.hidden = true;
      slider.disabled = true;
      if (liveButton) liveButton.hidden = true;
      if (lagBadge) lagBadge.hidden = true;
      return;
    }

    slider.hidden = false;

    const available = MR.timemachine.availableSeconds();
    const buffered = MR.timemachine.isBuffered();
    const paused = store.state.playback.status === "paused";
    const max = Math.max(1, Math.floor(available));
    const ready = available >= 2;

    // max = весь буфер; value = max − Δ. Пока Δ постоянна, а буфер растёт,
    // ползунок пропорционально сдвигается вправо, к живому эфиру.
    slider.max = String(max);
    if (!dragging) {
      const value = buffered ? Math.max(0, max - MR.timemachine.getRewind()) : max;
      slider.value = String(value);
    }

    slider.disabled = !buffered && !ready;

    if (buffered) {
      slider.title = paused
        ? "Пауза. Потяните ползунок или нажмите ▶, чтобы слушать буфер."
        : "Вы слушаете буфер. Нажмите LIVE, чтобы вернуться к эфиру.";
      if (liveButton) liveButton.hidden = false;
    } else if (paused) {
      slider.title = ready
        ? "Пауза. Буфер сохранён: потяните влево, чтобы выбрать место."
        : "Пауза. Буфер эфира наполняется…";
      if (liveButton) liveButton.hidden = true;
    } else {
      slider.title = ready
        ? "Буфер эфира: " + Math.round(available) + " с. Потяните влево, чтобы отмотать."
        : "Буфер эфира наполняется…";
      if (liveButton) liveButton.hidden = true;
    }

    renderLag(buffered);
  }

  function applyPosition() {
    const max = Number(slider.max) || 1;
    const value = Number(slider.value);
    const secondsBack = max - value;

    if (secondsBack < 2) {
      MR.timemachine.returnLive();
    } else if (store.state.playback.isPlaying) {
      MR.timemachine.playFrom(secondsBack);
    } else {
      // На паузе только готовим буфер; Play продолжит с выбранного места.
      MR.timemachine.seek(secondsBack);
    }
  }

  function init() {
    slider = dom.$("#timemachine");
    liveButton = dom.$("#timemachine-live");
    lagBadge = dom.$("#timemachine-lag");
    if (!slider) return;

    // input нужен только чтобы не перебивать позицию во время перетаскивания.
    // Применяем перемотку ровно один раз — по change.
    slider.addEventListener("input", function () {
      dragging = true;
    });

    slider.addEventListener("change", function () {
      dragging = false;
      applyPosition();
    });

    if (liveButton) {
      liveButton.addEventListener("click", function () {
        MR.timemachine.returnLive();
      });
    }

    store.on("timemachine", render);
    render();
  }

  MR.timemachineUI = {
    init: init,
    render: render,
  };
})(window);
