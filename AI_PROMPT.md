# AI_PROMPT — рабочий контекст для нейросетей

> **Читай этот файл первым.** Он заменяет чтение всего проекта.
> Здесь: карта ответственности, публичные API, состояние, события, команды,
> DOM/CSS-контракт, подводные камни и маршруты «задача → файлы».
> Открывай код только по маршруту из §11 и только нужные файлы.
>
> Версия проекта: **2.4.0** · обновлено: 2026-11-24
> Если этот файл расходится с кодом — прав код; обнови файл.

---

## 0. Как работать (экономия контекста)

1. Прочитай этот файл целиком. Он — основной контекст.
2. Найди задачу в маршрутной таблице §11.
3. Открой **только** перечисленные там файлы. Для точечной правки используй
   `grep` по имени функции, а не чтение файла целиком.
4. Не открывай CSS, если задача не визуальная. Не открывай `js/services/`,
   если задача про UI. Не открывай `index.html`, если тебе хватает DOM-контракта §7.
5. API, DOM-id и CSS-классы ниже — авторитетные контракты. Доверяй им.
6. Перед правкой напиши план из 3–6 шагов и перечисли файлы.
7. После правки выполни проверки §14. Меняй этот файл, только если изменилась
   архитектура (новый модуль/команда/событие/поле состояния).
8. Не читай `ARCHITECTURE.md`, если нужен только маршрут: он для глубокого
   разбора потоков данных. `README.md` — для пользователя, не для агента.

**Бюджет:** небольшая правка = 1–3 файла. Средняя = 3–5. Если хочется открыть
больше — сначала проверь, не покрывает ли задачу playbook §12.

**Полезные поисковые запросы (вместо чтения файлов):**

```bash
grep -n "function validateStationInput" js/core/state.js
grep -n "MR.commands.register" js/ui/*.js
grep -n "data-command=" index.html
grep -rn "MR.store.on(" js/ui js/visualizer
grep -n "function renderProgress" js/ui/header.js
grep -n "case\|drawSpectrum\|drawAurora\|drawOrbit" js/visualizer/background.js
```

---

## 1. Что это за проект

MultiRadio — одностраничное интернет-радио **без сборки и зависимостей**.
Открывается двойным кликом по `index.html` (`file://`), также работает с любого
статического сервера.

- 8 станций, у каждой основной URL и до 5 резервных.
- Плеер: play/pause, стоп, next/prev, громкость, mute.
- 10-полосный эквалайзер (Web Audio `BiquadFilterNode`), 7 пресетов.
- Группы станций и избранное, поиск и фильтры.
- Проверка станций на откликаемость каждые 90 с + вручную, прогресс в шапке.
- Визуализация: три режима полосы потока в плеере и полноэкранный Canvas
  (5 режимов), включаемый кнопкой «Визуализация» в шапке.
- Всё состояние — `localStorage`, экспорт/импорт JSON, миграция v1.
- Язык интерфейса — русский. Код и API — английские имена.

**Технологии:** HTML5, CSS3 (Grid/Flex, переменные), JavaScript ES2017+,
Web Audio API, Canvas 2D, localStorage. Никаких npm-пакетов, фреймворков,
транспиляции и ES-модулей.

---

## 2. Жёсткие ограничения (не нарушать)

1. **Никаких ES-модулей** (`import`/`export`) — на `file://` они блокируются.
   Каждый JS-файл — IIFE, пишущая в глобальный namespace:
   ```js
   (function (global) {
     "use strict";
     const MR = (global.MR = global.MR || {});
     // ...
   })(window);
   ```
2. **Порядок подключения скриптов важен** (см. §3). Новый файл добавляется
   в `index.html` в правильное место и в карту §3/§11.
3. **Никаких новых зависимостей и сборки.** Не предлагать React/Vite/npm.
4. **`MR.store.state` — только чтение.** Любое изменение — через действие стора.
5. **UI не мутирует state напрямую**, не пишет в `localStorage` напрямую
   (только `MR.storage`).
6. **Пользовательские строки — только `textContent`/`dom.el`.** Никакого
   `innerHTML` с именами станций/групп/URL (XSS).
7. **Никаких `alert`, `confirm`, `prompt`.** Только `MR.toast` и `MR.modal`.
8. **Один `requestAnimationFrame` на приложение** — в `visualizer/index.js`.
   Не запускать свои rAF-циклы в других модулях.
9. **Кнопки действий** — `<button type="button" data-command="...">`.
   Без `type="button"` кнопка внутри формы отправит форму.
10. **Русские подписи** в UI и комментарии; имена функций/полей — английские.

---

## 3. Карта проекта и порядок загрузки

```
index.html
css/  base.css · layout.css · components.css · player.css · visualizer.css
js/
  config/     app.js · stations.js · equalizer.js
  core/       utils.js · storage.js · state.js · dom.js
  services/   analyser.js · audio.js · network.js · health.js
  ui/         toast.js · modal.js · commands.js · views.js · nav.js · header.js
              player.js · stations.js · groups.js · equalizer.js
              station-form.js · settings.js · info.js
  visualizer/ mini.js · background.js · index.js
  main.js
tests/  store.test.js · browser-smoke.js
```

**Порядок `<script>` в `index.html` (не менять произвольно):**

```
utils → config/app → config/stations → config/equalizer → storage → state → dom
→ analyser → audio → network → health → stats → recorder → timemachine
→ toast → modal → commands → views → nav → header → player → stations → groups
→ equalizer → station-form → settings → info → stats → sleep-timer → voice-search
→ recorder → timemachine → theme → visualizer/mini → visualizer/background
→ visualizer/index → main
```

Зависимости направлены **вниз**: `ui/` и `visualizer/` знают о `core/` и
`services/`; `services/` знают о `core/`; `core/` не знает о UI/DOM
(исключение — `core/dom.js`, это обёртка DOM).

---

## 4. Ответственность файлов

