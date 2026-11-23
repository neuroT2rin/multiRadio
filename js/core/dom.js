/**
 * core/dom.js — тонкие помощники для работы с DOM.
 * Не содержит бизнес-логики и не знает о радио.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;

  function $(selector, root) {
    return utils.qs(selector, root);
  }

  function $$(selector, root) {
    return utils.qsa(selector, root);
  }

  /** Подписка с возвратом функции отписки. */
  function on(target, type, handler, options) {
    if (!target) return function () {};
    target.addEventListener(type, handler, options);
    return function off() {
      target.removeEventListener(type, handler, options);
    };
  }

  /** Делегирование: обработчик получает (event, найденныйЭлемент). */
  function delegate(root, selector, type, handler) {
    if (!root) return function () {};
    const listener = function (event) {
      const target = event.target instanceof global.Element
        ? event.target.closest(selector)
        : null;
      if (target && root.contains(target)) handler(event, target);
    };
    root.addEventListener(type, listener);
    return function off() {
      root.removeEventListener(type, listener);
    };
  }

  function setText(target, text) {
    const node = typeof target === "string" ? $(target) : target;
    if (node) node.textContent = text == null ? "" : String(text);
  }

  function setHidden(target, hidden) {
    const node = typeof target === "string" ? $(target) : target;
    if (node) node.hidden = Boolean(hidden);
  }

  function toggleClass(target, className, force) {
    const node = typeof target === "string" ? $(target) : target;
    if (node) node.classList.toggle(className, force);
  }

  function focusFirst(root) {
    if (!root) return;
    const focusable = root.querySelector(
      'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable) focusable.focus();
  }

  function ready(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  MR.dom = {
    $: $,
    $$: $$,
    el: utils.el,
    on: on,
    delegate: delegate,
    setText: setText,
    setHidden: setHidden,
    toggleClass: toggleClass,
    focusFirst: focusFirst,
    ready: ready,
  };
})(window);
