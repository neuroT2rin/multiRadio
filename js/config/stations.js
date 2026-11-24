/**
 * config/stations.js — стартовый набор станций.
 *
 * Все адреса проверены на доступность (ноябрь 2025).
 * У каждой ссылки свой битрейт: при запуске приложение сначала пробует
 * источник с максимальным битрейтом, затем остальные по убыванию.
 * SomaFM отдаёт несколько независимых хостов — это настоящий резерв,
 * а не копия одного адреса.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});

  MR.defaults = MR.defaults || {};

  MR.defaults.stations = [
    {
      id: "groove-salad",
      name: "Groove Salad",
      genre: "Downtempo / Chill",
      emoji: "🌊",
      sources: [
        { url: "https://ice1.somafm.com/groovesalad-128-mp3", bitrate: 128 },
        { url: "https://ice2.somafm.com/groovesalad-128-mp3", bitrate: 128 },
        { url: "https://ice4.somafm.com/groovesalad-128-mp3", bitrate: 128 },
      ],
    },
    {
      id: "drone-zone",
      name: "Drone Zone",
      genre: "Ambient / Drone",
      emoji: "🌌",
      sources: [
        { url: "https://ice1.somafm.com/dronezone-128-mp3", bitrate: 128 },
        { url: "https://ice2.somafm.com/dronezone-128-mp3", bitrate: 128 },
      ],
    },
    {
      id: "secret-agent",
      name: "Secret Agent",
      genre: "Lounge / Spy Jazz",
      emoji: "🕵️",
      sources: [
        { url: "https://ice1.somafm.com/secretagent-128-mp3", bitrate: 128 },
        { url: "https://ice2.somafm.com/secretagent-128-mp3", bitrate: 128 },
      ],
    },
    {
      id: "radio-paradise",
      name: "Radio Paradise",
      genre: "Eclectic / Rock",
      emoji: "🏔️",
      sources: [
        { url: "https://stream.radioparadise.com/mp3-192", bitrate: 192 },
        { url: "https://stream.radioparadise.com/mp3-128", bitrate: 128 },
      ],
    },
    {
      id: "fip",
      name: "FIP",
      genre: "Jazz / World",
      emoji: "🎷",
      sources: [
        { url: "https://icecast.radiofrance.fr/fip-hifi.aac", bitrate: 192 },
        { url: "https://icecast.radiofrance.fr/fip-midfi.mp3", bitrate: 128 },
      ],
    },
    {
      id: "dfm",
      name: "DFM",
      genre: "Dance / Pop",
      emoji: "💿",
      sources: [
        { url: "https://dfm.hostingradio.ru/dfm128.mp3", bitrate: 128 },
        { url: "https://dfm.hostingradio.ru/dfm96.aacp", bitrate: 96 },
      ],
    },
    {
      id: "nashe-radio",
      name: "Наше Радио",
      genre: "Rock / Русский рок",
      emoji: "🎸",
      sources: [
        { url: "https://nashe1.hostingradio.ru:80/nashe-128.mp3", bitrate: 128 },
        { url: "https://nashe1.hostingradio.ru/nashe-128.mp3", bitrate: 128 },
      ],
    },
    {
      id: "europa-plus",
      name: "Европа Плюс",
      genre: "Pop / Хиты",
      emoji: "📻",
      sources: [
        { url: "https://ep128.hostingradio.ru:8030/ep128", bitrate: 128 },
      ],
    },
  ];
})(window);