| Файл | Отвечает за | Ключевые функции / экспорт |
|---|---|---|
| `js/config/app.js` | Версия, ключ хранилища, интервалы, лимиты, режимы, окно тайм-машины, подписи статусов | `MR.config`, `MR.config.playbackLabels` |
| `js/config/stations.js` | 8 стартовых станций | `MR.defaults.stations` |
| `js/config/equalizer.js` | 10 полос EQ, 7 пресетов | `MR.defaults.eqBands`, `eqPresets`, `findPreset(gains)` |
| `js/core/utils.js` | Чистые функции | `el`, `clamp`, `slugify`, `isHttpUrl`, `parseUrlList`, `pluralRu`, `formatDuration`, `formatRelative`, `formatBytes`, `debounce`, `prefersReducedMotion`, `uid` |
| `js/core/storage.js` | Безопасный localStorage + memory fallback | `get`, `set`, `remove`, `size`, `isAvailable` |
| `js/core/state.js` | Единое состояние, действия, события, нормализация, persist, импорт/экспорт | `MR.store` (§5) |
| `js/core/dom.js` | DOM-хелперы | `$`, `$$`, `el`, `on`, `delegate`, `setText`, `setHidden`, `toggleClass`, `focusFirst`, `ready` |
| `js/services/analyser.js` | Один `AnalyserNode` на всё приложение | `attach(node)`, `detach()`, `read(now)`, `size`, `isAttached` |
| `js/services/audio.js` | `<audio>` + Web Audio, фолбэки, compat-режим, громкость, EQ | `init`, `dispose`, `playStation`, `toggle`, `pause`, `stop`, `next`, `prev`, `isCompat`, `isGraphReady`, `getSourceLabel` |
| `js/services/network.js` | online/offline, `navigator.connection`, контрольные запросы | `init`, `check`, `dispose` |
| `js/services/health.js` | Проверка URL через `Audio(preload=metadata)`, пул, прогресс | `init`, `run({manual})`, `dispose`, `isRunning` |
| `js/services/stats.js` | Статистика прослушивания (секунды по станциям/жанрам) | `init`, `getSummary`, `reset`, `dispose` |
| `js/services/recorder.js` | Запись эфира через MediaRecorder в файл | `start`, `stop`, `isRecording`, `supported`, `dispose` |
| `js/services/timemachine.js` | Буфер последних минут и перемотка в WAV (окно — из настроек) | `init`, `availableSeconds`, `prepare`, `playFrom`, `seek`, `resume`, `returnLive`, `isEnabled`, `isBufferPlaying`, `maxSeconds`, `dispose` |
| `js/ui/commands.js` | Шина `data-command` → обработчик | `init`, `register`, `registerMany`, `run`, `has` |
| `js/ui/toast.js` | Тосты; слушает `notice` | `init`, `show`, `success`, `error`, `warning`, `info` |
| `js/ui/modal.js` | Модалки, focus trap, `confirm()` | `init`, `open`, `close`, `closeAll`, `confirm`, `isOpen`, `hasOpen` |
| `js/ui/views.js` | Вкладки «Станции/Избранные/Эквалайзер» | `init`, `apply`, `set(view)` |
| `js/ui/nav.js` | Выпадающие меню, keyboard, mobile drawer, галочки | `init`, `closeAll` |
| `js/ui/header.js` | Бейджи сети/плеера, прогресс проверки, `document.title` | `init` |
| `js/ui/player.js` | Карточка «сейчас играет», управление, громкость, `Space` | `init`, `render` |
| `js/ui/stations.js` | Списки станций/избранного, поиск, фильтры, вид «список/плитка», точки здоровья | `init`, `render` |
| `js/ui/groups.js` | CRUD групп, модалка, чекбоксы, фильтр группы, аккордеон (не более одной открытой), прокрутка >5 и поиск >10 | `init`, `render`, `openEditor(groupId)` |
| `js/ui/equalizer.js` | Ползунки, пресеты, индикаторы | `init`, `tick(analysis)`, `update` |
| `js/ui/station-form.js` | Добавление/редактирование/удаление станции | `init`, `open({mode, stationId})` |
| `js/ui/settings.js` | Настройки вида, compat, буфер эфира, export/import (глобальный drag-and-drop только для JSON, замена или слияние), reset | `init`, `open` |
| `js/ui/info.js` | Карточка «Источники и сеть», ручная проверка | `init`, `render`, `dispose` |
| `js/ui/sleep-timer.js` | Таймер сна в шапке: отсчёт и остановка радио | `init`, `start(minutes)`, `cancel`, `dispose`, `remainingMs` |
| `js/ui/voice-search.js` | Голосовой подбор станции (Web Speech API + локальный матчер) | `init`, `start`, `stop`, `match(text)`, `supported`, `dispose` |
| `js/ui/stats.js` | Панель статистики: станции и жанры | `init`, `render` |
| `js/ui/theme.js` | Светлая/тёмная тема: `data-theme` на `<html>`, кнопка в шапке | `init`, `apply` |
| `js/ui/recorder.js` | Кнопка записи и чип REC в плеере | `init`, `render`, `dispose` |
| `js/ui/timemachine.js` | Ползунок перемотки и кнопка LIVE | `init`, `render` |
| `js/visualizer/mini.js` | Визуализация потока в плеере (3 режима) | `init`, `draw(analysis)`, `drawIdle`, `setMode`, `mode`, `resize`, `dispose` |
| `js/visualizer/background.js` | Полноэкранный canvas, режимы | `init`, `draw(analysis, dt, now)`, `resize`, `setMode`, `mode` |
| `js/visualizer/index.js` | Единственный rAF-цикл, синхронизация UI и режим визуализации | `init`, `dispose`, `setVizMode(bool)`, `isVizMode()` |
| `js/main.js` | Инициализация, uptime, cleanup | — |
| `css/base.css` | Сброс, токены, типографика, утилиты | `:root` переменные, `.sr-only`, `.skip-link` |
| `css/layout.css` | Шапка, меню, прогресс, сетка, футер, адаптив | `.app-header`, `.main-nav`, `.health-progress`, `.app-container` |
| `css/components.css` | Кнопки, бейджи, формы, модалки, тосты, группы, настройки | `.btn`, `.badge`, `.modal`, `.toast`, `.group-card` |
| `css/player.css` | Плеер, вкладки, станции, EQ, мини-визуализатор | `.player-card`, `.station-row`, `.eq-band` |
| `css/visualizer.css` | Фоновая визуализация и режим визуализации | `.bg-visualizer`, `body.is-viz-mode` |

