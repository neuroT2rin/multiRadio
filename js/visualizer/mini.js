/**
 * visualizer/mini.js — компактный спектр в карточке плеера.
 * Рисует зеркальные полосы и тихую осциллограмму.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;

  const BAR_COUNT = 48;
  let canvas = null;
  let ctx = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let gradient = null;
  let ro = null;

  function measure() {
    if (!canvas || !canvas.parentElement) return false;
    const rect = canvas.parentElement.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    const nextDpr = Math.min(global.devicePixelRatio || 1, 2);

    if (nextWidth === width && nextHeight === height && nextDpr === dpr) return false;

    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "#22d3ee");
    gradient.addColorStop(0.45, "#38bdf8");
    gradient.addColorStop(1, "#a78bfa");
    return true;
  }

  function roundedBar(x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }

  function drawIdle() {
    if (!ctx || width === 0) return;
    ctx.clearRect(0, 0, width, height);
    const middle = height / 2;
    const step = width / BAR_COUNT;

    ctx.fillStyle = "rgba(56, 189, 248, 0.10)";
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const value = 0.08 + 0.05 * Math.sin(i * 0.55);
      const barHeight = Math.max(1.2, value * height);
      roundedBar(i * step + 1, middle - barHeight / 2, Math.max(1, step - 2), barHeight, 2);
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, middle + 0.5);
    ctx.lineTo(width, middle + 0.5);
    ctx.stroke();
  }

  function draw(analysis) {
    if (!canvas) return;
    if (measure()) {
      // После изменения размера рисуем в новом масштабе.
    }
    if (!ctx || !gradient) return;

    ctx.clearRect(0, 0, width, height);

    const middle = height / 2;
    const spectrum = analysis && analysis.spectrum ? analysis.spectrum : null;
    const active = Boolean(analysis && analysis.active && spectrum);
    const step = width / BAR_COUNT;

    if (!active) {
      drawIdle();
      return;
    }

    ctx.fillStyle = gradient;
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const sourceIndex = Math.min(
        spectrum.length - 1,
        Math.floor((i / BAR_COUNT) * spectrum.length)
      );
      const value = Math.pow(utils.clamp(spectrum[sourceIndex], 0, 1), 0.92);
      const barHeight = Math.max(1.4, value * height * 0.46);

      ctx.globalAlpha = 0.32 + value * 0.68;
      roundedBar(
        i * step + 1,
        middle - barHeight,
        Math.max(1, step - 2),
        barHeight * 2,
        Math.max(1, Math.min(3, step / 3))
      );
    }
    ctx.globalAlpha = 1;

    // Осциллограмма поверх полос.
    const wave = analysis.wave;
    if (wave && wave.length > 0) {
      const points = 120;
      const amplitude = height * 0.32 * (0.35 + utils.clamp(analysis.level, 0, 1));
      ctx.beginPath();
      for (let i = 0; i <= points; i += 1) {
        const index = Math.floor((i / points) * (wave.length - 1));
        const value = (wave[index] - 128) / 128;
        const x = (i / points) * width;
        const y = middle + value * amplitude;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, middle + 0.5);
    ctx.lineTo(width, middle + 0.5);
    ctx.stroke();
  }

  function init() {
    canvas = document.getElementById("mini-canvas");
    if (!canvas) return;

    ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    measure();
    drawIdle();

    if (typeof ResizeObserver === "function" && canvas.parentElement) {
      ro = new ResizeObserver(function () {
        if (measure()) drawIdle();
      });
      ro.observe(canvas.parentElement);
    } else {
      global.addEventListener("resize", utils.debounce(function () {
        if (measure()) drawIdle();
      }, 150));
    }
  }

  function dispose() {
    if (ro) ro.disconnect();
    ro = null;
  }

  MR.mini = {
    init: init,
    draw: draw,
    drawIdle: drawIdle,
    resize: measure,
    dispose: dispose,
  };
})(window);
