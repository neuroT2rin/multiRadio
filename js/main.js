/**
 * main.js — точка входа. Инициализирует модули в правильном порядке
 * и освобождает ресурсы при закрытии страницы.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  let uptimeTimer = null;
  let startedAt = 0;
  let cleanedUp = false;

  function startUptime() {
    const label = dom.$("#uptime");
    if (!label) return;

    startedAt = Date.now();

    function tick() {
      label.textContent = "Время работы: " + MR.utils.formatDuration(Date.now() - startedAt);
    }

    tick();
    uptimeTimer = setInterval(tick, 1000);
  }

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;

    if (uptimeTimer) clearInterval(uptimeTimer);
    uptimeTimer = null;

    try { store.saveNow(); } catch (error) { console.warn(error); }

    MR.audio.dispose();
    MR.health.dispose();
    MR.network.dispose();
    MR.stationSearch.dispose();
    MR.stats.dispose();
    MR.recorder.dispose();
    MR.recorderUI.dispose();
    MR.recordingsUI.dispose();
    MR.timemachine.dispose();
    MR.sleepTimer.dispose();
    MR.voiceSearch.dispose();
    MR.visualizer.dispose();
    MR.infoUI.dispose();
  }

  function boot() {
    // 1. Данные и сервисы уведомлений/окон.
    store.init();

    MR.toast.init();
    MR.modal.init();
    MR.commands.init();

    // 2. Аудио и сеть.
    MR.audio.init();
    MR.network.init();
    MR.radioSearch.init();
    MR.stats.init();

    // 3. Интерфейс: сначала шина команд и разделы, затем всё остальное.
    MR.views.init();
    MR.navUI.init();
    MR.headerUI.init();
    MR.playerUI.init();
    MR.recorderUI.init();
    MR.recordingsUI.init();
    MR.timemachine.init();
    MR.timemachineUI.init();
    MR.stationsUI.init();
    MR.groupsUI.init();
    MR.eqUI.init();
    MR.stationForm.init();
    MR.stationSearch.init();
    MR.settingsUI.init();
    MR.infoUI.init();
    MR.statsUI.init();
    MR.sleepTimer.init();
    MR.voiceSearch.init();
    MR.themeUI.init();
    MR.visualizer.init();

    // 4. Обмен ссылками: модалки и команды готовы, можно читать #share=.
    MR.share.init();
    MR.share.processLocation();

    // 5. Проверка станций — последней, чтобы интерфейс уже был готов.
    MR.health.init();

    startUptime();

    global.addEventListener("beforeunload", cleanup);
    global.addEventListener("pagehide", cleanup, { once: true });

    console.info(
      "[MultiRadio] Готово. Версия " + MR.config.version +
      ", станций: " + store.state.stations.length +
      ", групп: " + store.state.groups.length
    );
  }

  dom.ready(boot);
})(window);