---

## 5. `MR.store` — API и состояние

### 5.1 Состояние (читать через `MR.store.state`)

```js
{
  stations: [{ id, name, genre, bitrate, emoji, primary, fallbacks: [] }],
  favorites: Set<id>,
  groups: [{ id, name, stationIds: [] }],        // станция максимум в одной группе
  filters: { favoritesOnly, groupId, query },
  view: 'stations' | 'favorites' | 'equalizer',

  playback: {
    status: 'idle'|'connecting'|'buffering'|'playing'|'paused'|'error'|'blocked',
    stationId, urlIndex, url, sourceLabel, isPlaying, error
  },

  volume: 0..1,
  muted: bool,
  eqGains: number[10],       // −20..+20 дБ
  eqPreset: 'flat'|'bass'|'vocal'|'rock'|'jazz'|'electronic'|'night'|'custom',

  health: { [stationId]: { primary: Probe, fallbacks: Probe[], checkedAt } },
  healthProgress: { running, done, total, stationsDone, stationsTotal, startedAt, finishedAt },

  network: { online, status: 'checking'|'online'|'restricted'|'offline',
             effectiveType, downlink },

  ui: { bgEnabled,
        mode: 'spectrum'|'aurora'|'orbit'|'tunnel'|'spiral',
        miniMode: 'wave'|'ribbon'|'sparkle',
        stationView: 'list'|'grid', theme: 'dark'|'light', compatMode,
        bufferEnabled, bufferMinutes }   // 1|2|3|5|10, по умолчанию 3
}
```

`Probe = { ok: bool, reason: 'timeout'|'media-error'|'offline'|'invalid-url'|'no-url'|null }`

### 5.2 Методы

| Группа | Сигнатуры |
|---|---|
| Жизненный цикл | `init()`, `on(event, fn) → off`, `emit(event, detail)`, `save()`, `saveNow()`, `serialize()`, `hydrate(data)` |
| Селекторы | `findStation(id)`, `getStationIndex(id)`, `getCurrentStation()`, `getGroup(id)`, `getGroupOfStation(id)`, `getVisibleStations()`, `getStationUrls(station)`, `getHealth(id)`, `getHealthSummary()` |
| Станции | `addStation(input) → {ok, station?, errors}`, `updateStation(id, input) → {ok, station, errors, streamChanged}`, `removeStation(id)`, `validateStationInput(input, excludeId?)` |
| Избранное | `toggleFavorite(id)`, `clearFavorites()` |
| Группы | `addGroup({name, stationIds})`, `updateGroup(id, input)`, `deleteGroup(id)`, `assignStationToGroup(stationId, groupId\|null)`, `removeStationFromGroup(stationId, groupId)`, `validateGroupInput(input, excludeId?)` |
| Фильтры | `setFilters({favoritesOnly?, groupId?, query?})`, `clearFilters()` |
| Плеер/звук | `setPlayback(patch)`, `setVolume(0..1)`, `toggleMute()`, `setEqGain(i, дБ)`, `setEqGains(arr)`, `applyEqPreset(key)`, `resetEq()` |
| Проверка | `setHealth(id, result)`, `setHealthBatch(map)`, `setHealthProgress(patch)` |
| Сеть/вид | `setNetwork(patch)`, `setView(view)`, `setBgEnabled(bool)`, `toggleBg()`, `setVisualizerMode(mode)`, `setMiniMode(mode)`, `setStationView('list'\|'grid')`, `setTheme('dark'\|'light')`, `setCompatMode(bool)`, `setBufferEnabled(bool)`, `setBufferMinutes(n)` |
| Данные | `exportData() → v2-объект`, `importData(obj, {mode:'replace'\|'merge'}) → {ok, mode, counts\|error}`, `resetAll()`, `restoreDefaultStations()` |

### 5.3 Входные данные

```js
// Станция
{ name, emoji, genre, bitrate, primary, fallbacks: string[] | "url1, url2", groupId }
// Ошибки: { field: "текст" }, field ∈ name|genre|bitrate|primary|fallbacks|groupId|general
// Группа
{ name, stationIds: string[] }   // ошибки: name|general
```

Правила: имя станции/группы уникально без учёта регистра; `primary` — абсолютный
`http(s)` URL; `fallbacks` без дублей и без `primary`, ≤5; станция состоит
максимум в одной группе; удаление станции чистит избранное, группы и здоровье.
`id` новой станции генерируется из названия (`utils.slugify`, транслитерация
кириллицы) и всегда соответствует `[a-z0-9-]`; при совпадении добавляется `-2`, `-3`.

### 5.4 События

| Событие | Payload | Когда |
|---|---|---|
| `stations` | — | добавление/удаление/правка станции, ★ |
| `favorites` | — | изменение избранного |
| `groups` | — | CRUD групп, membership |
| `filters` | — | поиск/фильтр |
| `view` | — | смена вкладки |
| `playback` | `state.playback`* | статус/источник |
| `volume` | — | громкость/mute |
| `eq` | — | ползунки/пресет |
| `health` | — | результат проверки |
| `health:progress` | `state.healthProgress`* | старт/шаг/финиш проверки |
| `network` | `state.network`* | смена сети |
| `ui` | — | фон/режим/мини-режим/compat/буфер |
| `notice` | `{ level: 'success'\|'error'\|'warning'\|'info', message }` | тост |

\* Некоторые вызовы (`emitAll`, `setNetwork` через `emitAll`) приходят **без
payload**. Обработчик обязан делать `payload = payload || store.state.X`.

### 5.5 Persist (localStorage)

Ключ: `multiradio:state:v2`. Схема:

```js
{
  app: "MultiRadio", version: 2, savedAt,
  stations: [{ id, name, genre, bitrate, emoji, primary, fallbacks }],
  favorites: [id], groups: [{ id, name, stationIds }],
  volume, muted, eq: { gains: [10], preset }, view,
  ui: { bgEnabled, mode, miniMode, stationView, theme, compatMode,
        bufferEnabled, bufferMinutes }
}
```

