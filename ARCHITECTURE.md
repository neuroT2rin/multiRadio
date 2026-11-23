# Архитектура MultiRadio

> **Агентам и нейросетям:** сначала [AI_PROMPT.md](AI_PROMPT.md) — там
> контракты, API и маршруты «задача → файлы». Этот документ — глубокое
> описание потоков данных и инвариантов, к нему обращаются только при
> изменении архитектуры.

Документ для людей и нейросетей: где что лежит, кто за что отвечает,
как модули общаются и куда добавлять новое.

## Принципы

1. **Один файл — одна ответственность.** Никаких «God object» на 1500 строк.
2. **DOM только в `ui/` и `visualizer/`.** `core/` и `services/` не знают о разметке
   (кроме `dom.js`, который сам является её тонкой обёрткой).
3. **Единый источник истины — `MR.store`.** UI не меняет состояние напрямую,
   а вызывает действие; стор публикует событие; подписчики перерисовываются.
4. **Действия через команды.** Любая кнопка с `data-command="..."` вызывает
   обработчик из `ui/commands.js`. Один обработчик — много точек входа (меню,
   карточка, горячие клавиши).
5. **Классические скрипты, без сборки.** Проект открывается двойным кликом по
   `index.html`; ES-модули на `file://` заблокированы CORS. Каждый файл — IIFE,
   который дописывает себя в глобальный namespace `window.MR`.

## Порядок загрузки

```
utils → config/app → config/stations → config/equalizer → storage → state → dom
      → analyser → audio → network → health
      → toast → modal → commands → views → nav → header → player → stations
      → groups → equalizer → station-form → settings → info
      → visualizer/mini → visualizer/background → visualizer/index → main
```

Порядок важен только для кода, исполняемого при загрузке. Все обращения к другим
модулям внутри функций безопасны: `main.js` вызывает `init()` после загрузки всех файлов.

## Карта модулей

| Файл | Ответственность |
|---|---|
| `js/core/utils.js` | Чистые функции: DOM-хелпер `el()`, `clamp`, `slugify`, `isHttpUrl`, `parseUrlList`, форматирование, `debounce`. |
| `js/core/storage.js` | Безопасная обёртка `localStorage` с fallback в память. |
| `js/core/state.js` | Стор: состояние, селекторы, действия, события, нормализация, persist, импорт/экспорт, миграция v1. |
| `js/core/dom.js` | `$`, `$$`, `on`, `delegate`, `setText`, `setHidden`, `ready`, `focusFirst`. |
| `js/config/app.js` | Версия, ключ хранилища, интервалы, лимиты, подписи статусов. |
| `js/config/stations.js` | 8 стартовых станций с проверенными потоками и резервами. |
| `js/config/equalizer.js` | 10 полос, 7 пресетов, поиск пресета по усилениям. |
| `js/services/analyser.js` | Один `AnalyserNode` на всё приложение: спектр (64 полосы), энергии EQ (10), RMS, бас/середина/верх, бит. |
| `js/services/audio.js` | `<audio>` + цепочка Web Audio, перебор источников, таймаут подключения, режим совместимости, громкость, EQ. |
| `js/services/network.js` | `online/offline`, `navigator.connection`, проверка контрольных хостов (онлайн / ограничена / офлайн). |
| `js/services/health.js` | Проверка каждого URL через `Audio(preload=metadata)`, пул на 6, прогресс и результаты в стор. |
| `js/ui/commands.js` | Шина `data-command` → обработчик; регистрация команд модулями. |
| `js/ui/toast.js` | Уведомления; подписан на `store.on('notice')`. |
| `js/ui/modal.js` | Открытие/закрытие, Escape, backdrop, focus trap, `confirm()` через Promise. |
| `js/ui/views.js` | Вкладки «Станции / Избранные / Эквалайзер», `aria-selected`, клавиши ←/→. |
| `js/ui/nav.js` | Выпадающие меню, клавиатура, мобильный drawer, синхронизация галочек. |
| `js/ui/header.js` | Бейджи сети/плеера, полоса прогресса проверки, `document.title`. |
| `js/ui/player.js` | Карточка «сейчас играет», управление, громкость, `Space`. |
| `js/ui/stations.js` | Списки станций и избранного, поиск, фильтры, точки здоровья, empty states. |
| `js/ui/groups.js` | CRUD групп, модальное окно, чекбоксы станций, фильтр группы. |
| `js/ui/equalizer.js` | Ползунки, пресеты, индикаторы; `tick(analysis)` вызывает визуализатор. |
| `js/ui/station-form.js` | Добавление/редактирование/удаление станции с валидацией. |
| `js/ui/settings.js` | Настройки вида, режим совместимости, экспорт/импорт/сброс. |
| `js/ui/info.js` | Карточка «Источники и сеть», ручная проверка, относительное время. |
| `js/visualizer/mini.js` | Мини-спектр в плеере: зеркальные полосы + осциллограмма, DPR, ResizeObserver. |
| `js/visualizer/background.js` | Полноэкранный canvas: режимы `spectrum`, `aurora`, `orbit`; частицы, звёзды, шлейфы. |
| `js/visualizer/index.js` | Единственный `requestAnimationFrame`; читает анализатор один раз за кадр и раздаёт данные. |
| `js/main.js` | Инициализация в правильном порядке, uptime, очистка при `pagehide`. |

