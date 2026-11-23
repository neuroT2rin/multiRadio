/**
 * ui/equalizer.js — 10 полос, пресеты и живые индикаторы энергии.
 * Индикаторы обновляет общий цикл визуализации (visualizer/index.js),
 * чтобы не запускать второй requestAnimationFrame.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;
  const defaults = MR.defaults;

  let presetsBar = null;
  let controls = null;
  let hint = null;
  let sliders = [];
  let meters = [];
  let valueLabels = [];
  let presetButtons = [];

  function build() {
    presetsBar.innerHTML = "";
    presetButtons = [];

    Object.keys(defaults.eqPresets).forEach(function (key) {
      const preset = defaults.eqPresets[key];
      const button = dom.el("button", {
        class: "eq-preset",
        type: "button",
        "data-preset": key,
        "aria-pressed": "false",
        text: preset.label,
        onClick: function () {
          store.applyEqPreset(key);
        },
      });
      presetsBar.appendChild(button);
      presetButtons.push(button);
    });

    controls.innerHTML = "";
    sliders = [];
    meters = [];
    valueLabels = [];

    defaults.eqBands.forEach(function (band, index) {
      const slider = dom.el("input", {
        type: "range",
        class: "eq-band__slider",
        min: "-20",
        max: "20",
        step: "1",
        value: "0",
        "aria-label": "Полоса " + band.label,
        "aria-valuetext": "0 дБ",
        "data-band": String(index),
      });

      const meterFill = dom.el("span", { class: "eq-meter__fill" });
      const meter = dom.el("span", { class: "eq-meter", "aria-hidden": "true" }, meterFill);

      const value = dom.el("span", { class: "eq-band__value", text: "0" });

      const wrapper = dom.el("div", { class: "eq-band" },
        dom.el("span", { class: "eq-band__label", text: band.label }),
        dom.el("div", { class: "eq-band__control" }, slider, meter),
        value
      );

      slider.addEventListener("input", function (event) {
        store.setEqGain(index, Number(event.target.value));
      });

      controls.appendChild(wrapper);
      sliders.push(slider);
      meters.push(meterFill);
      valueLabels.push(value);
    });

    update();
  }

  function update() {
    const gains = store.state.eqGains;
    const disabled = Boolean(store.state.ui.compatMode);

    sliders.forEach(function (slider, index) {
      const gain = gains[index] || 0;
      slider.value = String(gain);
      slider.disabled = disabled;
      slider.setAttribute("aria-valuetext", gain + " дБ");
      if (valueLabels[index]) valueLabels[index].textContent = String(gain);
    });

    presetButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.preset === store.state.eqPreset));
    });

    controls.classList.toggle("is-disabled", disabled);

    if (hint) {
      hint.textContent = disabled
        ? "Режим совместимости: Web Audio отключён, полосы и спектр недоступны. Звук при этом работает."
        : "Двигайте ползунки или выберите пресет — значения сохраняются автоматически.";
    }
  }

  /** Вызывается визуализатором не чаще 30 раз в секунду. */
  function tick(analysis) {
    if (!analysis || store.state.view !== "equalizer") return;
    const disabled = Boolean(store.state.ui.compatMode);

    meters.forEach(function (meter, index) {
      const level = disabled || !analysis.active ? 0 : (analysis.eqBands[index] || 0);
      meter.style.height = Math.round(Math.min(1, level) * 100) + "%";
    });
  }

  function init() {
    presetsBar = dom.$("#eq-presets");
    controls = dom.$("#eq-controls");
    hint = dom.$("#eq-hint");
    if (!presetsBar || !controls) return;

    MR.commands.register("eq:reset", function () { store.resetEq(); });

    store.on("eq", update);
    store.on("ui", update);

    build();
  }

  MR.eqUI = {
    init: init,
    tick: tick,
    update: update,
  };
})(window);
