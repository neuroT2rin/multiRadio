/**
 * config/search-providers.js — реестр каталогов для панели поиска станций.
 *
 * Здесь только данные и метаданные адаптеров: идентификаторы, подписи,
 * адреса API и встроенный резервный каталог. Сетевую часть и нормализацию
 * записей реализует js/services/radio-search.js — конфиг остаётся читаемым
 * и не знает о DOM.
 *
 * Резервный каталог нужен, чтобы панель показывала результаты без сети
 * (file://, smoke-тест, отключённый интернет). Живые адаптеры дополняют его
 * и заменяют записи с теми же URL; слияние выполняет сервис.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});

  /** Страны ISO2 с русскими названиями — для фильтра и подписей карточек. */
  const COUNTRIES = [
    { code: "US", name: "США" },
    { code: "GB", name: "Великобритания" },
    { code: "DE", name: "Германия" },
    { code: "FR", name: "Франция" },
    { code: "RU", name: "Россия" },
    { code: "UA", name: "Украина" },
    { code: "BY", name: "Беларусь" },
    { code: "KZ", name: "Казахстан" },
    { code: "CA", name: "Канада" },
    { code: "AU", name: "Австралия" },
    { code: "NZ", name: "Новая Зеландия" },
    { code: "NL", name: "Нидерланды" },
    { code: "BE", name: "Бельгия" },
    { code: "LU", name: "Люксембург" },
    { code: "CH", name: "Швейцария" },
    { code: "AT", name: "Австрия" },
    { code: "IT", name: "Италия" },
    { code: "ES", name: "Испания" },
    { code: "PT", name: "Португалия" },
    { code: "IE", name: "Ирландия" },
    { code: "SE", name: "Швеция" },
    { code: "NO", name: "Норвегия" },
    { code: "DK", name: "Дания" },
    { code: "FI", name: "Финляндия" },
    { code: "IS", name: "Исландия" },
    { code: "PL", name: "Польша" },
    { code: "CZ", name: "Чехия" },
    { code: "SK", name: "Словакия" },
    { code: "HU", name: "Венгрия" },
    { code: "RO", name: "Румыния" },
    { code: "BG", name: "Болгария" },
    { code: "GR", name: "Греция" },
    { code: "TR", name: "Турция" },
    { code: "RS", name: "Сербия" },
    { code: "HR", name: "Хорватия" },
    { code: "SI", name: "Словения" },
    { code: "EE", name: "Эстония" },
    { code: "LV", name: "Латвия" },
    { code: "LT", name: "Литва" },
    { code: "MD", name: "Молдова" },
    { code: "GE", name: "Грузия" },
    { code: "AM", name: "Армения" },
    { code: "AZ", name: "Азербайджан" },
    { code: "UZ", name: "Узбекистан" },
    { code: "JP", name: "Япония" },
    { code: "KR", name: "Южная Корея" },
    { code: "CN", name: "Китай" },
    { code: "HK", name: "Гонконг" },
    { code: "TW", name: "Тайвань" },
    { code: "SG", name: "Сингапур" },
    { code: "MY", name: "Малайзия" },
    { code: "TH", name: "Таиланд" },
    { code: "VN", name: "Вьетнам" },
    { code: "ID", name: "Индонезия" },
    { code: "PH", name: "Филиппины" },
    { code: "IN", name: "Индия" },
    { code: "PK", name: "Пакистан" },
    { code: "IL", name: "Израиль" },
    { code: "AE", name: "ОАЭ" },
    { code: "SA", name: "Саудовская Аравия" },
    { code: "EG", name: "Египет" },
    { code: "MA", name: "Марокко" },
    { code: "TN", name: "Тунис" },
    { code: "DZ", name: "Алжир" },
    { code: "NG", name: "Нигерия" },
    { code: "KE", name: "Кения" },
    { code: "GH", name: "Гана" },
    { code: "ZA", name: "ЮАР" },
    { code: "BR", name: "Бразилия" },
    { code: "AR", name: "Аргентина" },
    { code: "CL", name: "Чили" },
    { code: "CO", name: "Колумбия" },
    { code: "PE", name: "Перу" },
    { code: "VE", name: "Венесуэла" },
    { code: "UY", name: "Уругвай" },
    { code: "PY", name: "Парагвай" },
    { code: "BO", name: "Боливия" },
    { code: "EC", name: "Эквадор" },
    { code: "MX", name: "Мексика" },
    { code: "CU", name: "Куба" },
    { code: "JM", name: "Ямайка" },
    { code: "TT", name: "Тринидад и Тобаго" },
    { code: "PR", name: "Пуэрто-Рико" },
    { code: "CR", name: "Коста-Рика" },
    { code: "PA", name: "Панама" },
    { code: "DO", name: "Доминикана" },
    { code: "GT", name: "Гватемала" },
    { code: "HN", name: "Гондурас" },
    { code: "SV", name: "Сальвадор" },
    { code: "NI", name: "Никарагуа" },
  ];

  /** Языки для фильтра (не претендует на полноту ISO 639-1). */
  const LANGUAGES = [
    { code: "ru", name: "Русский" },
    { code: "en", name: "Английский" },
    { code: "fr", name: "Французский" },
    { code: "de", name: "Немецкий" },
    { code: "es", name: "Испанский" },
    { code: "it", name: "Итальянский" },
    { code: "pt", name: "Португальский" },
    { code: "pl", name: "Польский" },
    { code: "uk", name: "Украинский" },
    { code: "kk", name: "Казахский" },
    { code: "nl", name: "Нидерландский" },
    { code: "sv", name: "Шведский" },
    { code: "no", name: "Норвежский" },
    { code: "da", name: "Датский" },
    { code: "fi", name: "Финский" },
    { code: "cs", name: "Чешский" },
    { code: "sk", name: "Словацкий" },
    { code: "hu", name: "Венгерский" },
    { code: "ro", name: "Румынский" },
    { code: "bg", name: "Болгарский" },
    { code: "el", name: "Греческий" },
    { code: "tr", name: "Турецкий" },
    { code: "sr", name: "Сербский" },
    { code: "hr", name: "Хорватский" },
    { code: "sl", name: "Словенский" },
    { code: "et", name: "Эстонский" },
    { code: "lv", name: "Латышский" },
    { code: "lt", name: "Литовский" },
    { code: "ja", name: "Японский" },
    { code: "ko", name: "Корейский" },
    { code: "zh", name: "Китайский" },
    { code: "ar", name: "Арабский" },
    { code: "hi", name: "Хинди" },
    { code: "fa", name: "Персидский" },
    { code: "he", name: "Иврит" },
  ];

  const COUNTRY_BY_CODE = COUNTRIES.reduce(function (map, item) {
    map[item.code] = item.name;
    return map;
  }, Object.create(null));

  function countryName(code) {
    const key = String(code || "").toUpperCase();
    return COUNTRY_BY_CODE[key] || "";
  }

  /**
   * Компактная запись резервного каталога в нормализованном виде.
   * URL намеренно указаны те же, что отдают живые адаптеры: сервис
   * объединит их в одну станцию с несколькими источниками и бейджами.
   */
  function station(provider, name, countryCode, language, genre, tags, homepage, url, bitrate, codec) {
    return {
      provider: provider,
      name: name,
      country: countryName(countryCode),
      countryCode: countryCode,
      language: language,
      genre: genre,
      tags: tags,
      homepage: homepage,
      url: url,
      bitrate: bitrate,
      codec: codec || "",
    };
  }

  const SOMAFM = "somafm";
  const PARADISE = "radioparadise";
  const FRANCE = "radio-france";
  const RECORD = "radio-record";
  const HOSTING = "hostingradio";

  const FALLBACK_CATALOG = [
    /* --- SomaFM --- */
    station(SOMAFM, "Groove Salad", "US", "en", "Downtempo / Chill",
      ["downtempo", "chill", "ambient"], "https://somafm.com/groovesalad/",
      "https://ice1.somafm.com/groovesalad-128-mp3", 128, "mp3"),
    station(SOMAFM, "Groove Salad", "US", "en", "Downtempo / Chill",
      ["downtempo", "chill", "ambient"], "https://somafm.com/groovesalad/",
      "https://ice2.somafm.com/groovesalad-128-mp3", 128, "mp3"),
    station(SOMAFM, "Drone Zone", "US", "en", "Ambient / Drone",
      ["ambient", "drone"], "https://somafm.com/dronezone/",
      "https://ice1.somafm.com/dronezone-128-mp3", 128, "mp3"),
    station(SOMAFM, "Secret Agent", "US", "en", "Lounge / Spy Jazz",
      ["lounge", "jazz", "spy"], "https://somafm.com/secretagent/",
      "https://ice1.somafm.com/secretagent-128-mp3", 128, "mp3"),
    station(SOMAFM, "Lush", "US", "en", "Vocal / Chill",
      ["vocal", "chill", "pop"], "https://somafm.com/lush/",
      "https://ice1.somafm.com/lush-128-mp3", 128, "mp3"),
    station(SOMAFM, "Deep Space One", "US", "en", "Ambient / Space",
      ["ambient", "space", "electronic"], "https://somafm.com/deepspaceone/",
      "https://ice1.somafm.com/deepspaceone-128-mp3", 128, "mp3"),
    station(SOMAFM, "Fluid", "US", "en", "Instrumental Hip-Hop",
      ["hip-hop", "instrumental"], "https://somafm.com/fluid/",
      "https://ice1.somafm.com/fluid-128-mp3", 128, "mp3"),
    station(SOMAFM, "Space Station Soma", "US", "en", "Ambient / Space",
      ["ambient", "space"], "https://somafm.com/spacestation/",
      "https://ice1.somafm.com/spacestation-128-mp3", 128, "mp3"),
    station(SOMAFM, "DEF CON Radio", "US", "en", "Electronic / Gaming",
      ["electronic", "gaming", "synthwave"], "https://somafm.com/defcon/",
      "https://ice1.somafm.com/defcon-128-mp3", 128, "mp3"),
    station(SOMAFM, "Beat Blender", "US", "en", "Deep House / Chill",
      ["house", "deep", "chill"], "https://somafm.com/beatblender/",
      "https://ice1.somafm.com/beatblender-128-mp3", 128, "mp3"),

    /* --- Radio Paradise: несколько битрейтов одного микса --- */
    station(PARADISE, "Radio Paradise: Main Mix", "US", "en", "Eclectic / Rock",
      ["eclectic", "rock", "indie"], "https://radioparadise.com/",
      "https://stream.radioparadise.com/mp3-192", 192, "mp3"),
    station(PARADISE, "Radio Paradise: Main Mix", "US", "en", "Eclectic / Rock",
      ["eclectic", "rock", "indie"], "https://radioparadise.com/",
      "https://stream.radioparadise.com/aac-320", 320, "aac"),
    station(PARADISE, "Radio Paradise: Main Mix", "US", "en", "Eclectic / Rock",
      ["eclectic", "rock", "indie"], "https://radioparadise.com/",
      "https://stream.radioparadise.com/mp3-128", 128, "mp3"),
    station(PARADISE, "Radio Paradise: Mellow Mix", "US", "en", "Mellow / Chill",
      ["mellow", "chill", "acoustic"], "https://radioparadise.com/",
      "https://stream.radioparadise.com/mellow-320", 320, "mp3"),
    station(PARADISE, "Radio Paradise: Mellow Mix", "US", "en", "Mellow / Chill",
      ["mellow", "chill", "acoustic"], "https://radioparadise.com/",
      "https://stream.radioparadise.com/mellow-128", 128, "mp3"),
    station(PARADISE, "Radio Paradise: Rock Mix", "US", "en", "Rock",
      ["rock", "classic rock"], "https://radioparadise.com/",
      "https://stream.radioparadise.com/rock-320", 320, "mp3"),
    station(PARADISE, "Radio Paradise: Rock Mix", "US", "en", "Rock",
      ["rock", "classic rock"], "https://radioparadise.com/",
      "https://stream.radioparadise.com/rock-128", 128, "mp3"),
    station(PARADISE, "Radio Paradise: Global Mix", "US", "en", "World / Global",
      ["world", "global", "eclectic"], "https://radioparadise.com/",
      "https://stream.radioparadise.com/global-320", 320, "mp3"),
    station(PARADISE, "Radio Paradise: Global Mix", "US", "en", "World / Global",
      ["world", "global", "eclectic"], "https://radioparadise.com/",
      "https://stream.radioparadise.com/global-128", 128, "mp3"),

    /* --- Radio France --- */
    station(FRANCE, "FIP", "FR", "fr", "Jazz / World",
      ["jazz", "world", "eclectic"], "https://www.radiofrance.fr/fip",
      "https://icecast.radiofrance.fr/fip-hifi.aac", 192, "aac"),
    station(FRANCE, "FIP", "FR", "fr", "Jazz / World",
      ["jazz", "world", "eclectic"], "https://www.radiofrance.fr/fip",
      "https://icecast.radiofrance.fr/fip-midfi.mp3", 128, "mp3"),
    station(FRANCE, "FIP", "FR", "fr", "Jazz / World",
      ["jazz", "world", "eclectic"], "https://www.radiofrance.fr/fip",
      "https://icecast.radiofrance.fr/fip-lofi.mp3", 64, "mp3"),
    station(FRANCE, "France Musique", "FR", "fr", "Classical",
      ["classical", "chamber"], "https://www.radiofrance.fr/francemusique",
      "https://icecast.radiofrance.fr/francemusique-hifi.aac", 192, "aac"),
    station(FRANCE, "France Musique", "FR", "fr", "Classical",
      ["classical", "chamber"], "https://www.radiofrance.fr/francemusique",
      "https://icecast.radiofrance.fr/francemusique-midfi.mp3", 128, "mp3"),
    station(FRANCE, "France Inter", "FR", "fr", "Talk / Music",
      ["talk", "news", "music"], "https://www.radiofrance.fr/franceinter",
      "https://icecast.radiofrance.fr/franceinter-hifi.aac", 192, "aac"),
    station(FRANCE, "France Inter", "FR", "fr", "Talk / Music",
      ["talk", "news", "music"], "https://www.radiofrance.fr/franceinter",
      "https://icecast.radiofrance.fr/franceinter-midfi.mp3", 128, "mp3"),
    station(FRANCE, "FIP Jazz", "FR", "fr", "Jazz",
      ["jazz"], "https://www.radiofrance.fr/fip/radio-fip-jazz",
      "https://icecast.radiofrance.fr/fipjazz-hifi.aac", 192, "aac"),
    station(FRANCE, "FIP Groove", "FR", "fr", "Funk / Groove",
      ["funk", "groove", "soul"], "https://www.radiofrance.fr/fip/radio-fip-groove",
      "https://icecast.radiofrance.fr/fipgroove-hifi.aac", 192, "aac"),
    station(FRANCE, "FIP Rock", "FR", "fr", "Rock",
      ["rock"], "https://www.radiofrance.fr/fip/radio-fip-rock",
      "https://icecast.radiofrance.fr/fiprock-hifi.aac", 192, "aac"),
    station(FRANCE, "FIP Electro", "FR", "fr", "Electronic",
      ["electronic", "electro"], "https://www.radiofrance.fr/fip/radio-fip-electro",
      "https://icecast.radiofrance.fr/fipelectro-hifi.aac", 192, "aac"),

    /* --- Radio Record --- */
    station(RECORD, "Record", "RU", "ru", "Dance / Pop",
      ["dance", "pop", "club"], "https://radiorecord.ru/",
      "https://radiorecord.hostingradio.ru/rr96.aacp", 96, "aac"),
    station(RECORD, "Record", "RU", "ru", "Dance / Pop",
      ["dance", "pop", "club"], "https://radiorecord.ru/",
      "https://radiorecord.hostingradio.ru/rr128.mp3", 128, "mp3"),
    station(RECORD, "Record Deep", "RU", "ru", "Deep House",
      ["deep house", "house"], "https://radiorecord.ru/",
      "https://radiorecord.hostingradio.ru/deep96.aacp", 96, "aac"),
    station(RECORD, "Record Dance", "RU", "ru", "Dance",
      ["dance", "club"], "https://radiorecord.ru/",
      "https://radiorecord.hostingradio.ru/dance96.aacp", 96, "aac"),
    station(RECORD, "Record Trancemission", "RU", "ru", "Trance",
      ["trance", "psytrance"], "https://radiorecord.ru/",
      "https://radiorecord.hostingradio.ru/tm96.aacp", 96, "aac"),
    station(RECORD, "Record Chill-Out", "RU", "ru", "Chillout",
      ["chillout", "downtempo"], "https://radiorecord.ru/",
      "https://radiorecord.hostingradio.ru/chillout96.aacp", 96, "aac"),
    station(RECORD, "Record Russian Mix", "RU", "ru", "Russian Pop",
      ["russian", "pop", "dance"], "https://radiorecord.ru/",
      "https://radiorecord.hostingradio.ru/rusmix96.aacp", 96, "aac"),

    /* --- HostingRadio: Европа Плюс, DFM, Наше Радио и другие --- */
    station(HOSTING, "DFM", "RU", "ru", "Dance / Pop",
      ["dance", "pop", "electronic"], "https://dfm.ru/",
      "https://dfm.hostingradio.ru/dfm128.mp3", 128, "mp3"),
    station(HOSTING, "DFM", "RU", "ru", "Dance / Pop",
      ["dance", "pop", "electronic"], "https://dfm.ru/",
      "https://dfm.hostingradio.ru/dfm96.aacp", 96, "aac"),
    station(HOSTING, "Европа Плюс", "RU", "ru", "Pop / Хиты",
      ["pop", "hits", "russian"], "https://europaplus.ru/",
      "https://ep128.hostingradio.ru:8030/ep128", 128, "mp3"),
    station(HOSTING, "Европа Плюс", "RU", "ru", "Pop / Хиты",
      ["pop", "hits", "russian"], "https://europaplus.ru/",
      "https://ep96.hostingradio.ru:8026/ep96", 96, "aac"),
    station(HOSTING, "Наше Радио", "RU", "ru", "Rock / Русский рок",
      ["rock", "russian rock"], "https://www.nashe.ru/",
      "https://nashe1.hostingradio.ru:80/nashe-128.mp3", 128, "mp3"),
    station(HOSTING, "Наше Радио", "RU", "ru", "Rock / Русский рок",
      ["rock", "russian rock"], "https://www.nashe.ru/",
      "https://nashe1.hostingradio.ru/nashe-128.mp3", 128, "mp3"),
    station(HOSTING, "Ретро FM", "RU", "ru", "Retro / Pop",
      ["retro", "pop", "disco"], "https://retrofm.ru/",
      "https://retro.hostingradio.ru:8041/retro128.mp3", 128, "mp3"),
    station(HOSTING, "Ретро FM", "RU", "ru", "Retro / Pop",
      ["retro", "pop", "disco"], "https://retrofm.ru/",
      "https://retro.hostingradio.ru:8041/retro96.aacp", 96, "aac"),
    station(HOSTING, "Русское Радио", "RU", "ru", "Pop / Russian",
      ["pop", "russian"], "https://rusradio.ru/",
      "https://rusradio.hostingradio.ru/rusradio128.mp3", 128, "mp3"),
    station(HOSTING, "Радио Шансон", "RU", "ru", "Chanson",
      ["chanson", "russian"], "https://chanson.ru/",
      "https://chanson.hostingradio.ru:8041/chanson128.mp3", 128, "mp3"),
    station(HOSTING, "Дорожное Радио", "RU", "ru", "Pop / Retro",
      ["pop", "retro", "road"], "https://dorognoe.ru/",
      "https://dorojnoe.hostingradio.ru/dorojnoe128.mp3", 128, "mp3"),
    station(HOSTING, "Love Radio", "RU", "ru", "Pop / Love",
      ["pop", "love"], "https://loveradio.ru/",
      "https://loveradio.hostingradio.ru/loveradio128.mp3", 128, "mp3"),
  ];

  /**
   * Реестр адаптеров. Поле `adapter` — ключ реализации в radio-search.js;
   * `clientFilter` — фильтровать записи на клиенте (для каталожных адаптеров);
   * `timeoutMs` — собственный таймаут запроса.
   */
  const PROVIDERS = [
    {
      id: "radio-browser",
      adapter: "radio-browser",
      label: "Radio Browser",
      homepage: "https://www.radio-browser.info/",
      timeoutMs: 8000,
      limit: 40,
      mirrors: [
        "https://de1.api.radio-browser.info",
        "https://nl1.api.radio-browser.info",
        "https://at1.api.radio-browser.info",
      ],
    },
    {
      id: "somafm",
      adapter: "somafm",
      label: "SomaFM",
      homepage: "https://somafm.com/",
      endpoint: "https://somafm.com/channels.json",
      timeoutMs: 7000,
      clientFilter: true,
    },
    {
      id: "radioparadise",
      adapter: "catalog",
      label: "Radio Paradise",
      homepage: "https://radioparadise.com/",
      clientFilter: true,
      catalog: FALLBACK_CATALOG.filter(function (item) { return item.provider === PARADISE; }),
    },
    {
      id: "radio-france",
      adapter: "catalog",
      label: "Radio France",
      homepage: "https://www.radiofrance.fr/",
      clientFilter: true,
      catalog: FALLBACK_CATALOG.filter(function (item) { return item.provider === FRANCE; }),
    },
    {
      id: "radio-record",
      adapter: "radio-record",
      label: "Radio Record",
      homepage: "https://radiorecord.ru/",
      endpoint: "https://www.radiorecord.ru/api/stations",
      timeoutMs: 6000,
      clientFilter: true,
      catalog: FALLBACK_CATALOG.filter(function (item) { return item.provider === RECORD; }),
    },
    {
      id: "hostingradio",
      adapter: "catalog",
      label: "HostingRadio",
      homepage: "https://www.hostingradio.ru/",
      clientFilter: true,
      catalog: FALLBACK_CATALOG.filter(function (item) { return item.provider === HOSTING; }),
    },
  ];

  MR.searchProviders = {
    countries: COUNTRIES.slice().sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); }),
    languages: LANGUAGES,
    providers: PROVIDERS,
    fallbackCatalog: FALLBACK_CATALOG,
    countryName: countryName,

    settings: {
      /** Задержка поиска по вводу. */
      debounceMs: 300,
      /** Таймаут проверки одного потока. */
      probeTimeoutMs: 6000,
      /** Сколько потоков проверять одновременно. */
      probeConcurrency: 4,
      /** Время жизни результата проверки. */
      probeCacheTtlMs: 5 * 60 * 1000,
      /** Сколько карточек проверять, если IntersectionObserver недоступен. */
      probeFallbackLimit: 12,
    },
  };
})(window);
