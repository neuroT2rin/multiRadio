/**
 * ui/toast.js — уведомления вместо alert() и подмены статуса плеера.
 * Подписывается на событие store 'notice' и показывает аккуратные тосты.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  const ICONS = { success: "✓", error: "✕", warning: "!", info: "i" };
  const LIMIT = 4;
  let region = null;

  function dismiss(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.add("is-leaving");
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 220);
  }

  function show(message, options) {
    if (!region) return function () {};
    if (!message) return function () {};

    const opts = options || {};
    const type = ICONS[opts.type] ? opts.type : "info";
    const timeout = typeof opts.timeout === "number" ? opts.timeout : (type === "error" ? 6000 : 4200);

    const toast = dom.el("div", { class: "toast toast--" + type },
      dom.el("span", { class: "toast__icon", "aria-hidden": "true" }, ICONS[type]),
      dom.el("p", { class: "toast__text", text: message }),
      dom.el("button", {
        class: "toast__close",
        type: "button",
        "aria-label": "Закрыть уведомление",
        onClick: function () { dismiss(toast); },
      }, "✕")
    );

    region.appendChild(toast);

    while (region.children.length > LIMIT) {
      dismiss(region.firstElementChild);
    }

    let timer = null;
    if (timeout > 0) {
      timer = setTimeout(function () { dismiss(toast); }, timeout);
      toast.addEventListener("mouseenter", function () {
        if (timer) clearTimeout(timer);
      });
      toast.addEventListener("mouseleave", function () {
        timer = setTimeout(function () { dismiss(toast); }, 1600);
      });
    }

    return function () {
      if (timer) clearTimeout(timer);
      dismiss(toast);
    };
  }

  function init() {
    region = dom.$("#toast-region");

    store.on("notice", function (notice) {
      if (!notice) return;
      show(notice.message, { type: notice.level || "info" });
    });
  }

  MR.toast = {
    init: init,
    show: show,
    success: function (message, options) { return show(message, Object.assign({ type: "success" }, options)); },
    error: function (message, options) { return show(message, Object.assign({ type: "error" }, options)); },
    warning: function (message, options) { return show(message, Object.assign({ type: "warning" }, options)); },
    info: function (message, options) { return show(message, Object.assign({ type: "info" }, options)); },
  };
})(window);
