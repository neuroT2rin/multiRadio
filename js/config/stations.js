/**
 * config/stations.js — стартовый набор станций.
 *
 * Все адреса проверены на доступность (ноябрь 2025).
 * У станции может быть несколько источников: сначала пробуется primary,
 * затем fallbacks по порядку. SomaFM отдаёт несколько независимых хостов —
 * это настоящий резерв, а не копия одного адреса.
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
      bitrate: "128 kbps",
      emoji: "🌊",
      primary: "https://ice1.somafm.com/groovesalad-128-mp3",
      fallbacks: [
        "https://ice2.somafm.com/groovesalad-128-mp3",
        "https://ice4.somafm.com/groovesalad-128-mp3",
      ],
    },
    {
      id: "drone-zone",
      name: "Drone Zone",
      genre: "Ambient / Drone",
      bitrate: "128 kbps",
      emoji: "🌌",
      primary: "https://ice1.somafm.com/dronezone-128-mp3",
      fallbacks: [
        "https://ice2.somafm.com/dronezone-128-mp3",
      ],
    },
    {
      id: "secret-agent",
      name: "Secret Agent",
      genre: "Lounge / Spy Jazz",
      bitrate: "128 kbps",
      emoji: "🕵️",
      primary: "https://ice1.somafm.com/secretagent-128-mp3",
      fallbacks: [
        "https://ice2.somafm.com/secretagent-128-mp3",
      ],
    },
    {
      id: "radio-paradise",
      name: "Radio Paradise",
      genre: "Eclectic / Rock",
      bitrate: "192 kbps",
      emoji: "🏔️",
      primary: "https://stream.radioparadise.com/mp3-192",
      fallbacks: [
        "https://stream.radioparadise.com/mp3-128",
      ],
    },
    {
      id: "fip",
      name: "FIP",
      genre: "Jazz / World",
      bitrate: "128 kbps",
      emoji: "🎷",
      primary: "https://icecast.radiofrance.fr/fip-midfi.mp3",
      fallbacks: [
        "https://icecast.radiofrance.fr/fip-hifi.aac",
      ],
    },
    {
      id: "dfm",
      name: "DFM",
      genre: "Dance / Pop",
      bitrate: "96 kbps",
      emoji: "💿",
      primary: "https://dfm.hostingradio.ru/dfm96.aacp",
      fallbacks: [
        "https://dfm.hostingradio.ru/dfm128.mp3",
      ],
    },
    {
      id: "nashe-radio",
      name: "Наше Радио",
      genre: "Rock / Русский рок",
      bitrate: "128 kbps",
      emoji: "🎸",
      primary: "https://nashe1.hostingradio.ru:80/nashe-128.mp3",
      fallbacks: [
        "https://nashe1.hostingradio.ru/nashe-128.mp3",
      ],
    },
    {
      id: "europa-plus",
      name: "Европа Плюс",
      genre: "Pop / Хиты",
      bitrate: "128 kbps",
      emoji: "📻",
      primary: "https://ep128.hostingradio.ru:8030/ep128",
      fallbacks: [],
    },
  ];
})(window);
