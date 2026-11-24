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
  let dragging = false;

  function render() {
    if (!slider) return;

    const available = MR.timemachine.availableSeconds();
    const buffered = MR.timemachine.isBuffered();
    const max = Math.max(1, Math.floor(available));

    // max = весь буфер; value = max − Δ. Пока Δ постоянна, а буфер растёт,
    // ползунок пропорционально сдвигается вправо, к живому эфиру.
    slider.max = String(max);
    if (!dragging) {
      const value = buffered ? Math.max(0, max - MR.timemachine.getRewind()) : max;
      slider.value = String(value);
    }

    slider.disabled = !buffered && available < 5;

    if (buffered) {
      slider.title = "Вы слушаете буфер. Нажмите LIVE, чтобы вернуться к эфиру.";
      if (liveButton) liveButton.hidden = false;
    } else {
      slider.title = available >= 5
        ? "Буфер эфира: " + Math.round(available) + " с. Потяните влево, чтобы отмотать."
        : "Буфер эфира наполняется…";
      if (liveButton) liveButton.hidden = true;
    }
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
