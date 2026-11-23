/**
 * ui/commands.js — единая шина действий.
 *
 * Любой элемент с data-command="group:create" вызывает обработчик,
 * зарегистрированный соответствующим модулем. Это убирает дублирование
 * обработчиков между меню, карточками и модальными окнами.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const handlers = new Map();

  function register(name, handler) {
    if (!name || typeof handler !== "function") return;
    handlers.set(name, handler);
  }

  function registerMany(map) {
    Object.keys(map || {}).forEach(function (name) { register(name, map[name]); });
  }

  function run(name, payload) {
    const handler = handlers.get(name);
    if (!handler) {
      console.warn("[MultiRadio] Неизвестная команда:", name);
      return false;
    }
    try {
      handler(payload || {});
      return true;
    } catch (error) {
      console.error("[MultiRadio] Ошибка команды «" + name + "»:", error);
      return false;
    }
  }

  function init() {
    document.addEventListener("click", function (event) {
      const source = event.target instanceof global.Element
        ? event.target.closest("[data-command]")
        : null;
      if (!source || source.disabled) return;

      // Кнопки внутри форм не должны отправлять форму.
      if (source.tagName === "BUTTON" && source.type !== "button") return;

      event.preventDefault();
      run(source.dataset.command, {
        source: source,
        dataset: source.dataset,
        event: event,
      });
    });
  }

  MR.commands = {
    init: init,
    register: register,
    registerMany: registerMany,
    run: run,
    has: function (name) { return handlers.has(name); },
  };
})(window);