`miniMode` — режим визуализации потока в плеере; при загрузке проверяется по
`MR.config.miniVisualizerModes`, неизвестное значение откатывается к `wave`.

`bufferEnabled`/`bufferMinutes` — «машина времени». Длительность проверяется по
`MR.config.timemachine.options` (`[1, 2, 3, 5, 10]`), иначе берётся
`defaultMinutes = 3`. Выключение освобождает PCM, скрывает ползунок и LIVE.

`hydrate(data)` понимает v1: `volume`, `equalizer[]`, `favorites`, `groups`,
`stationGroups` (маппинг → membership), `stations`.
Сохранение — debounce 300 мс; `saveNow()` — немедленно.

Статистика прослушивания хранится отдельным ключом `multiradio:stats:v1`:
`{ totalSeconds, stations: { id: { seconds, lastAt } }, genres: { name: seconds } }`.
В экспорт/импорт настроек она не входит; сбрасывается командой `stats:reset`.

---

## 6. Команды (шина действий)

Кнопка: `<button type="button" data-command="domain:action" data-...>...</button>`.
Обработчик регистрируется в `init()` профильного UI-модуля:
`MR.commands.register('domain:action', fn)`, аргумент — `{source, dataset, event}`.

| Команда | Где обработчик |
|---|---|
| `view:stations`, `view:favorites`, `view:equalizer` | `ui/views.js` |
| `station:add` | `ui/station-form.js` |
| `station:edit`, `station:play`, `station:favorite`, `filter:favorites`, `stations:view` | `ui/stations.js` |
| `group:create`, `group:edit`, `group:delete`, `group:filter`, `group:clear-filter`, `group:remove-station`, `group:toggle` | `ui/groups.js` |
| `playback:toggle`, `playback:stop`, `playback:next`, `playback:prev`, `playback:mute` | `ui/player.js` |
| `eq:reset` | `ui/equalizer.js` |
| `health:check` | `ui/info.js` |
| `timer:start`, `timer:cancel` | `ui/sleep-timer.js` |
| `search:voice` | `ui/voice-search.js` |
| `stats:reset` | `ui/stats.js` |
| `ui:theme` | `ui/theme.js` |
| `record:toggle` | `ui/recorder.js` |
| `settings:open`, `settings:export`, `settings:import`, `settings:reset`, `settings:restore-stations` | `ui/settings.js` |
| `ui:toggle-bg`, `ui:mode`, `ui:mini-mode`, `ui:viz-mode` | `visualizer/index.js` |

Новую команду регистрировать **до** первого клика (в `init()`), иначе
`commands.run` напишет warning.

### 6.1 Шпаргалка вызовов (не открывать модули ради этого)

```js
// Уведомление
MR.toast.success("Готово.", { timeout: 2600 });
MR.store.emit("notice", { level: "warning", message: "Текст" });

// Подтверждение (Promise<boolean>)
const ok = await MR.modal.confirm({
  title: "Удалить?", message: "Текст", confirmLabel: "Удалить",
  cancelLabel: "Отмена", danger: true,
});

// Модалки и формы
MR.modal.open("#modal-settings", { initialFocus: "#setting-bg" });
MR.modal.close("#modal-settings");
MR.stationForm.open({ mode: "edit", stationId: "fip" });
MR.groupsUI.openEditor(groupId);          // null → создание
MR.commands.run("view:equalizer");

// Подписка и ручная отрисовка
const off = MR.store.on("groups", () => render());
const row = MR.dom.el("li", { class: "station-row" },
  MR.dom.el("button", { type: "button", text: "Play" }),
  MR.dom.el("span", { text: "хвост" })
);
document.querySelector("#stations-list").appendChild(row);
```

---

## 7. DOM- и CSS-контракт

Разметка — `index.html` (≈700 строк). Часто используемые id:

```text
Шапка:    app-header, main-nav, nav-toggle, viz-toggle, theme-toggle,
          theme-icon, sleep-timer, sleep-timer-label, network-badge,
          network-badge-text, stream-status, health-progress,
          health-progress-fill, health-progress-label
Плеер:    station-name, station-genre, station-bitrate-chip, station-source-chip,
          record-chip, player-art-emoji, play-pause-btn, play-pause-icon, stop-btn,
          prev-btn, next-btn, record-btn, volume, volume-value, mute-btn, mute-icon,
          mini-canvas, mini-hint, timemachine, timemachine-live
Вкладки:  tab-stations, tab-favorites, tab-equalizer, panel-stations,
          panel-favorites, panel-equalizer,
          stations-search, voice-search-btn, voice-live, filter-favorites,
          group-filter-chip, group-filter-name,
          stations-count, stations-list, stations-empty, favorites-list,
          favorites-empty, eq-presets, eq-controls, eq-hint
Группы:   groups-list, groups-empty, groups-search, modal-group, group-form,
          group-modal-title,
          group-modal-subtitle, gr-name, group-station-options, group-submit,
          group-delete, group-form-error
Станция:  modal-station, station-form, station-modal-title, station-modal-subtitle,
          st-name, st-emoji, st-genre, st-bitrate, st-primary, st-fallbacks,
          st-group, station-submit, station-delete, station-form-error
Настройки: modal-settings, setting-bg, setting-mode, setting-compat,
          setting-buffer, setting-buffer-minutes, import-file,
          settings-version, settings-storage
Прочее:   modal-confirm, confirm-title, confirm-message, confirm-ok, confirm-cancel,
          modal-import, import-title, import-warning, import-merge, import-replace,
          import-cancel, import-drop, drop-overlay, info-connection, info-connection-state,
          info-source, info-bitrate,
          info-playback, info-health, recheck-btn, recheck-label,
          stats-total, stats-stations, stats-genres, stats-empty,
          bg-visualizer, bg-canvas, uptime, toast-region
```

Полный список: `grep 'id="' index.html`. ID — контракт: если переименовываешь,
ищи `grep '#id' js/`.

**Раскладка:** `.content-main` — «Станции/Избранные/Эквалайзер» и «Источники и
сеть»; `.content-side` — «Быстрые действия», под ним «Группы станций».
Отдельной панели визуализации нет: режимы и фон — в меню «Вид» и в настройках.
В меню «Вид» три блока: «Фон» (`ui:toggle-bg`), «Режим визуализации»
(`ui:mode`, полный экран) и «Визуализация потока» (`ui:mini-mode`, полоса
в плеере).

