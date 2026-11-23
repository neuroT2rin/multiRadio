/**
 * ui/voice-search.js — голосовой подбор станции.
 *
 * Распознавание речи — Web Speech API (браузер, ru-RU). Понимание запроса:
 *  • если доступна встроенная on-device модель Chrome (Prompt API / LanguageModel),
 *    она выбирает станцию из сохранённых;
 *  • иначе — локальный матчер по названиям, жанрам и словарю синонимов.
 * Никаких внешних API-ключей и серверов.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  /** Смысловые группы: ключи в запросе → слова в жанрах станций. */
  const GENRE_HINTS = [
    {
      keys: ["джаз", "jazz", "блюз", "blues", "саксофон", "свинг", "swing", "лаунж", "lounge"],
      words: ["jazz", "blues", "swing", "lounge", "spy"],
    },
    {
      keys: ["рок", "rock", "гитар", "метал", "metal", "панк", "punk", "альтернатив"],
      words: ["rock", "metal", "punk", "guitar", "eclectic"],
    },
    {
      keys: ["электрон", "electronic", "техно", "techno", "хаус", "house", "dance", "танц", "клуб", "club", "idm", "хит"],
      words: ["dance", "electronic", "techno", "house", "club", "pop"],
    },
    {
      keys: ["эмбиент", "ambient", "спокойн", "relax", "расслаб", "чилл", "chill", "медитац", "drone", "дрон", "сон", "sleep", "фонов"],
      words: ["ambient", "drone", "chill", "downtempo", "lounge"],
    },
    {
      keys: ["поп", "pop", "весел", "позитив"],
      words: ["pop", "хиты", "dance"],
    },
    {
      keys: ["работ", "work", "фокус", "focus", "концентрац", "учёб", "учеб", "study"],
      words: ["ambient", "downtempo", "chill", "drone", "lounge"],
    },
    {
      keys: ["вечер", "evening", "ночь", "night", "романт", "romantic", "ужин"],
      words: ["lounge", "jazz", "chill", "downtempo"],
    },
    {
      keys: ["русск", "russian", "наше", "отечествен"],
      words: ["русский", "russian", "наше"],
    },
    {
      keys: ["world", "мир", "этник", "folk", "фолк"],
      words: ["world", "folk"],
    },
  ];

  const STOP_WORDS = new Set([
    "привет", "хочу", "хотел", "хотела", "сегодня", "послушать", "послушаю",
    "включи", "включить", "поставь", "пожалуйста", "мне", "бы", "что", "нибудь",
    "какую", "какой", "давай", "можно", "немного", "радио", "музыку", "музыка",
    "звук", "настроение", "под", "для", "the", "and", "please", "play", "listen",
  ]);

  let button = null;
  let live = null;
  let recognition = null;
  let listening = false;
  let processing = false;
  let lastTranscript = "";

  const SpeechRecognitionClass = global.SpeechRecognition || global.webkitSpeechRecognition;
  const supported = Boolean(SpeechRecognitionClass);

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokens(text) {
    return normalize(text)
      .split(" ")
      .filter(function (token) {
        return token.length >= 3 && !STOP_WORDS.has(token);
      });
  }

  /** Локальная оценка станции под запрос. */
  function scoreStation(station, query) {
    const name = normalize(station.name);
    const genre = normalize(station.genre);
    const haystack = name + " " + genre;
    let score = 0;

    if (name && query.indexOf(name) !== -1) score += 20;

    tokens(query).forEach(function (token) {
      if (name.indexOf(token) !== -1) score += 8;
      else if (genre.indexOf(token) !== -1) score += 6;
    });

    GENRE_HINTS.forEach(function (hint) {
      const queryHit = hint.keys.some(function (key) { return query.indexOf(key) !== -1; });
      if (!queryHit) return;
      const stationHit = hint.words.some(function (word) { return haystack.indexOf(word) !== -1; });
      if (stationHit) score += 10;
    });

    return score;
  }

  /** Возвращает лучшую станцию по тексту запроса или null. */
  function match(text) {
    const query = normalize(text);
    if (!query) return null;

    let best = null;
    let bestScore = 0;

    store.state.stations.forEach(function (station) {
      const score = scoreStation(station, query);
      if (score > bestScore) {
        bestScore = score;
        best = station;
      }
    });

    return bestScore >= 6 ? best : null;
  }

  function setStatus(text) {
    if (!live) return;
    if (!text) {
      live.hidden = true;
      live.textContent = "";
      live.classList.remove("is-busy");
      return;
    }
    live.hidden = false;
    live.textContent = text;
  }

  function setListening(next) {
    listening = Boolean(next);
    if (!button) return;
    button.classList.toggle("is-listening", listening);
    button.setAttribute("aria-pressed", String(listening));
    if (listening) setStatus("🎤 Слушаю…");
    else if (!processing) setStatus("");
  }

  function chooseStation(station, transcript) {
    if (!station) {
      setStatus("");
      MR.toast.warning("Не понял, что включить. Попробуйте назвать жанр или станцию.");
      return;
    }

    MR.audio.playStation(station.id);
    MR.toast.success("Включаю «" + station.name + "» — по запросу «" + transcript + "».");
    setTimeout(function () { setStatus(""); }, 1600);
  }

  /** Пытаемся использовать встроенную бесплатную модель Chrome, если она готова. */
  async function askBuiltInAI(transcript) {
    const LanguageModel = global.LanguageModel ||
      (global.ai && global.ai.languageModel) || null;
    if (!LanguageModel) return null;

    try {
      if (typeof LanguageModel.availability === "function") {
        const availability = await LanguageModel.availability();
        if (availability !== "available") return null;
      }

      const stations = store.state.stations.map(function (station) {
        return station.id + " | " + station.name + " | " + station.genre;
      });

      const session = await LanguageModel.create({
        systemPrompt:
          "Ты помогаешь выбрать интернет-радиостанцию. Пользователь диктует, что хочет послушать. " +
          "Выбери ровно одну станцию из списка и верни только её id, без пояснений.",
      });

      const answer = await Promise.race([
        session.prompt(
          "Станции (id | название | жанр):\n" + stations.join("\n") +
          "\n\nЗапрос: «" + transcript + "»\nОтветь только id."
        ),
        new Promise(function (resolve) { setTimeout(function () { resolve(""); }, 8000); }),
      ]);

      if (session && typeof session.destroy === "function") session.destroy();

      const id = String(answer || "").trim().replace(/[^a-z0-9-]/gi, "");
      return id ? store.findStation(id) : null;
    } catch (error) {
      return null;
    }
  }

  async function processTranscript(transcript) {
    processing = true;
    setStatus("«" + transcript + "» — подбираю…");

    let station = null;
    try {
      station = await askBuiltInAI(transcript);
    } catch (error) {
      station = null;
    }
    if (!station) station = match(transcript);

    processing = false;
    chooseStation(station, transcript);
  }

  function startListening() {
    if (!supported) {
      MR.toast.warning("Браузер не поддерживает распознавание речи. Попробуйте Chrome или Edge.");
      return;
    }
    if (listening) {
      stopListening();
      return;
    }
    if (processing) return;

    try {
      if (!recognition) {
        recognition = new SpeechRecognitionClass();
        recognition.lang = "ru-RU";
        recognition.interimResults = true;
        recognition.continuous = false;
        recognition.maxAlternatives = 1;

        recognition.onresult = function (event) {
          let finalText = "";
          let interim = "";
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            if (result.isFinal) finalText += result[0].transcript;
            else interim += result[0].transcript;
          }
          if (interim) setStatus("🎤 " + interim.trim());
          if (finalText) lastTranscript = finalText.trim();
        };

        recognition.onerror = function (event) {
          setListening(false);
          processing = false;
          setStatus("");
          if (event && event.error === "not-allowed") {
            MR.toast.error("Нет доступа к микрофону: разрешите его в настройках браузера.");
          } else if (event && event.error === "no-speech") {
            MR.toast.warning("Не расслышал — попробуйте ещё раз.");
          } else if (event && event.error !== "aborted") {
            MR.toast.error("Не удалось распознать речь.");
          }
        };

        recognition.onend = function () {
          setListening(false);
          if (lastTranscript && !processing) {
            const transcript = lastTranscript;
            lastTranscript = "";
            processTranscript(transcript);
          } else if (!processing) {
            setStatus("");
          }
        };
      }

      lastTranscript = "";
      recognition.start();
      setListening(true);
    } catch (error) {
      setListening(false);
      MR.toast.error("Не удалось запустить микрофон: " + (error.message || error));
    }
  }

  function stopListening() {
    if (!recognition) return;
    try { recognition.stop(); } catch (error) { /* уже остановлено */ }
  }

  function init() {
    button = dom.$("#voice-search-btn");
    live = dom.$("#voice-live");
    if (!button) return;

    if (!supported) {
      button.title = "Голосовой поиск не поддерживается этим браузером";
    }

    MR.commands.registerMany({
      "search:voice": startListening,
    });
  }

  function dispose() {
    if (recognition) {
      try { recognition.abort(); } catch (error) { /* уже остановлено */ }
      recognition = null;
    }
  }

  MR.voiceSearch = {
    init: init,
    dispose: dispose,
    start: startListening,
    stop: stopListening,
    match: match,
    supported: supported,
  };
})(window);
