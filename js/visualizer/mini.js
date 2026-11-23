/**
 * visualizer/mini.js — компактная визуализация потока в карточке плеера.
 * Рисует плавную зеркальную волну: без вертикальных столбиков, с мягким
 * временным сглаживанием и свечением по гребню.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;

  /** Количество опорных точек волны. */
  const POINTS = 72;
  /** Сглаживание по времени: быстрый подъём, мягкий спад. */
  const ATTACK = 0.34;
  const RELEASE = 0.11;
  /** Показатель распределения частот по ширине (низы получают больше места). */
  const FREQUENCY_CURVE = 1.5;

  let canvas = null;
  let ctx = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let fillGradient = null;
  let strokeGradient = null;
  let ro = null;
  let levels = new Float32Array(POINTS);

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

    fillGradient = ctx.createLinearGradient(0, 0, 0, height);
    fillGradient.addColorStop(0, "rgba(34, 211, 238, 0.58)");
    fillGradient.addColorStop(0.5, "rgba(56, 189, 248, 0.34)");
    fillGradient.addColorStop(1, "rgba(167, 139, 250, 0.52)");

    strokeGradient = ctx.createLinearGradient(0, 0, width, 0);
    strokeGradient.addColorStop(0, "rgba(103, 232, 249, 0.95)");
    strokeGradient.addColorStop(0.5, "rgba(186, 230, 253, 0.95)");
    strokeGradient.addColorStop(1, "rgba(196, 181, 253, 0.95)");
    return true;
  }

  function smoothStep(t) {
    return t * t * (3 - 2 * t);
  }

  /** Плавная выборка спектра: косинусная интерполяция между соседними бинами. */
  function sampleSpectrum(spectrum, t) {
    if (!spectrum || !spectrum.length) return 0;
    const pos = utils.clamp(t, 0, 1) * (spectrum.length - 1);
    const index = Math.floor(pos);
    const fraction = pos - index;
    const a = spectrum[index] || 0;
    const b = spectrum[Math.min(index + 1, spectrum.length - 1)] || 0;
    return a + (b - a) * smoothStep(fraction);
  }

  function targetLevels(spectrum) {
    const targets = new Float32Array(POINTS);
    for (let i = 0; i < POINTS; i += 1) {
      const t = i / (POINTS - 1);
      // Края мягко сходятся к нулю, чтобы волна не обрывалась на границе.
      const taper = Math.pow(Math.sin(Math.PI * t), 0.45);
      const frequency = Math.pow(t, FREQUENCY_CURVE);
      const value = Math.pow(utils.clamp(sampleSpectrum(spectrum, frequency), 0, 1), 0.86);
      targets[i] = value * taper;
    }
    return targets;
  }

  /** Экспоненциальное сглаживание по времени, чтобы волна «плыла», а не дёргалась. */
  function blendLevels(targets) {
    for (let i = 0; i < POINTS; i += 1) {
      const target = targets[i];
      const previous = levels[i];
      const k = target > previous ? ATTACK : RELEASE;
      levels[i] = previous + (target - previous) * k;
    }
  }

  function buildPoints(scale) {
    const middle = height / 2;
    const top = new Array(POINTS);
    const bottom = new Array(POINTS);
    const last = POINTS - 1;

    for (let i = 0; i < POINTS; i += 1) {
      const x = (i / last) * width;
      const amplitude = Math.max(0.8, levels[i] * height * 0.46 * scale);
      top[i] = { x: x, y: middle - amplitude };
      bottom[i] = { x: x, y: middle + amplitude };
    }

    return { top: top, bottom: bottom };
  }

  /** Сглаженная кривая Catmull-Rom, добавленная к текущему пути. */
  function appendSmooth(points) {
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;

      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6,
        p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6,
        p2.y - (p3.y - p1.y) / 6,
        p2.x,
        p2.y
      );
    }
  }

  function drawBaseline() {
    const middle = height / 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, middle + 0.5);
    ctx.lineTo(width, middle + 0.5);
    ctx.stroke();
  }

  function render(opacity) {
    if (!ctx || !fillGradient || width === 0) return;

    const points = buildPoints(1);
    const middle = height / 2;
    const reversedBottom = points.bottom.slice().reverse();

    // Зеркальная «лента»: верхний гребень, правый край, нижний гребень.
    ctx.beginPath();
    ctx.moveTo(points.top[0].x, points.top[0].y);
    appendSmooth(points.top);
    ctx.lineTo(width, middle);
    ctx.lineTo(reversedBottom[0].x, reversedBottom[0].y);
    appendSmooth(reversedBottom);
    ctx.lineTo(0, middle);
    ctx.closePath();

    ctx.globalAlpha = opacity;
    ctx.fillStyle = fillGradient;
    ctx.fill();

    // Светящийся гребень волны.
    ctx.beginPath();
    ctx.moveTo(points.top[0].x, points.top[0].y);
    appendSmooth(points.top);
    ctx.strokeStyle = strokeGradient;
    ctx.lineWidth = 1.3;
    ctx.shadowBlur = 10;
    ctx.shadowColor = "rgba(56, 189, 248, 0.55)";
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    drawBaseline();
  }

  function drawIdle() {
    if (!ctx || width === 0) return;
    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < POINTS; i += 1) {
      const t = i / (POINTS - 1);
      const ripple = 0.028 + 0.022 * Math.sin(t * Math.PI * 3.1);
      levels[i] = ripple * Math.pow(Math.sin(Math.PI * t), 0.45);
    }

    render(0.6);
  }

  function draw(analysis) {
    if (!canvas) return;
    measure();
    if (!ctx || !fillGradient) return;

    ctx.clearRect(0, 0, width, height);

    const spectrum = analysis && analysis.spectrum ? analysis.spectrum : null;
    const active = Boolean(analysis && analysis.active && spectrum);

    if (!active) {
      drawIdle();
      return;
    }

    blendLevels(targetLevels(spectrum));
    render(1);
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
