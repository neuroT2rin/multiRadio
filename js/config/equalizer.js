/**
 * config/equalizer.js — полосы эквалайзера и готовые пресеты.
 *
 * Диапазоны подобраны так, чтобы покрыть весь слышимый спектр:
 * низкие частоты — lowshelf, высокие — highshelf, середина — peaking.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});

  MR.defaults = MR.defaults || {};

  /** @typedef {{freq:number, type:BiquadFilterType, label:string}} EqBand */

  MR.defaults.eqBands = [
    { freq: 32, type: "lowshelf", label: "32 Гц" },
    { freq: 64, type: "peaking", label: "64 Гц" },
    { freq: 125, type: "peaking", label: "125 Гц" },
    { freq: 250, type: "peaking", label: "250 Гц" },
    { freq: 500, type: "peaking", label: "500 Гц" },
    { freq: 1000, type: "peaking", label: "1 кГц" },
    { freq: 2000, type: "peaking", label: "2 кГц" },
    { freq: 4000, type: "peaking", label: "4 кГц" },
    { freq: 8000, type: "peaking", label: "8 кГц" },
    { freq: 16000, type: "highshelf", label: "16 кГц" },
  ];

  /** Пресеты: значения в дБ, по одному на каждую полосу. */
  MR.defaults.eqPresets = {
    flat: {
      label: "Ровно",
      gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
    bass: {
      label: "Бас",
      gains: [7, 5, 3, 1, 0, -1, -2, -2, -3, -3],
    },
    vocal: {
      label: "Вокал",
      gains: [-2, -1, 1, 3, 4, 4, 3, 1, 0, -1],
    },
    rock: {
      label: "Рок",
      gains: [5, 3, 0, -2, -1, 1, 3, 5, 4, 2],
    },
    jazz: {
      label: "Джаз",
      gains: [2, 3, 2, 1, 0, 1, 2, 2, 1, 1],
    },
    electronic: {
      label: "Электроника",
      gains: [6, 5, 2, 0, -1, 1, 3, 4, 5, 4],
    },
    night: {
      label: "Ночь",
      gains: [-3, -2, -1, 0, 1, 2, 1, 0, -2, -4],
    },
  };

  /** Находит пресет по массиву усилений (или возвращает null). */
  MR.defaults.findPreset = function findPreset(gains) {
    const presets = MR.defaults.eqPresets;
    return Object.keys(presets).find(function (key) {
      const preset = presets[key].gains;
      return preset.length === gains.length && preset.every(function (value, index) {
        return Math.abs(value - gains[index]) < 0.01;
      });
    }) || null;
  };
})(window);
