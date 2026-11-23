/**
 * services/network.js — состояние сети и грубая проверка доступности.
 *
 * Определить VPN из браузера нельзя. Поэтому мы честно разделяем три
 * состояния: онлайн, ограниченная сеть (фильтр/файрвол/VPN) и офлайн.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const store = MR.store;

  const PROBES = [
    "https://www.gstatic.com/generate_204",
    "https://clients3.google.com/generate_204",
  ];

  let checking = false;
  let lastCheckAt = 0;
  let intervalId = null;

  function readConnection() {
    const connection = global.navigator
      ? (global.navigator.connection || global.navigator.mozConnection || global.navigator.webkitConnection)
      : null;
    return {
      effectiveType: (connection && connection.effectiveType) || "",
      downlink: connection && typeof connection.downlink === "number" ? connection.downlink : null,
    };
  }

  async function probe(url, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeout);

    try {
      // no-cors: нам достаточно факта ответа, тело и статус не нужны.
      await fetch(url, {
        mode: "no-cors",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
      });
      return true;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function check() {
    if (checking) return;
    checking = true;

    const online = global.navigator ? global.navigator.onLine !== false : true;
    const connection = readConnection();

    if (!online) {
      store.setNetwork(Object.assign({ online: false, status: "offline" }, connection));
      checking = false;
      lastCheckAt = Date.now();
      return;
    }

    store.setNetwork(Object.assign({ online: true, status: "checking" }, connection));

    const results = await Promise.all(
      PROBES.map(function (url) { return probe(url, 4000); })
    );
    const reachable = results.some(Boolean);

    store.setNetwork(Object.assign({
      online: true,
      status: reachable ? "online" : "restricted",
    }, connection));

    checking = false;
    lastCheckAt = Date.now();
  }

  function init() {
    const online = global.navigator ? global.navigator.onLine !== false : true;
    store.setNetwork(Object.assign({
      online: online,
      status: online ? "checking" : "offline",
    }, readConnection()));

    global.addEventListener("online", function () {
      store.setNetwork({ online: true, status: "checking" });
      check();
    });

    global.addEventListener("offline", function () {
      store.setNetwork({ online: false, status: "offline" });
    });

    if (global.navigator && global.navigator.connection &&
        typeof global.navigator.connection.addEventListener === "function") {
      global.navigator.connection.addEventListener("change", function () {
        store.setNetwork(readConnection());
      });
    }

    check();

    intervalId = setInterval(function () {
      if (document.visibilityState === "hidden") return;
      check();
    }, 120000);

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && Date.now() - lastCheckAt > 60000) {
        check();
      }
    });
  }

  function dispose() {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
  }

  MR.network = {
    init: init,
    check: check,
    dispose: dispose,
  };
})(window);
