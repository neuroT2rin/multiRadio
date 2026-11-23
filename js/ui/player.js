/**
 * ui/player.js — карточка плеера: информация о станции, управление, громкость.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const dom = MR.dom;
  const store = MR.store;

  let card = null;
  let playIcon = null;
  let volumeInput = null;
  let volumeValue = null;
  let muteButton = null;
  let miniHint = null;

  function renderStation() {
    const station = store.getCurrentStation();
    const playback = store.state.playback;

    dom.setText("#station-name", station ? station.name : "Выберите станцию");
    dom.setText("#station-genre", station ? station.genre : "Список станций — ниже");
    dom.setText("#player-art-emoji", station ? station.emoji : "📻");
    dom.setText("#station-bitrate-chip", station ? station.bitrate : "— kbps");

    const sourceChip = dom.$("#station-source-chip");
    if (sourceChip) {
      const label = playback.sourceLabel || "источник: —";
      sourceChip.textContent = station ? (playback.sourceLabel || "источник: —") : "источник: —";
      sourceChip.title = label;
    }

    card.classList.toggle("is-playing", Boolean(playback.isPlaying));
  }

  function renderControls() {
    const playback = store.state.playback;
    const active = playback.isPlaying || playback.status === "connecting" || playback.status === "buffering";

    if (playIcon) playIcon.textContent = active ? "⏸" : "▶";
    const button = dom.$("#play-pause-btn");
    if (button) {
      button.setAttribute("aria-label", active ? "Пауза" : "Воспроизвести");
      button.classList.toggle("is-active", Boolean(playback.isPlaying));
    }
  }

  function renderVolume() {
    const percent = Math.round(store.state.volume * 100);
    const muted = store.state.muted;

    if (volumeInput) {
      volumeInput.value = String(percent);
      volumeInput.style.setProperty("--range-progress", percent + "%");
      volumeInput.setAttribute("aria-valuetext", percent + "%");
    }
    if (volumeValue) volumeValue.textContent = percent + "%";

    if (muteButton) {
      muteButton.setAttribute("aria-pressed", String(muted));
      muteButton.setAttribute("aria-label", muted ? "Включить звук" : "Выключить звук");
      dom.setText("#mute-icon", muted || percent === 0 ? "🔇" : (percent < 45 ? "🔈" : "🔊"));
    }
  }

  function renderCompatHint() {
    if (!miniHint) return;
    if (store.state.ui.compatMode) {
      miniHint.textContent = "режим совместимости · без спектра";
    } else {
      miniHint.textContent = "визуализация потока";
    }
  }

  function init() {
    card = dom.$(".player-card");
    playIcon = dom.$("#play-pause-icon");
    volumeInput = dom.$("#volume");
    volumeValue = dom.$("#volume-value");
    muteButton = dom.$("#mute-btn");
    miniHint = dom.$("#mini-hint");
    if (!card) return;

    MR.commands.registerMany({
      "playback:toggle": function () { MR.audio.toggle(); },
      "playback:stop": function () { MR.audio.stop(); },
      "playback:next": function () { MR.audio.next(); },
      "playback:prev": function () { MR.audio.prev(); },
      "playback:mute": function () { store.toggleMute(); },
    });

    if (volumeInput) {
      volumeInput.addEventListener("input", function (event) {
        store.setVolume(Number(event.target.value) / 100);
      });
    }

    document.addEventListener("keydown", function (event) {
      if (event.code !== "Space" || event.repeat) return;

      const target = event.target;
      const tag = target && target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return;
      if (target && target.isContentEditable) return;
      if (MR.modal.hasOpen) return;

      event.preventDefault();
      MR.audio.toggle();
    });

    store.on("playback", function () {
      renderStation();
      renderControls();
    });
    store.on("stations", function () {
      renderStation();
      renderControls();
    });
    store.on("volume", renderVolume);
    store.on("ui", renderCompatHint);

    renderStation();
    renderControls();
    renderVolume();
    renderCompatHint();
  }

  MR.playerUI = {
    init: init,
    render: function () {
      renderStation();
      renderControls();
      renderVolume();
      renderCompatHint();
    },
  };
})(window);