## Модель состояния

```js
state = {
  stations: [{ id, name, genre, bitrate, emoji, primary, fallbacks: [] }],
  favorites: Set<string>,
  groups: [{ id, name, stationIds: string[] }],   // станция максимум в одной группе
  filters: { favoritesOnly, groupId, query },
  view: 'stations' | 'favorites' | 'equalizer',
  playback: { status, stationId, urlIndex, url, sourceLabel, isPlaying, error },
  volume: 0..1,
  muted: bool,
  eqGains: number[10],
  eqPreset: 'flat' | ... | 'custom',
  health: { [stationId]: { primary: Probe, fallbacks: Probe[], checkedAt } },
  healthProgress: { running, done, total, stationsDone, stationsTotal, startedAt, finishedAt },
  network: { online, status, effectiveType, downlink },
  ui: { bgEnabled, mode, compatMode }
}
```

`Probe = { ok: boolean, reason: string|null }`.

### Инварианты

- `id` станции — `[a-z0-9-]`, уникален; генерируется из названия с транслитерацией.
- Имена станций и групп уникальны без учёта регистра.
- `stationIds` группы ссылаются только на существующие станции; дубликат
  membership невозможен — `addGroup`/`updateGroup`/`assignStationToGroup`
  вычищают станцию из остальных групп.
- `favorites` содержит только существующие `id`; при удалении станции чистится.
- `primary` и `fallbacks` — только абсолютные `http(s)` URL, без дублей, ≤5 резервов.
- При удалении текущей станции `playback` сбрасывается в `idle`, звук останавливается.

## События стора

| Событие | Когда | Кто слушает |
|---|---|---|
| `stations` | добавление/удаление/редактирование, смена избранного | списки, плеер, шапка, звук |
| `favorites` | ★ | списки |
| `groups` | CRUD групп, membership | группы, станции, фильтр |
| `filters` | поиск/фильтры | станции |
| `view` | смена вкладки | views, nav, EQ |
| `playback` | статус и источник | плеер, шапка, звук, визуализатор |
| `volume` | громкость/mute | звук, плеер |
| `eq` | ползунки/пресет | звук, EQ UI |
| `health` | результат проверки станции | станции, информация |
| `health:progress` | старт/шаг/финиш проверки | шапка, информация |
| `network` | онлайн/ограничена/офлайн | шапка, информация |
| `ui` | фон, режим, совместимость | визуализатор, настройки, EQ |
| `notice` | сообщение для тоста | toast |

Подписка: `const off = MR.store.on('view', handler)`.
Стор также отдаёт `emit` для сервисных событий (`notice`).

