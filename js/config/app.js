/**
 * config/app.js — общие константы приложения.
 * Никакой логики: только значения, которые используют другие модули.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});

  MR.config = {
    version: "2.6.0",
    storageKey: "multiradio:state:v2",
    statsKey: "multiradio:stats:v1",

    views: ["stations", "favorites", "equalizer", "recordings"],
    stationViews: ["list", "grid"],
    themes: ["dark", "light"],
    visualizerModes: ["spectrum", "aurora", "orbit", "tunnel", "spiral", "voice"],
    /** Режимы компактной визуализации потока в плеере. */
    miniVisualizerModes: ["wave", "ribbon", "sparkle"],

    /** «Машина времени»: сколько минут эфира держать в памяти. */
    timemachine: {
      defaultMinutes: 3,
      options: [1, 2, 3, 5, 10],
    },

    health: {
      /** Период автоматической проверки станций. */
      intervalMs: 90000,
      /** Таймаут одного источника. */
      probeTimeoutMs: 6000,
      /** Сколько источников проверять одновременно. */
      concurrency: 10,
    },

    audio: {
      /** Сколько ждать начала воспроизведения, прежде чем перейти к резерву. */
      connectTimeoutMs: 12000,
      /** Пауза перед переключением на резервный источник. */
      retryDelayMs: 700,
      /** Максимальное число источников (URL) у одной станции. */
      maxSources: 6,
      /** Допустимый битрейт одного источника, кбит/с. */
      minBitrate: 8,
      maxBitrate: 1024,
    },

    limits: {
      stations: 200,
      groups: 60,
      groupNameLength: 40,
      stationNameLength: 60,
      genreLength: 60,
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