**Состояния бейджей:** `[data-state]` на `.badge`: `pending|online|restricted|offline`
(сеть), `idle|connecting|buffering|playing|paused|error|blocked` (плеер).

**Ключевые CSS-классы:**

| Блок | Классы |
|---|---|
| Каркас | `.app-header`, `.header-inner`, `.brand`, `.main-nav`, `.nav-group`, `.nav-btn`, `.nav-menu`, `.nav-item`, `.header-meta`, `.nav-toggle` |
| Прогресс | `.health-progress`, `.is-active`, `.health-progress__track`, `__fill`, `__label` |
| Карточки | `.card`, `.content-grid`, `.content-main`, `.content-side`, `.section-head`, `.section-title` |
| Кнопки | `.btn`, `.btn-primary`, `.btn-outline`, `.btn-ghost`, `.btn-danger`, `.btn-sm`, `.icon-btn`, `.icon-btn--sm` |
| Станции | `.view-tabs`, `.view-tab`, `.toolbar`, `.view-switch`, `.view-switch__btn[aria-pressed]`, `.stations-list`, `.stations-list--grid`, `.station-row`, `.is-active`, `.station-row__main/__body/__name/__meta/__actions`, `.health-dot[data-health=online|fallback|offline|checking|unknown]` |
| EQ | `.eq-controls`, `.eq-band`, `.eq-band__slider`, `.eq-meter__fill`, `.eq-preset[aria-pressed]` |
| Группы | `.group-card`, `.is-filtered`, `.is-expanded`, `.group-card__head/__toggle/__chev/__stations/__actions`, `.group-station`, `.groups-search`, `.groups-list.is-scrollable` |
| Модалки | `.modal`, `.modal__backdrop/__panel/__header/__body/__footer` |
| Формы | `.form`, `.form-grid`, `.field`, `.field--span2`, `.field__error`, `.input`, `.checklist`, `.check-item` |
| Тосты | `.toast-region`, `.toast--success|error|warning|info` |
| Drag&drop импорта | `.drop-overlay`, `.drop-overlay__panel/__icon/__title/__hint`, `body.is-file-dragging`, `.import-drop`, `.is-dragover` |
| Визуализация | `.bg-visualizer.is-hidden`, `.mini-visualizer`, `body.is-viz-mode`, `.nav-group--view`, `.viz-btn[aria-pressed]` |

**CSS-файлы:** базовые токены (`--bg-0`, `--surface`, `--accent`, `--danger`,
`--radius-*`, `--header-height`) — только `base.css`. Не хардкодить цвета в
компонентах, если есть токен. Исключение: градиенты Canvas — они заданы
константами в `mini.js`/`background.js`.

**Темы:** `html[data-theme="light"]` переопределяет токены в `base.css` и
добавляет блок в конце каждого css-файла (компоненты, каркас, плеер, фон).
Новый компонент со своим `background` обязан получить пару в светлом блоке,
иначе он останется тёмным. Canvas в светлой теме инвертируется фильтром.

**Прозрачность панелей:** `.card` намеренно полупрозрачный
(градиент `rgba(17,28,46,0.76)` → `rgba(9,16,28,0.82)` + `blur(16px)`), чтобы
фоновая визуализация умеренно просвечивала. Не опускать альфу ниже ~0.7:
пропадёт контраст текста на светлых участках спектра.

**Адаптив:** 1080px — мобильное меню; 980px — одна колонка; 720px — компактный
плеер; 520px — скрыт сетевой бейдж.

---

## 8. Аудио: как устроено и что не сломать

```
<audio> → MediaElementSource → Gain(volume) → BiquadFilter ×10 → Analyser → destination
```

- `ensureGraph()` создаёт `AudioContext` и граф **лениво**, при первом play
  (браузер требует жест). Внутри выставляется `audioEl.crossOrigin = "anonymous"`
  **до** первой загрузки — иначе Web Audio не получит данные.
- `createMediaElementSource` можно вызвать для элемента только один раз.
  Поэтому режим совместимости **пересоздаёт** `<audio>` и закрывает контекст.
- Цепочка источников: `primary`, затем `fallbacks` по порядку.
  Таймаут подключения — 12 с; пауза перед резервом — 0.7 с.
- Если все адреса не загрузились и Web Audio включён — включается
  `ui.compatMode`: прямой звук без анализа, EQ/спектр отключаются.
  Повтор с первого URL; если и там ошибка — `playback.status='error'`.
- В compat-режиме громкость применяется к `audioEl.volume`, в обычном — к GainNode.
- `state.playback.sourceLabel` = «основной источник» / «резерв N из M».
- `toggle()`: играет → pause; пауза с загруженным src → resume;
  ошибка → повтор с `urlIndex=0`.

**Ошибки media (код 4)** не позволяют отличить 404 от CORS. Не пытайся
«починить» это точной проверкой — используй существующую эвристику.

---

## 9. Визуализация

- `analyser.read(now)` вызывается **один раз за кадр** в `visualizer/index.js`.
  Возвращает:
  ```js
  { active, silent, level, bass, mid, treble,
    spectrum: number[64], eqBands: number[10],
    wave: Uint8Array, beat: boolean }
  ```
- `visualizer/index.js::frame` раздаёт данные: `mini.draw(analysis)`,
  `eqUI.tick(analysis)` (~20 Гц), `bg.draw(analysis, dt, now)` (30 fps при игре,
  ~16 fps в режиме визуализации без звука, ~9 fps в паузе). Не создавай второй rAF.
