/**
 * config/app.js — общие константы приложения.
 * Никакой логики: только значения, которые используют другие модули.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});

  MR.config = {
    version: "2.2.0",
    storageKey: "multiradio:state:v2",

    views: ["stations", "favorites", "equalizer"],
    stationViews: ["list", "grid"],
    visualizerModes: ["spectrum", "aurora", "orbit", "tunnel", "spiral"],
    /** Режимы компактной визуализации потока в плеере. */
    miniVisualizerModes: ["wave", "ribbon", "sparkle"],

    health: {
      /** Период автоматической проверки станций. */
      intervalMs: 90000,
      /** Таймаут одного источника. */
      probeTimeoutMs: 6000,
      /** Сколько источников проверять одновременно. */
      concurrency: 6,
    },

    audio: {
      /** Сколько ждать начала воспроизведения, прежде чем перейти к резерву. */
      connectTimeoutMs: 12000,
      /** Пауза перед переключением на резервный источник. */
      retryDelayMs: 700,
      /** Максимальное число резервных URL, сохраняемых у станции. */
      maxFallbacks: 5,
    },

    limits: {
      stations: 200,
      groups: 60,
      groupNameLength: 40,
      stationNameLength: 60,
      genreLength: 60,
      bitrateLength: 20,
      emojiLength: 8,
    },
  };

  /** Локализованные подписи состояний воспроизведения. */
  MR.config.playbackLabels = {
    idle: "Готов к запуску",
    connecting: "Подключение…",
    buffering: "Буферизация…",
    playing: "Играет",
    paused: "Пауза",
    error: "Ошибка потока",
    blocked: "Нужен клик",
  };
})(window);
