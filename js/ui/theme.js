/**
 * ui/theme.js — светлая и тёмная темы.
 *
 * Тема хранится в `ui.theme`, применяется атрибутом `data-theme` на <html>.
 * Переключатель — иконка в шапке; выбор сохраняется в localStorage.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  let button = null;
  let icon = null;

  function apply() {
    const theme = store.state.ui.theme;
    const isLight = theme === "light";

    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", isLight ? "#eef3f9" : "#060a14");

    if (!button) return;
    button.setAttribute("aria-pressed", String(isLight));
    button.setAttribute("aria-label", isLight ? "Включить тёмную тему" : "Включить светлую тему");
    button.title = isLight ? "Тёмная тема" : "Светлая тема";
    if (icon) icon.textContent = isLight ? "☾" : "☀";
  }

  function toggle() {
    store.setTheme(store.state.ui.theme === "light" ? "dark" : "light");
  }

  function init() {
    button = dom.$("#theme-toggle");
    icon = dom.$("#theme-icon");
    if (button) MR.commands.register("ui:theme", toggle);

    store.on("ui", apply);
    apply();
  }

  MR.themeUI = {
    init: init,
    apply: apply,
  };
})(window);