- `MR.bg` режимы: `spectrum` (круговой спектр), `aurora` (волны), `orbit` (орбиты),
  `tunnel` (непрерывный полёт сквозь органический 3D-туннель: замкнутые
  кривые Безье-стены, изгибы осевой линии и закрутка по глубине; камера
  движется сама, а музыка меняет только цвет и скорость смены палитры) и
  `spiral` (галактика из спиральных рукавов).
  Круговой спектр центрируется по экрану (`cy = height * 0.5`), орбиты — чуть
  выше центра (`0.46`), чтобы кольца не упирались в подвал.
  В `orbit` центральное ядро пульсирует: `coreRadius` зависит от `level`,
  `bass`, `beat` и `treble`, вокруг рисуется двойной ореол и энергетическое
  кольцо. Не делай ядро статичным — это главный акцент режима.
  Добавление режима: `config/app.js` → ветка в `background.js::draw` →
  кнопка `data-command="ui:mode" data-mode="..."` в меню «Вид» → `visualizer/index.js`
  и `ui/nav.js` синхронизируют `aria-checked` автоматически.
- **Режим визуализации** — `#viz-toggle` в шапке (команда `ui:viz-mode`):
  ставит `body.is-viz-mode`, скрывает всё, кроме группы «Вид» и самой кнопки,
  разворачивает фон на весь экран и не трогает сохранённый `ui.bgEnabled`.
  Повторный клик, `Esc` или `V` (в русской раскладке — `М`) возвращают страницу
  и прежнюю позицию скролла.
- `MR.mini` — компактная визуализация потока с тремя режимами
  (`ui.miniMode`): `wave` — зеркальная плавная волна; `ribbon` — несколько
  световых лент с аддитивным свечением; `sparkle` — искры из светящегося
  основания (частицы живут внутри `mini.js`, своего rAF не создают).
  Общая база: 72 опорные точки, косинусная выборка спектра, Catmull-Rom
  сглаживание и экспоненциальное сглаживание по времени (`ATTACK`/`RELEASE`).
  Режим задаётся `MR.mini.setMode(mode)` из `applyUi`; столбиков больше нет —
  не возвращай их.
- Canvas: DPR ≤2, `setTransform` после изменения размеров, `canvas.width`
  меняется только при реальном resize (иначе каждый кадр очищает canvas).
- `prefers-reduced-motion` → статичный кадр, без цикла.
- `analysis.silent` = играет, но данных нет (обычно CORS) — подсказка `#mini-hint`.
- `ui.bgEnabled=false` → `.bg-visualizer.is-hidden`, фон не рисуется (кроме
  режима визуализации: там фон показывается принудительно).

---

## 10. Проверка станций и сеть

**Health** (`services/health.js`):
- каждый URL проверяется `<audio preload="metadata">` **без** `crossOrigin`;
- пул 10 воркеров, таймаут 6 с; одинаковые URL разных станций проверяются
  один раз (дедупликация), станции без адресов завершаются сразу;
- прогресс: `done/total` по источникам и `stationsDone/stationsTotal` по станциям;
- результат станции: `{primary: Probe, fallbacks: Probe[], checkedAt}`;
- адрес, который сейчас звучит, не проверяется повторно (`reason: "now-playing"`):
  второй запрос к тому же потоку может оборвать вещание;
- автораз в 90 с (только видимая вкладка), вручную — `MR.health.run({manual:true})`;
- повторный запуск при `running` игнорируется (для manual — тост).

**Network** (`services/network.js`): `navigator.onLine`, `navigator.connection`,
проверка двух control-хостов через `fetch(..., {mode:'no-cors'})`.
Статусы: `online` / `restricted` (возможен VPN/фильтр) / `offline`.
VPN точно определить нельзя — не обещать этого.

**Прогресс в шапке:** `health:progress` → `ui/header.js::renderProgress`:
`hidden=false` + `.is-active`, ширина `done/total`, подпись
«Проверка станций · X/Y», после финиша 1.5 с показывается сводка и полоса скрывается.

---

## 11. Маршрутная таблица «задача → файлы»

| Задача | Читать | Править | Проверка |
|---|---|---|---|
| Меню, пункты, mobile drawer | `ui/nav.js`, `index.html` (header), `css/layout.css` | те же | клик/клавиатура, mobile resize |
| Новая кнопка/действие | `ui/commands.js` + модуль-владелец | `index.html`, `init()` модуля | `commands.has(name)`, клик |
| Список станций, поиск, фильтры, избранное | `ui/stations.js`, `store.getVisibleStations` | `ui/stations.js` | список/empty state/фильтр |
| Валидация или добавление станции | `core/state.js` (`validateStationInput`, `addStation`), `ui/station-form.js` | оба + `index.html` (modal) | `tests/store.test.js` |
| Поля станции в хранилище | `state.js::normalizeStation`, `serialize`, `hydrate` | те же + `config/stations.js`, форма | тесты, reload |
| Группы и фильтр группы | `state.js` (group actions), `ui/groups.js`, `ui/stations.js` | те же + modal в HTML | тесты, создание/фильтр, прокрутка/поиск |
| Плеер, play/pause, громкость | `ui/player.js`, `services/audio.js` | те же | клик, статус, звук |
| Фолбэки, CORS, compat | `services/audio.js` | `audio.js` (+ `ui/settings.js`, если настройка) | аудио-тест/локальный WAV |
| Эквалайзер, пресеты, полосы | `config/equalizer.js`, `ui/equalizer.js`, `audio.js::applyEq` | те же | 10 полос, пресет, метры |
| Визуализатор, режимы, canvas | `visualizer/*`, `analyser.js` | те же + `visualizer.css` | скриншот, `level>0`, нет ошибок |
| Режим визуализации (шапка) | `visualizer/index.js`, `index.html` (header), `css/layout.css` | те же | клик туда/обратно, `Esc`, скрытие панелей |
| Таймер сна | `ui/sleep-timer.js`, меню в шапке | `sleep-timer.js`, `index.html`, `main.js` | запуск/отмена, отсчёт, остановка |
| Голосовой подбор станции | `ui/voice-search.js`, `index.html` (toolbar) | те же | `MR.voiceSearch.match()`, микрофон, fallback |
| Статистика прослушивания | `services/stats.js`, `ui/stats.js` | те же + `index.html` (сайдбар) | включить радио, подождать, панель |
| Светлая тема | `ui/theme.js`, `css/base.css` (токены), блоки `html[data-theme="light"]` во всех css | те же + `state.js` | переключение, reload, контраст |
| Запись эфира | `services/recorder.js`, `services/audio.js` (`getCaptureStream`), `ui/recorder.js` | те же + `player.css` | старт/стоп, файл, CORS-режим |
| Тайм-машина | `services/timemachine.js`, `services/audio.js` (`createPCMTap`), `ui/timemachine.js`, `config/app.js::timemachine`, `state.js` (`bufferEnabled`/`bufferMinutes`) | те же + `ui/settings.js`, `index.html` (настройки), `player.css` | буфер, отмотка, пауза, LIVE, настройки, память |
| Режимы визуализации потока (мини) | `visualizer/mini.js`, `config/app.js`, `state.js` (`miniMode`), `index.html` (меню «Вид») | те же | переключение, отрисовка в каждом режиме, reload |
| Прогресс/статусы в шапке | `ui/header.js`, `services/health.js`, `health:progress` | `header.js`, `layout.css` | ручная проверка, полоса |
| Сеть/VPN-статус | `services/network.js`, `ui/header.js`, `ui/info.js` | те же | online/offline, бейдж |
| Настройки, export/import | `ui/settings.js`, `state.js::exportData/importData` | те же + `modal-settings`/`modal-import`/`#drop-overlay`/`components.css` | экспорт→импорт, v1-файл, замена, слияние, drop файла в любое место окна, буфер |
| Тема, цвета, отступы | `css/base.css` + конкретный css | css | визуальный просмотр |
| Адаптив | `css/layout.css`, `css/player.css`, `css/components.css` | css | 390/768/1440 |
| Тесты логики | `tests/store.test.js` | тест + код | 23/23 |