## Команды

| Команда | Действие |
|---|---|
| `view:stations/favorites/equalizer` | смена вкладки |
| `station:add`, `station:edit` | модальное окно станции |
| `station:play`, `station:favorite` | воспроизведение, ★ |
| `group:create/edit/delete/filter/clear-filter/remove-station` | группы |
| `playback:toggle/stop/next/prev/mute` | плеер |
| `health:check` | ручная проверка |
| `settings:open/export/import/reset/restore-stations` | настройки |
| `ui:toggle-bg`, `ui:mode` | визуализация |
| `eq:reset` | сброс эквалайзера |

Добавление команды: `MR.commands.register('my:action', handler)` в `init()` модуля.

## Потоки данных

### Запуск станции

1. `station:play` → `MR.audio.playStation(id)`.
2. Аудио-движок берёт URL из стора, ставит `playback.status='connecting'`,
   создаёт (один раз) `AudioContext` и граф `source → gain → EQ×10 → analyser → destination`.
3. `<audio crossOrigin="anonymous">` грузит поток.
4. `playing` → `status='playing'`; `analyser` отдаёт данные визуализатору.
5. Ошибка/таймаут 12 с → следующий URL. Все URL не удались → включается
   режим совместимости и повтор с первого адреса; если и там ошибка — `status='error'`.

### Проверка станций

1. `MR.health.run()` собирает по одному probe на каждый URL.
2. Пул на 6 воркеров запускает `Audio(preload=metadata)` без `crossOrigin`.
3. После каждого probe: `health:progress` (полоса в шапке), по завершении станции —
   `health` (точка у станции).
4. Финиш: `health:progress` с `running:false`, сводка на 1,5 с, затем полоса скрывается.
5. Автозапуск: через 0,7 с после старта и далее каждые 90 с (только на видимой вкладке).

### Создание группы

1. `group:create` → модальное окно, чекбоксы всех станций.
2. Submit → `store.addGroup({name, stationIds})`.
3. Валидация имени (не пусто, ≤40, уникально без регистра).
4. Станции вычищаются из прежних групп и попадают в новую.
5. События `groups` + `stations` → перерисовка карточек и списков, тост.

## Добавление нового кода

**Новая станция по умолчанию** — `js/config/stations.js`.
**Новый пресет EQ** — `js/config/equalizer.js`.
**Новый режим визуализации**:
1. добавьте имя в `config.visualizerModes`;
2. нарисуйте ветку в `background.js::draw`;
3. добавьте кнопку `data-command="ui:mode" data-mode="..."` в HTML
   (блок «Визуализация» и меню «Вид»).
**Новый раздел**: вкладка в HTML (`data-command="view:x"`, панель `panel-x`) →
значение в `config.views` → обработчик в `views.js` → команда в `commands`.
**Новое действие**: кнопка `type="button" data-command="domain:action"` →
`MR.commands.register` в `init()` профильного модуля. Не дублируйте обработчики
в разных местах: одна команда — сколько угодно кнопок.

## Тесты

- `tests/store.test.js` — логика без DOM: валидация, группы, фильтры,
  сохранение, миграция, сброс (20 проверок).
- `tests/browser-smoke.js` — реальный Chromium через CDP: загрузка, меню,
  создание группы, фильтр, валидация/добавление станции, эквалайзер, настройки,
  мобильный drawer, сбор `console.error` и исключений, скриншоты.

## Ограничения

- Один `AudioContext` и один `MediaElementAudioSourceNode` на страницу; при
  включении режима совместимости элемент пересоздаётся, потому что отменить
  `createMediaElementSource` нельзя.
- CORS-политика браузера не позволяет ни обойти ограничение, ни точно
  определить причину ошибки media (код 4). Поэтому используется эвристика:
  все URL не загрузились → пробуем режим совместимости.
- VPN не определяется из браузера: статус «Сеть: ограничена» — только эвристика.
