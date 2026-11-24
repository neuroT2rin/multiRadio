/**
 * ui/recorder.js — кнопка записи эфира и индикатор REC в плеере.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  let button = null;
  let chip = null;
  let timer = null;

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return (minutes < 10 ? "0" : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  }

  function render() {
    if (!button) return;

    const active = MR.recorder.isRecording();
    button.classList.toggle("is-recording", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? "Остановить запись эфира" : "Записать эфир");
    button.title = active ? "Остановить запись и сохранить в архив" : "Записать эфир (личная копия)";

    if (chip) {
      chip.hidden = !active;
      if (active) chip.textContent = "REC " + formatElapsed(MR.recorder.elapsedMs());
    }

    if (active && !timer) {
      timer = setInterval(render, 500);
    } else if (!active && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function toggle() {
    if (MR.recorder.isRecording()) MR.recorder.stop();
    else MR.recorder.start();
    render();
  }

  function init() {
    button = dom.$("#record-btn");
    chip = dom.$("#record-chip");
    if (!button) return;

    MR.commands.register("record:toggle", toggle);
    store.on("record", render);
    render();
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  MR.recorderUI = {
    init: init,
    render: render,
    dispose: dispose,
  };
})(window);