---

## 12. Playbooks

### A. Добавить поле станции (например, «страна»)
1. `config/stations.js` — добавить поле в стартовые станции (опционально).
2. `state.js`: `normalizeStation` (чтение/валидация), `validateStationInput`
   (правило), `addStation`/`updateStation` (проброс), `serialize`/`hydrate`.
3. `index.html`: поле в `#station-form` + `data-error-for`.
4. `ui/station-form.js`: `FIELD_IDS`, `open()`, `collect()`.
5. `ui/stations.js::createRow` — если поле видно в списке.
6. `tests/store.test.js` — добавить проверку сохранения/валидации.
7. `AI_PROMPT.md` — обновить схему состояния/persist, если поле сохраняется.

### B. Добавить команду
1. В `init()` модуля-владельца: `MR.commands.register('domain:action', fn)`.
2. HTML: `<button type="button" data-command="domain:action">`.
3. Если кнопка в модалке — проверь, что форма не отправляется.
4. Проверить порядок init в `main.js` (модуль должен инициализироваться до клика).
5. Добавить строку в таблицу §6.

### C. Добавить режим визуализации
1. `config/app.js`: имя в `visualizerModes`.
2. `background.js`: функция `drawMyMode(...)` + ветка в `draw()`.
3. `index.html`: кнопка в меню «Вид» (`data-command="ui:mode"`) и `<option>`
   в `#setting-mode`; отдельной панели визуализации в сайдбаре нет.
4. `visualizer/index.js`: ничего, если режим берётся из `store.state.ui.mode`.
5. Проверить DPR/resize/reduced-motion.

### D. Изменить оформление
1. Сначала токены в `base.css`. 2. Затем конкретный css-файл.
3. Не ломать контраст текста на фоне canvas.
4. Проверить 390px и 1440px; меню, модалки, тосты.
5. Не переносить стили между файлами без причины.

### E. Исправить группу
1. Инвариант: membership — только `group.stationIds`, без `stationGroups`.
2. Проверить `addGroup`/`updateGroup`/`assignStationToGroup` на перемещение
   станции из прежней группы.
3. UI: `groups.js` + `stations.js` (фильтр и чип).
4. Тест: дубликат имени, перенос, удаление, фильтр.

### F. Разобрать проблему со звуком
1. `state.playback.status/error` → какой этап: connecting, error, blocked.
2. `audio.js`: `onError`, `tryNext`, `applyCompatMode`, `ensureGraph`.
3. Проверить, не сработал ли ранее compat (`state.ui.compatMode`).
4. Локальный тест: WAV data URL через `MR.audio.playStation` (см. `tests/browser-smoke.js`).
5. Не добавлять второй `AudioContext`/rAF.

### G. Добавить новый модуль
1. Файл-IIFE в нужной папке, API на `MR`.
2. `<script>` в `index.html` в правильное место порядка загрузки.
3. `init()` в `main.js` (если нужен).
4. Строка в §3/§4 и в маршрутную таблицу.
5. Тест/проверка, обновить документацию.

### H. Добавить режим визуализации потока (мини)
1. `config/app.js`: имя в `miniVisualizerModes`.
2. `mini.js`: функция отрисовки + ветка в `draw()` и `drawIdle()`.
3. `index.html`: пункт в меню «Вид → Визуализация потока»:
   `data-command="ui:mini-mode" data-mini-mode="..."`.
4. `state.js`: ничего, если режим валидируется по `miniVisualizerModes`;
   `nav.js` синхронизирует `aria-checked` по `state.ui.miniMode`.
5. Проверить переключение на паузе и во время игры, reload (persist).

---

## 13. Подводные камни (проверять в первую очередь)

- `utils.el(tag, props, ...children)` — дети передаются **отдельными
  аргументами**, не массивом в `props`. Раньше это ломало списки.
- Обработчики событий получают payload не всегда: делай
  `const x = payload || store.state.X`.
- `store.state.favorites` — это `Set`, а не массив.
- `state.groups[].stationIds` — единственный источник membership.
- Нельзя менять `station.primary` напрямую: используй `updateStation`.
- Перерисовка списков уничтожает DOM-узлы; не сохраняй ссылки на строки
  между событиями.
- `render()` в `stations.js`/`groups.js` вызывается через rAF-коалесинг;
  в тестах после действия нужно подождать кадр.
- `audio.js` вызывает `crossOrigin` только при создании графа; не ставь его
  в `createElement` — это ломает compat-режим.
- Не включай второй `requestAnimationFrame` для визуализации.
- Не меняй `canvas.width` каждый кадр — только в `resize()`.
- `.main-nav` в мобильном режиме — `absolute` внутри `header` (у шапки
  `backdrop-filter`, `fixed` может обрезаться). Не меняй без проверки.
