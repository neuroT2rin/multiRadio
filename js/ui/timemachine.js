/**
 * ui/timemachine.js — тонкий ползунок перемотки внизу визуализатора потока.
 *
 * Справа — эфир, левее — буфер последних минут. Перетаскивание строит WAV
 * из выбранного места и ставит эфир на паузу; кнопка LIVE возвращает к эфиру.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const utils = MR.utils;

  let slider = null;
  let liveButton = null;
  let dragging = false;
  let wasBuffered = false;
  let frozenMax = 1;

  function render() {
    if (!slider) return;

    const available = MR.timemachine.availableSeconds();
    const buffered = MR.timemachine.isBuffered();
    const liveMax = Math.max(1, Math.floor(available));

    if (!buffered) {
      wasBuffered = false;
      slider.max = String(liveMax);
      if (!dragging) slider.value = String(liveMax);
      slider.disabled = available < 5;
      slider.title = available >= 5
        ? "Буфер эфира: " + Math.round(available) + " с. Потяните влево, чтобы отмотать."
        : "Буфер эфира наполняется…";
      if (liveButton) liveButton.hidden = true;
      return;
    }

    if (!wasBuffered) {
      frozenMax = liveMax;
      wasBuffered = true;
    }

    slider.max = String(frozenMax);
    if (!dragging) {
      slider.value = String(Math.max(0, frozenMax - MR.timemachine.getRewind()));
    }
    slider.disabled = false;
    slider.title = "Вы слушаете буфер. Нажмите LIVE, чтобы вернуться к эфиру.";
    if (liveButton) liveButton.hidden = false;
  }

  function applyPosition() {
    const max = Number(slider.max) || 1;
    const value = Number(slider.value);
    const secondsBack = max - value;

    if (secondsBack < 2) {
      MR.timemachine.returnLive();
    } else {
      MR.timemachine.playFrom(secondsBack);
    }
  }

  function init() {
    slider = dom.$("#timemachine");
    liveButton = dom.$("#timemachine-live");
    if (!slider) return;

    slider.addEventListener("input", function () {
      dragging = true;
    });

    slider.addEventListener("change", function () {
      dragging = false;
      applyPosition();
    });

    slider.addEventListener("pointerup", function () {
      if (!dragging) return;
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
