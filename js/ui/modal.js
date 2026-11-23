/**
 * ui/modal.js — единый менеджер модальных окон.
 *
 * Умеет: открытие/закрытие, Escape, клик по подложке, focus trap,
 * возврат фокуса, подтверждение действия через Promise.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;

  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const openStack = [];
  let pendingConfirm = null;

  function toElement(target) {
    return typeof target === "string" ? dom.$(target) : target;
  }

  function getFocusable(modal) {
    return dom.$$(FOCUSABLE, modal).filter(function (node) {
      return node.getClientRects().length > 0;
    });
  }

  function isOpen(target) {
    const modal = toElement(target);
    return Boolean(modal && openStack.indexOf(modal) !== -1);
  }

  function open(target, options) {
    const modal = toElement(target);
    if (!modal || isOpen(modal)) return;

    const opts = options || {};
    const previouslyFocused = document.activeElement;

    modal.hidden = false;
    modal.classList.add("is-open");
    document.body.classList.add("modal-open");
    openStack.push(modal);

    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(modal, { reason: "escape" });
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusable(modal);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function onBackdrop(event) {
      const trigger = event.target.closest("[data-close-modal]");
      if (trigger && modal.contains(trigger)) {
        close(modal, { reason: "backdrop" });
      }
    }

    modal.__closeHandler = function (reason) {
      document.removeEventListener("keydown", onKeydown, true);
      modal.removeEventListener("click", onBackdrop);
      modal.classList.remove("is-open");
      modal.hidden = true;
      document.body.classList.remove("modal-open");

      const index = openStack.indexOf(modal);
      if (index !== -1) openStack.splice(index, 1);

      if (typeof opts.onClose === "function") {
        try { opts.onClose(reason); } catch (error) { console.error(error); }
      }

      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        try { previouslyFocused.focus({ preventScroll: true }); } catch (error) { /* noop */ }
      }
    };

    document.addEventListener("keydown", onKeydown, true);
    modal.addEventListener("click", onBackdrop);

    const initial = opts.initialFocus
      ? (typeof opts.initialFocus === "string" ? dom.$(opts.initialFocus, modal) : opts.initialFocus)
      : getFocusable(modal)[0];

    requestAnimationFrame(function () {
      if (initial && typeof initial.focus === "function") {
        try { initial.focus({ preventScroll: true }); } catch (error) { /* noop */ }
      }
    });
  }

  function close(target, options) {
    const modal = toElement(target);
    if (!modal || !isOpen(modal)) return;
    const reason = (options && options.reason) || "manual";
    const handler = modal.__closeHandler;
    modal.__closeHandler = null;
    if (handler) handler(reason);
  }

  function closeAll() {
    openStack.slice().reverse().forEach(function (modal) { close(modal); });
  }

  /**
   * Модальное подтверждение.
   * @returns {Promise<boolean>}
   */
  function confirm(options) {
    const opts = options || {};
    const modal = dom.$("#modal-confirm");
    if (!modal) return Promise.resolve(false);

    if (pendingConfirm) {
      pendingConfirm(false);
      pendingConfirm = null;
    }

    return new Promise(function (resolve) {
      dom.setText("#confirm-title", opts.title || "Подтвердите действие");
      dom.setText("#confirm-message", opts.message || "");

      const okButton = dom.$("#confirm-ok");
      const cancelButton = dom.$("#confirm-cancel");

      okButton.textContent = opts.confirmLabel || "Подтвердить";
      cancelButton.textContent = opts.cancelLabel || "Отмена";
      okButton.className = "btn " + (opts.danger === false ? "btn-primary" : "btn-danger");

      let settled = false;

      function settle(value) {
        if (settled) return;
        settled = true;
        pendingConfirm = null;
        offOk();
        offCancel();
        close(modal);
        resolve(value);
      }

      const offOk = dom.on(okButton, "click", function () { settle(true); });
      const offCancel = dom.on(cancelButton, "click", function () { settle(false); });

      pendingConfirm = settle;
      open(modal, {
        initialFocus: cancelButton,
        onClose: function () { settle(false); },
      });
    });
  }

  function init() {
    document.addEventListener("click", function (event) {
      const trigger = event.target.closest("[data-close-modal]");
      if (!trigger) return;
      const modal = trigger.closest(".modal");
      if (modal) close(modal, { reason: "button" });
    });
  }

  MR.modal = {
    init: init,
    open: open,
    close: close,
    closeAll: closeAll,
    confirm: confirm,
    isOpen: isOpen,
    get hasOpen() { return openStack.length > 0; },
  };
})(window);