- `type="button"` обязателен для команд внутри форм.
- Не используй `alert/confirm/prompt`.
- Глобальный drag&drop (`ui/settings.js`) принимает только JSON (`.json` или
  `type="application/json"`): не-JSON даёт предупреждение и не открывает импорт.
  Обработчик один — не добавляй локальные `drop` на модалки, иначе двойное срабатывание.
- Строки интерфейса — по-русски; не переводить тосты/ошибки на английский.
- `localStorage` может быть недоступен — приложение работает в памяти.
- Не обещай определение VPN: это эвристика.
- Голосовой поиск не должен зависеть от внешних API: распознавание — Web Speech
  API, понимание — встроенная модель Chrome (если `LanguageModel.availability()`
  равно `"available"`) или локальный матчер `match()`. Микрофон требует
  разрешения и работает только по клику.
- Запись эфира — только локальный файл, без загрузки на сервер. Источник —
  `MR.audio.getCaptureStream()` (звук после анализатора); без CORS или в
  compat-режиме запись может быть недоступна — это штатный отказ, не «чини»
  его записью с микрофона.
- Тайм-машина держит PCM в памяти (моно 16 кГц): 3 минуты ≈ 11 МБ, максимум
  настроек — 10 минут ≈ 38 МБ. Окно берётся из `state.ui.bufferMinutes`
  (`MR.timemachine.maxSeconds()`), выключение (`ui.bufferEnabled=false`) стирает
  PCM и прячет ползунок с LIVE. Источник — `createPCMTap`, который ответвляется
  **до GainNode**; пока играет буфер, живой эфир глушится
  (`MR.audio.setBufferSilent(true)`), но продолжает играть и записываться, а
  состояние плеера остаётся «Играет». Временные статусы живого потока
  (connecting/buffering/error) не должны выбивать из буфера. Пауза данные не
  стирает: звучащий буфер встаёт на паузу, ползунок остаётся активным, Play
  продолжает с выбранного места (`seek` готовит WAV, `resume`/`playFrom`
  запускают). На паузе сэмплы не пишутся (`isPlaying === false` → early return).
  Громкость/mute буфера выставляются прямо `bufferEl.volume` (он не проходит
  через GainNode). Остановка, смена станции и выключение настройки сбрасывают
  буфер; `returnLive()` снимает глушение и останавливает буфер, PCM остаётся.
  Позиция ползунка считается как `max − Δ`, где Δ постоянна: по мере роста
  буфера он сам едет вправо. Перемотка применяется один раз — по `change`;
  `input` только помечает dragging. В compat-режиме Web Audio нет: буфер
  недоступен, ползунок скрыт, старый tap освобождается (`compatMode` в `ensureTap`/`onUiChange`).

---

## 14. Проверки

> В окружении DSH `node` и `chrome` могут быть не в `PATH`. Путь к Node берётся
> из `load_workspace_dependencies`, Chrome обычно:
> `C:\Program Files\Google\Chrome\Application\chrome.exe`.

**Синтаксис (после правок JS):**
```bash
node --check js/path/to/file.js
```

`tests/store.test.js` грузит только `core/` и `config/` с заглушками
`window`/`localStorage`/`Audio`. Стор не должен обращаться к DOM — иначе тест
перестанет запускаться без браузера.

**Логика (обязательно при изменении store/config):**
```bash
node tests/store.test.js
# ожидается: 23 passed, 0 failed
```

**Браузерный дымовой тест (Chrome DevTools Protocol):**
```bash
chrome --headless=new --no-sandbox --disable-gpu \
  --autoplay-policy=no-user-gesture-required \
  --remote-debugging-port=9223 --user-data-dir=/tmp/mr-profile about:blank
# затем:
node tests/browser-smoke.js "file:///.../index.html" "<ws-endpoint>" tests/screenshots
```
Проверяет: загрузку, меню, группу, фильтр, валидацию/добавление станции,
EQ, фон (переключатель в меню «Вид»), три режима визуализации потока
(переключение + отрисовка), пять фоновых режимов (отрисовка каждого),
режим визуализации туда/обратно,
настройки, мобильный drawer, реальный звук через WAV data-URL,
уровень анализатора, отрисовку canvas, тайм-машину (отмотка, пауза сохраняет
буфер, seek на паузе, продолжение Play, настройки буфера),
`console.error`/исключения.
Ожидается `consoleErrors: []`, `exceptions: []`, `localPlayback.state: "playing"`.

**Минимальный ручной чек-лист:**
- меню открывается/закрывается, `Esc` работает;
- вкладки переключаются, фильтр группы включает вкладку станций;
- создание группы с дубликатом имени даёт ошибку, без дубликата — карточку;
- добавление станции с `ftp://` даёт ошибку, с `https://` — строку в списке;
- play/pause меняет иконку и статус; при CORS — compat и звук;
- прогресс-бар появляется при проверке и исчезает;
- кнопка «Визуализация» скрывает панели, фон занимает экран, `Esc` возвращает всё;
- мобильная ширина 390px без горизонтального скролла.

---

## 15. Definition of Done

- [ ] Логика меняется только через `MR.store`; события публикуются.
- [ ] Нет новых `innerHTML` с пользовательскими данными.
- [ ] Нет `alert/confirm/prompt` и второго rAF/AudioContext.
- [ ] `node --check` пройден; тесты логики — 23/23.
- [ ] Для визуальных правок проверены 390px и 1440px.
- [ ] Для новой команды/модуля/поля обновлены `AI_PROMPT.md` и, при
      необходимости, `ARCHITECTURE.md`/`README.md`.
- [ ] В ответе указано, какие файлы изменены и чем проверено.

---

## 16. Приоритет источников истины

1. Код — окончательная истина.
2. `AI_PROMPT.md` — контракты, маршруты, правила (этот файл).
3. `ARCHITECTURE.md` — глубокие потоки данных и инварианты.
4. `README.md` — пользовательское поведение и запуск.

Если правка меняет архитектуру (новый модуль, команда, событие, поле состояния,
DOM-id, режим визуализации), **сразу обнови §3–§11**, чтобы следующая нейросеть
не читала код заново.
