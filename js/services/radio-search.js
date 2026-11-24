/**
 * services/radio-search.js — поиск станций по нескольким каталогам.
 *
 * Реестр каталогов лежит в config/search-providers.js; здесь — адаптеры,
 * нормализация записей, слияние дублей и проверка потоков. Модуль не трогает
 * DOM и не пишет в store: состояние поиска живёт в ui/station-search.js.
 *
 * Правила:
 *  - каждый адаптер асинхронный, с AbortSignal и таймаутом;
 *  - упавший каталог не ломает остальные (Promise.allSettled в search);
 *  - одинаковые URL разных каталогов сливаются в один источник с бейджами;
 *  - разные URL сливаются только при сильном совпадении метаданных
 *    (название + страна/язык/жанр или хост homepage);
 *  - основной источник — с максимальным битрейтом (затем — порядок ввода).
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const store = MR.store;
  const config = MR.config;
  const utils = MR.utils;
  const providersConfig = MR.searchProviders || {};

  const SETTINGS = providersConfig.settings || {};
  const PROBE_TIMEOUT = SETTINGS.probeTimeoutMs || 6000;
  const PROBE_CONCURRENCY = SETTINGS.probeConcurrency || 4;
  const PROBE_TTL = SETTINGS.probeCacheTtlMs || 5 * 60 * 1000;
  const PROVIDERS = (providersConfig.providers || []).slice();
  const FALLBACK_CATALOG = (providersConfig.fallbackCatalog || []).slice();

  const PROVIDER_BY_ID = new Map(PROVIDERS.map(function (provider) { return [provider.id, provider]; }));

  /** Названия языков для Radio Browser: API ждёт английское имя, не код. */
  const LANGUAGE_NAMES = {
    ru: "russian", en: "english", fr: "french", de: "german", es: "spanish",
    it: "italian", pt: "portuguese", pl: "polish", uk: "ukrainian", kk: "kazakh",
    nl: "dutch", sv: "swedish", no: "norwegian", da: "danish", fi: "finnish",
    cs: "czech", sk: "slovak", hu: "hungarian", ro: "romanian", bg: "bulgarian",
    el: "greek", tr: "turkish", sr: "serbian", hr: "croatian", sl: "slovenian",
    et: "estonian", lv: "latvian", lt: "lithuanian", ja: "japanese", ko: "korean",
    zh: "chinese", ar: "arabic", hi: "hindi", fa: "persian", he: "hebrew",
  };

  const probeCache = new Map();
  const probePending = new Map();
  const probeQueue = [];
  let activeProbes = 0;
  let disposed = false;

  /* ------------------------------------------------------------------------
     Нормализация
     ------------------------------------------------------------------------ */

  function cleanText(value, maxLength) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, maxLength || 120);
  }

  function normalizeCountryCode(value) {
    const code = String(value === undefined || value === null ? "" : value).trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : "";
  }

  function normalizeUrl(value) {
    if (!utils.isHttpUrl(value)) return "";
    try {
      return new URL(String(value).trim()).href;
    } catch (error) {
      return "";
    }
  }

  /** Сравнимое название: нижний регистр, ё → е, только буквы и цифры. */
  function normalizeName(value) {
    return String(value === undefined || value === null ? "" : value)
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9]+/g, " ")
      .trim();
  }

  function hostOf(value) {
    if (!value) return "";
    try {
      return new URL(String(value)).hostname.replace(/^www\./i, "").toLowerCase();
    } catch (error) {
      return "";
    }
  }

  function normalizeTags(value) {
    const list = Array.isArray(value) ? value : String(value || "").split(/[,;|/]/);
    const seen = Object.create(null);
    const tags = [];
    list.forEach(function (item) {
      const tag = cleanText(String(item === undefined || item === null ? "" : item), 40).toLowerCase();
      if (!tag || seen[tag]) return;
      seen[tag] = true;
      tags.push(tag);
    });
    return tags;
  }

  /**
   * Приводит запись каталога к единому виду. Возвращает null для мусора
   * (нет названия или URL), чтобы такие записи не попадали в панель.
   */
  function normalizeRecord(raw, provider) {
    const source = raw || {};
    const resolvedProvider = provider || PROVIDER_BY_ID.get(source.provider) || {
      id: cleanText(String(source.provider || "catalog"), 40) || "catalog",
      label: cleanText(source.providerLabel, 40) || "Каталог",
    };

    const name = cleanText(source.name, 90);
    const url = normalizeUrl(source.url);
    if (!name || !url) return null;

    const countryCode = normalizeCountryCode(source.countryCode || source.countrycode);
    const tags = normalizeTags(source.tags || source.tag);
    const bitrate = utils.normalizeBitrate(source.bitrate);

    return {
      name: name,
      country: cleanText(source.country, 60) ||
        (countryCode ? providersConfig.countryName(countryCode) : ""),
      countryCode: countryCode,
      language: cleanText(source.language, 30).toLowerCase(),
      tags: tags,
      genre: cleanText(source.genre, 60) || tags[0] || "Без жанра",
      homepage: normalizeUrl(source.homepage),
      provider: resolvedProvider.id,
      providerLabel: resolvedProvider.label || resolvedProvider.id,
      url: url,
      bitrate: bitrate
        ? utils.clamp(bitrate, 0, config.audio.maxBitrate)
        : 0,
      codec: cleanText(source.codec, 12).toLowerCase(),
    };
  }

  /**
   * Ключ сильного совпадения разных URL одной станции.
   * Опирается только на метаданные: нормализованное название и «якорь» —
   * хост homepage либо связка страна + язык + жанр. Если якоря нет,
   * ключ пустой, и станции не сливаются (лучше дубль, чем ложное слияние).
   */
  function stationKey(record) {
    if (!record) return "";
    const name = normalizeName(record.name);
    if (!name) return "";
    const country = normalizeCountryCode(record.countryCode);
    const language = cleanText(record.language, 30).toLowerCase();
    const homepageHost = hostOf(record.homepage);
    const genre = normalizeName(record.genre);
    const anchor = homepageHost ||
      (country && language ? country + ":" + language + ":" + genre : "");
    return anchor ? name + "|" + anchor : "";
  }

  function providerOrder(id) {
    const index = PROVIDERS.findIndex(function (provider) { return provider.id === id; });
    return index === -1 ? PROVIDERS.length : index;
  }

  /** Сортировка источников: по убыванию битрейта, при равенстве — как пришли. */
  function sortSources(sources) {
    return sources
      .map(function (source, index) { return { source: source, index: index }; })
      .sort(function (a, b) {
        const diff = (b.source.bitrate || 0) - (a.source.bitrate || 0);
        return diff !== 0 ? diff : a.index - b.index;
      })
      .map(function (item) { return item.source; });
  }

  function pickPrimarySource(sources) {
    const sorted = sortSources(Array.isArray(sources) ? sources.slice() : []);
    return sorted[0] || null;
  }

  function finalizeStation(station) {
    station.sources = sortSources(station.sources);
    station.bitrates = Array.from(new Set(
      station.sources.map(function (source) { return source.bitrate || 0; }).filter(Boolean)
    )).sort(function (a, b) { return a - b; });
    station.providers.sort(function (a, b) {
      const diff = providerOrder(a.id) - providerOrder(b.id);
      return diff !== 0 ? diff : String(a.label).localeCompare(String(b.label), "ru");
    });
    station.tags.sort(function (a, b) { return a.localeCompare(b, "ru"); });
    const primary = station.sources[0] || null;
    station.primaryUrl = primary ? primary.url : "";
    station.primaryBitrate = primary ? primary.bitrate : 0;
    station.id = "search-" + utils.slugify(station.name) +
      (station.countryCode ? "-" + station.countryCode.toLowerCase() : "");
    return station;
  }

  /**
   * Слияние записей: сначала по точному URL, затем по stationKey.
   * Результат — станции с массивом источников и списком каталогов-бейджей.
   */
  function mergeRecords(records) {
    const byUrl = new Map();
    const byKey = new Map();
    const merged = [];

    (Array.isArray(records) ? records : []).forEach(function (record) {
      if (!record || !record.url) return;

      let target = byUrl.get(record.url) || null;
      const key = stationKey(record);

      if (!target && key) target = byKey.get(key) || null;

      if (!target) {
        target = {
          name: record.name,
          country: record.country || "",
          countryCode: record.countryCode || "",
          language: record.language || "",
          genre: record.genre || "Без жанра",
          tags: record.tags.slice(),
          homepage: record.homepage || "",
          providers: [],
          sources: [],
        };
        merged.push(target);
        if (key && !byKey.has(key)) byKey.set(key, target);
      } else {
        if (!target.country && record.country) target.country = record.country;
        if (!target.countryCode && record.countryCode) target.countryCode = record.countryCode;
        if (!target.language && record.language) target.language = record.language;
        if (!target.homepage && record.homepage) target.homepage = record.homepage;
        record.tags.forEach(function (tag) {
          if (target.tags.indexOf(tag) === -1) target.tags.push(tag);
        });
      }

      if (!target.providers.some(function (item) { return item.id === record.provider; })) {
        target.providers.push({ id: record.provider, label: record.providerLabel });
      }

      const source = target.sources.find(function (item) { return item.url === record.url; });
      if (source) {
        source.bitrate = Math.max(source.bitrate || 0, record.bitrate || 0);
        if (!source.codec && record.codec) source.codec = record.codec;
      } else {
        target.sources.push({
          url: record.url,
          bitrate: record.bitrate || 0,
          codec: record.codec || "",
          provider: record.provider,
          providerLabel: record.providerLabel,
        });
      }

      byUrl.set(record.url, target);
    });

    merged.forEach(finalizeStation);
    return merged;
  }

  /* ------------------------------------------------------------------------
     Фильтры
     ------------------------------------------------------------------------ */

  function normalizeFilters(filters) {
    const source = filters || {};
    return {
      query: cleanText(source.query, 80),
      countryCode: normalizeCountryCode(source.countryCode),
      genre: cleanText(source.genre, 60),
      language: cleanText(source.language, 10).toLowerCase(),
    };
  }

  function languageMatches(value, filter) {
    if (!filter) return true;
    const language = String(value || "").toLowerCase();
    if (!language) return false;
    if (language === filter) return true;
    return language.split(/[,;/\s]+/).indexOf(filter) !== -1;
  }

  function matchesQuery(record, query) {
    if (!query) return true;
    const tokens = normalizeName(query).split(" ").filter(Boolean);
    if (!tokens.length) return true;
    const haystack = normalizeName([
      record.name,
      record.genre,
      Array.isArray(record.tags) ? record.tags.join(" ") : record.tags,
      record.country,
      record.countryCode,
      record.language,
      record.providerLabel,
    ].join(" "));
    return tokens.every(function (token) { return haystack.indexOf(token) !== -1; });
  }

  function matchesFilters(record, filters) {
    if (!record) return false;
    if (filters.countryCode && normalizeCountryCode(record.countryCode) !== filters.countryCode) {
      return false;
    }
    if (!languageMatches(record.language, filters.language)) return false;
    if (filters.genre) {
      const haystack = normalizeName(
        [record.genre].concat(Array.isArray(record.tags) ? record.tags : []).join(" ")
      );
      if (haystack.indexOf(normalizeName(filters.genre)) === -1) return false;
    }
    return matchesQuery(record, filters.query);
  }

  function filterRecords(records, filters) {
    return (Array.isArray(records) ? records : []).filter(function (record) {
      return matchesFilters(record, filters);
    });
  }

  /** Нормализованные записи встроенного каталога (до слияния). */
  function getFallbackRecords(filters) {
    const normalized = normalizeFilters(filters);
    return FALLBACK_CATALOG.filter(function (record) {
      return matchesFilters(record, normalized);
    }).map(function (record) {
      return normalizeRecord(record, PROVIDER_BY_ID.get(record.provider));
    }).filter(Boolean);
  }

  /** Встроенный каталог со слиянием: работает без сети и на file://. */
  function getFallbackMatches(filters) {
    return mergeRecords(getFallbackRecords(filters));
  }

  /* ------------------------------------------------------------------------
     Сетевые помощники
     ------------------------------------------------------------------------ */

  function createTimeout(signal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, Math.max(500, timeoutMs || PROBE_TIMEOUT));

    function onAbort() { controller.abort(); }

    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    return {
      signal: controller.signal,
      get timedOut() { return timedOut; },
      cleanup: function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      },
    };
  }

  async function fetchJson(url, options) {
    const opts = options || {};
    if (typeof global.fetch !== "function") throw new Error("fetch недоступен");

    const timeout = createTimeout(opts.signal, opts.timeoutMs);
    try {
      const response = await global.fetch(url, {
        signal: timeout.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } finally {
      timeout.cleanup();
    }
  }

  function bitrateFromUrl(url) {
    const match = String(url || "").match(/-(\d{2,4})(?:[.-]|$)/);
    if (!match) return 0;
    const value = parseInt(match[1], 10);
    return value >= 16 && value <= 1024 ? value : 0;
  }

  /* ------------------------------------------------------------------------
     Адаптеры каталогов
     ------------------------------------------------------------------------ */

  async function searchRadioBrowser(provider, filters, signal) {
    const params = new URLSearchParams();
    if (filters.query) params.set("name", filters.query);
    if (filters.countryCode) params.set("countrycode", filters.countryCode);
    if (filters.genre) params.set("tag", filters.genre);
    if (filters.language) {
      params.set("language", LANGUAGE_NAMES[filters.language] || filters.language);
    }
    params.set("limit", String(provider.limit || 40));
    params.set("hidebroken", "true");
    params.set("order", "clickcount");
    params.set("reverse", "true");

    const mirrors = Array.isArray(provider.mirrors) && provider.mirrors.length
      ? provider.mirrors
      : ["https://de1.api.radio-browser.info"];
    const deadline = Date.now() + (provider.timeoutMs || 8000);
    let lastError = null;

    for (let index = 0; index < mirrors.length; index += 1) {
      if (signal && signal.aborted) throw new Error("Поиск отменён");
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      try {
        const data = await fetchJson(mirrors[index] + "/json/stations/search?" + params.toString(), {
          signal: signal,
          timeoutMs: remaining,
        });
        const list = Array.isArray(data) ? data : [];
        return list.map(function (item) {
          const tags = normalizeTags(item.tags);
          return {
            name: item.name,
            country: item.country,
            countryCode: item.countrycode,
            language: item.language,
            tags: tags,
            genre: tags[0] || "",
            homepage: item.homepage,
            url: item.url_resolved || item.url,
            bitrate: item.bitrate,
            codec: item.codec,
          };
        }).filter(function (item) { return item.url; });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Radio Browser недоступен");
  }

  async function searchSomafm(provider, filters, signal) {
    if (filters.countryCode && filters.countryCode !== "US") return [];
    if (filters.language && filters.language !== "en") return [];

    const data = await fetchJson(provider.endpoint, {
      signal: signal,
      timeoutMs: provider.timeoutMs,
    });
    const channels = Array.isArray(data && data.channels) ? data.channels : [];
    const records = [];

    channels.forEach(function (channel) {
      if (!channel || !channel.title) return;
      const playlists = Array.isArray(channel.playlists) ? channel.playlists : [];
      playlists.forEach(function (playlist) {
        if (!playlist || !playlist.url) return;
        const bitrate = bitrateFromUrl(playlist.url) ||
          (playlist.quality === "low" ? 64 : 128);
        records.push({
          name: channel.title,
          country: "США",
          countryCode: "US",
          language: "en",
          tags: normalizeTags([channel.genre, channel.id]),
          genre: channel.genre || "Eclectic",
          homepage: "https://somafm.com/" + (channel.id || "") + "/",
          url: playlist.url,
          bitrate: bitrate,
          codec: playlist.format || "",
        });
      });
    });

    return records;
  }

  function extractRadioRecord(data) {
    const root = data && (data.result || data);
    const list = Array.isArray(root)
      ? root
      : (root && Array.isArray(root.stations) ? root.stations : []);

    return list.map(function (item) {
      if (!item) return null;
      const url = item.stream_128 || item.stream_192 || item.stream_320 ||
        item.stream || item.url || "";
      if (!url) return null;
      const genre = cleanText(item.style || item.genre, 60) || "Dance / Pop";
      return {
        name: item.title || item.name || "",
        country: "Россия",
        countryCode: "RU",
        language: "ru",
        tags: normalizeTags(genre),
        genre: genre,
        homepage: "https://radiorecord.ru/",
        url: url,
        bitrate: bitrateFromUrl(url) || 128,
        codec: "",
      };
    }).filter(Boolean);
  }

  async function searchRadioRecord(provider, filters, signal) {
    let live = [];
    try {
      const data = await fetchJson(provider.endpoint, {
        signal: signal,
        timeoutMs: provider.timeoutMs,
      });
      live = extractRadioRecord(data);
    } catch (error) {
      if (signal && signal.aborted) throw error;
      // API недоступен — остаётся статический каталог каналов.
      live = [];
    }

    const catalog = (provider.catalog || []).slice();
    return live.length ? live.concat(catalog) : catalog;
  }

  function searchCatalog(provider) {
    return (provider.catalog || []).slice();
  }

  const ADAPTERS = {
    "radio-browser": searchRadioBrowser,
    somafm: searchSomafm,
    "radio-record": searchRadioRecord,
    catalog: searchCatalog,
  };

  async function runProvider(provider, filters, signal) {
    const adapter = ADAPTERS[provider.adapter || provider.id];
    if (!adapter) return [];
    const records = await adapter(provider, filters, signal);
    const filtered = provider.clientFilter ? filterRecords(records, filters) : records;
    return filtered.map(function (record) {
      return normalizeRecord(record, provider);
    }).filter(Boolean);
  }

  /* ------------------------------------------------------------------------
     Поиск
     ------------------------------------------------------------------------ */

  /**
   * Запускает поиск по всем каталогам.
   * @param {{query?: string, countryCode?: string, genre?: string, language?: string}} filters
   * @param {{signal?: AbortSignal, onBatch?: Function, onDone?: Function, fallbackOnly?: boolean}} handlers
   * @returns {Promise<{results: Array, errors: Array, aborted: boolean}>}
   */
  async function search(filters, handlers) {
    const opts = handlers || {};
    const signal = opts.signal;
    const normalized = normalizeFilters(filters);

    // Мгновенный слой: резервный каталог виден до ответа сети.
    const pool = getFallbackRecords(normalized);
    let results = mergeRecords(pool);
    if (typeof opts.onBatch === "function") {
      opts.onBatch({ results: results, provider: null, fallback: true });
    }

    if (opts.fallbackOnly) {
      const payload = { results: results, errors: [], aborted: false };
      if (typeof opts.onDone === "function") opts.onDone(payload);
      return payload;
    }

    const errors = [];

    const tasks = PROVIDERS.map(function (provider) {
      return runProvider(provider, normalized, signal).then(function (records) {
        if (signal && signal.aborted) return;
        if (records.length) pool.push.apply(pool, records);
        results = mergeRecords(pool);
        if (typeof opts.onBatch === "function") {
          opts.onBatch({ results: results, provider: provider, fallback: false });
        }
      }, function (error) {
        if (signal && signal.aborted) return;
        errors.push({
          provider: provider.id,
          label: provider.label,
          message: error && error.message ? error.message : "каталог не ответил",
        });
        if (typeof opts.onBatch === "function") {
          opts.onBatch({ results: results, provider: provider, error: error, fallback: false });
        }
      });
    });

    await Promise.allSettled(tasks);

    const aborted = Boolean(signal && signal.aborted);
    const payload = { results: results, errors: errors, aborted: aborted };
    if (!aborted && typeof opts.onDone === "function") opts.onDone(payload);
    return payload;
  }

  /* ------------------------------------------------------------------------
     Проверка потока (только видимые карточки, пул ≤ 4)
     ------------------------------------------------------------------------ */

  function probeUrl(url, signal) {
    return new Promise(function (resolve) {
      if (!utils.isHttpUrl(url)) {
        resolve({ state: "unknown", title: "Некорректный адрес потока", ok: false });
        return;
      }
      if (signal && signal.aborted) {
        resolve({ state: "unknown", title: "Проверка отменена", aborted: true });
        return;
      }

      let audio = null;
      let finished = false;
      let timer = null;

      function cleanup() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (audio) {
          try {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
          } catch (error) {
            /* элемент уже мог быть выгружен */
          }
        }
        audio = null;
      }

      function finish(state, title) {
        if (finished) return;
        finished = true;
        cleanup();
        resolve({ state: state, title: title, ok: state === "online" || state === "fallback" });
      }

      function onAbort() { finish("unknown", "Проверка отменена"); }

      try {
        audio = new Audio();
        audio.preload = "metadata";
        audio.muted = true;
        audio.volume = 0;
        audio.addEventListener("loadedmetadata", function () {
          finish("online", "Поток отвечает");
        });
        audio.addEventListener("canplay", function () {
          finish("online", "Поток отвечает");
        });
        audio.addEventListener("error", function () {
          finish("offline", "Поток не открылся");
        });
        timer = setTimeout(function () { finish("offline", "Таймаут проверки"); }, PROBE_TIMEOUT);
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        audio.src = url;
        audio.load();
      } catch (error) {
        finish("unknown", "Не удалось проверить поток");
      }
    });
  }

  function pumpProbes() {
    while (activeProbes < PROBE_CONCURRENCY && probeQueue.length) {
      const entry = probeQueue.shift();

      if (entry.signal && entry.signal.aborted) {
        entry.resolve({ state: "unknown", title: "Проверка отменена", aborted: true });
        continue;
      }

      activeProbes += 1;
      const promise = probeUrl(entry.url, entry.signal).then(function (result) {
        if (!result.aborted) probeCache.set(entry.url, { result: result, at: Date.now() });
        return result;
      }).finally(function () {
        activeProbes = Math.max(0, activeProbes - 1);
        probePending.delete(entry.url);
        pumpProbes();
      });

      probePending.set(entry.url, promise);
      promise.then(entry.resolve);
    }
  }

  function runProbe(url, signal) {
    return new Promise(function (resolve) {
      const cached = probeCache.get(url);
      if (cached && Date.now() - cached.at < PROBE_TTL) {
        resolve(cached.result);
        return;
      }
      if (probePending.has(url)) {
        probePending.get(url).then(resolve);
        return;
      }
      probeQueue.push({ url: url, signal: signal, resolve: resolve });
      pumpProbes();
    });
  }

  /**
   * Проверяет станцию: сначала основной (самый битрейтный) поток, при
   * неудаче — следующий. Играющий сейчас URL не перепроверяется.
   */
  async function probeStation(record, options) {
    const opts = options || {};
    const signal = opts.signal;
    const sources = record && Array.isArray(record.sources) ? record.sources : [];
    const urls = sources.map(function (source) { return source.url; }).filter(utils.isHttpUrl);

    if (!urls.length) return { state: "unknown", title: "Нет адреса для проверки" };

    const playback = store.state.playback;
    if (playback && playback.isPlaying && playback.url && urls.indexOf(playback.url) !== -1) {
      return { state: "online", title: "Сейчас играет — проверка не нужна", nowPlaying: true };
    }

    const primary = pickPrimarySource(sources);
    const primaryUrl = primary ? primary.url : urls[0];
    const first = await runProbe(primaryUrl, signal);
    if (first.aborted || first.state === "online") return first;

    const fallbackUrl = urls.find(function (url) { return url !== primaryUrl; });
    if (!fallbackUrl) return first;

    const second = await runProbe(fallbackUrl, signal);
    if (second.aborted) return second;
    if (second.state === "online") {
      return { state: "fallback", title: "Основной поток не отвечает, доступен резервный" };
    }
    return { state: "offline", title: "Потоки не отвечают" };
  }

  /* ------------------------------------------------------------------------
     Добавление в коллекцию
     ------------------------------------------------------------------------ */

  function findStationByRecord(record) {
    if (!record || !Array.isArray(record.sources) || !record.sources.length) return null;
    const urls = new Set(record.sources.map(function (source) { return source.url; }));
    return store.state.stations.find(function (station) {
      return store.getStationSources(station).some(function (source) {
        return urls.has(source.url);
      });
    }) || null;
  }

  function addRecord(record) {
    const existing = findStationByRecord(record);
    if (existing) return { ok: false, reason: "exists", station: existing };
    if (!record) return { ok: false, reason: "invalid", errors: { general: "Нет данных станции" } };

    const sources = (record.sources || []).slice(0, config.audio.maxSources).map(function (source) {
      return { url: source.url, bitrate: source.bitrate || 0 };
    });

    const result = store.addStation({
      name: record.name,
      emoji: "🎧",
      genre: record.genre,
      sources: sources,
      groupId: "",
    });

    if (result.ok) return { ok: true, station: result.station };
    return { ok: false, reason: "invalid", errors: result.errors || {} };
  }

  function init() {
    disposed = false;
  }

  function dispose() {
    disposed = true;
    probeQueue.length = 0;
    probePending.clear();
    probeCache.clear();
    activeProbes = 0;
  }

  MR.radioSearch = {
    init: init,
    dispose: dispose,

    search: search,
    getFallbackMatches: getFallbackMatches,

    normalizeRecord: normalizeRecord,
    normalizeName: normalizeName,
    normalizeCountryCode: normalizeCountryCode,
    stationKey: stationKey,
    mergeRecords: mergeRecords,
    pickPrimarySource: pickPrimarySource,

    probeStation: probeStation,
    findStationByRecord: findStationByRecord,
    addRecord: addRecord,

    get disposed() { return disposed; },
    get providers() { return PROVIDERS.slice(); },
  };
})(window);
