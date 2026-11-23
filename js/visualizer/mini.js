/**
 * visualizer/mini.js — компактная визуализация потока в карточке плеера.
 *
 * Три режима (меню «Вид → Визуализация потока»):
 *  • wave    — зеркальная плавная волна со светящимся гребнем;
 *  • ribbon  — несколько световых лент, которые плывут по полосе;
 *  • sparkle — искры, вылетающие из светящегося основания под музыку.
 *
 * Данные анализатора приходят из единственного rAF-цикла
 * `visualizer/index.js`; собственного цикла отрисовки здесь нет.
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;

  const FALLBACK_MODES = ["wave", "ribbon", "sparkle"];
  /** Количество опорных точек волны. */
  const POINTS = 72;
  /** Сглаживание по времени: быстрый подъём, мягкий спад. */
  const ATTACK = 0.34;
  const RELEASE = 0.11;
  /** Показатель распределения частот по ширине (низы получают больше места). */
  const FREQUENCY_CURVE = 1.5;
  const RIBBON_LAYERS = 4;
  const SPARK_LIMIT = 90;
  const SPARK_HUES = [188, 205, 262, 300];

  let canvas = null;
  let ctx = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let fillGradient = null;
  let strokeGradient = null;
  let ribbonGradient = null;
  let ro = null;
  let levels = new Float32Array(POINTS);
  let sparks = [];
  let lastFrameAt = 0;
  let mode = "wave";

  function modeList() {
    return (MR.config && MR.config.miniVisualizerModes) || FALLBACK_MODES;
  }

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

    ribbonGradient = ctx.createLinearGradient(0, 0, width, 0);
    ribbonGradient.addColorStop(0, "rgba(103, 232, 249, 0.95)");
    ribbonGradient.addColorStop(0.38, "rgba(56, 189, 248, 0.95)");
    ribbonGradient.addColorStop(0.72, "rgba(167, 139, 250, 0.95)");
    ribbonGradient.addColorStop(1, "rgba(244, 114, 182, 0.9)");
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

  function buildPoints() {
    const middle = height / 2;
    const top = new Array(POINTS);
    const bottom = new Array(POINTS);
    const last = POINTS - 1;

    for (let i = 0; i < POINTS; i += 1) {
      const x = (i / last) * width;
      const amplitude = Math.max(0.8, levels[i] * height * 0.46);
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

  /* ------------------------------------------------------------------------
     Волна
     ------------------------------------------------------------------------ */

  function renderWave(opacity) {
    if (!ctx || !fillGradient || width === 0) return;

    const points = buildPoints();
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

  function drawIdleWave() {
    for (let i = 0; i < POINTS; i += 1) {
      const t = i / (POINTS - 1);
      const ripple = 0.028 + 0.022 * Math.sin(t * Math.PI * 3.1);
      levels[i] = ripple * Math.pow(Math.sin(Math.PI * t), 0.45);
    }
    renderWave(0.6);
  }

  /* ------------------------------------------------------------------------
     Ленты
     ------------------------------------------------------------------------ */

  function ribbonValue(spectrum, t, layer) {
    if (!spectrum) {
      return 0.06 + 0.045 * Math.sin(t * 8.5 + layer * 1.7);
    }
    const sample = sampleSpectrum(spectrum, Math.pow(t, 1.15 + layer * 0.22));
    return Math.pow(utils.clamp(sample, 0, 1), 0.9);
  }

  function drawRibbons(analysis, idle) {
    const spectrum = !idle && analysis && analysis.spectrum && analysis.active
      ? analysis.spectrum
      : null;
    const now = performance.now();
    const level = idle ? 0 : utils.clamp(analysis.level, 0, 1);
    const bass = idle ? 0 : utils.clamp(analysis.bass, 0, 1);
    const treble = idle ? 0 : utils.clamp(analysis.treble, 0, 1);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";

    for (let layer = 0; layer < RIBBON_LAYERS; layer += 1) {
      const baseY = height * (0.24 + layer * 0.155);
      const amplitude = height * (0.3 - layer * 0.035);
      const phase = now * (0.0008 + layer * 0.00035) + layer * 1.6;
      const points = new Array(POINTS);

      for (let i = 0; i < POINTS; i += 1) {
        const t = i / (POINTS - 1);
        const value = ribbonValue(spectrum, t, layer);
        const taper = Math.pow(Math.sin(Math.PI * t), 0.32);
        const drift = Math.sin(t * Math.PI * 2 + phase) * height * 0.035;
        const tremble = Math.sin(t * 17 + now * 0.004 + layer) *
          height * 0.006 * (0.4 + treble);
        const throb = bass * height * 0.02 * Math.sin(layer * 1.3);

        points[i] = {
          x: t * width,
          y: baseY - value * amplitude * taper + drift + tremble + throb,
        };
      }

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      appendSmooth(points);
      ctx.globalAlpha = utils.clamp(0.42 + level * 0.38 - layer * 0.06, 0.18, 0.9);
      ctx.strokeStyle = ribbonGradient;
      ctx.lineWidth = 1.1 + layer * 0.55 + bass * 1.4;
      ctx.shadowBlur = 12;
      ctx.shadowColor = "rgba(56, 189, 248, 0.45)";
      ctx.stroke();
    }

    ctx.restore();

    // Мягкая линия горизонта под лентами.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();
  }

  /* ------------------------------------------------------------------------
     Искры
     ------------------------------------------------------------------------ */

  function spawnSparks(count, level) {
    for (let i = 0; i < count && sparks.length < SPARK_LIMIT; i += 1) {
      sparks.push({
        x: Math.random(),
        y: 0.82 + Math.random() * 0.16,
        vx: (Math.random() - 0.5) * 0.1,
        vy: -(0.35 + Math.random() * 0.7) * (0.6 + level),
        gravity: 0.4 + Math.random() * 0.5,
        life: 1,
        decay: 1.1 + Math.random() * 1.3,
        size: 0.6 + Math.random() * 1.7,
        hue: SPARK_HUES[Math.floor(Math.random() * SPARK_HUES.length)],
      });
    }
  }

  /** Заполняет полосу искрами сразу, чтобы режим не выглядел пустым в первую секунду. */
  function seedSparks(count, level) {
    for (let i = 0; i < count && sparks.length < SPARK_LIMIT; i += 1) {
      sparks.push({
        x: Math.random(),
        y: 0.12 + Math.random() * 0.82,
        vx: (Math.random() - 0.5) * 0.08,
        vy: -(0.08 + Math.random() * 0.4),
        gravity: 0.3,
        life: 0.2 + Math.random() * 0.8,
        decay: 0.5 + Math.random() * 0.9,
        size: 0.6 + Math.random() * 1.6,
        hue: SPARK_HUES[Math.floor(Math.random() * SPARK_HUES.length)],
      });
    }
  }

  function stepSparks(dt, level, bass) {
    const perSecond = 14 + level * 95 + bass * 55;
    const count = Math.min(4, Math.round(perSecond * dt));
    spawnSparks(count, level);

    for (let i = sparks.length - 1; i >= 0; i -= 1) {
      const spark = sparks[i];
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      spark.vy += spark.gravity * dt;
      spark.life -= spark.decay * dt;

      if (spark.life <= 0 || spark.y < -0.1 || spark.x < -0.1 || spark.x > 1.1) {
        sparks.splice(i, 1);
      }
    }
  }

  function drawSparkleFloor(level, bass) {
    const floor = ctx.createLinearGradient(0, height, 0, height * 0.15);
    floor.addColorStop(0, "rgba(34, 211, 238, " + (0.16 + level * 0.28) + ")");
    floor.addColorStop(0.55, "rgba(56, 189, 248, " + (0.05 + bass * 0.14) + ")");
    floor.addColorStop(1, "rgba(56, 189, 248, 0)");
    ctx.fillStyle = floor;
    ctx.fillRect(0, height * 0.15, width, height * 0.85);

    ctx.strokeStyle = "rgba(103, 232, 249, " + (0.12 + level * 0.4) + ")";
    ctx.lineWidth = 1 + level * 1.3;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();
  }

  function drawSparkParticles() {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    sparks.forEach(function (spark) {
      const x = spark.x * width;
      const y = spark.y * height;
      const life = Math.max(0, spark.life);
      const radius = spark.size * (0.5 + life * 0.9);

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + spark.hue + ", 95%, 72%, " + (life * 0.9) + ")";
      ctx.fill();

      // Короткий шлейф по направлению движения.
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - spark.vx * width * 0.05, y - spark.vy * height * 0.09);
      ctx.strokeStyle = "hsla(" + spark.hue + ", 95%, 70%, " + (life * 0.32) + ")";
      ctx.lineWidth = Math.max(0.4, radius * 0.7);
      ctx.stroke();
    });

    ctx.restore();
  }

  function drawIdleSparkles() {
    drawSparkleFloor(0, 0);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 18; i += 1) {
      const x = ((i + 0.5) / 18) * width;
      const y = height * (0.55 + 0.3 * Math.sin(i * 2.4));
      ctx.beginPath();
      ctx.arc(x, y, 0.8 + (i % 3) * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + SPARK_HUES[i % SPARK_HUES.length] + ", 90%, 72%, 0.16)";
      ctx.fill();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------------
     Публичный API
     ------------------------------------------------------------------------ */

  function drawIdle() {
    if (!ctx || width === 0) return;
    ctx.clearRect(0, 0, width, height);
    sparks = [];
    lastFrameAt = 0;

    if (mode === "ribbon") {
      drawRibbons(null, true);
      return;
    }

    if (mode === "sparkle") {
      drawIdleSparkles();
      return;
    }

    drawIdleWave();
  }

  function draw(analysis) {
    if (!canvas) return;
    measure();
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const spectrum = analysis && analysis.spectrum ? analysis.spectrum : null;
    const active = Boolean(analysis && analysis.active && spectrum);

    if (!active) {
      drawIdle();
      return;
    }

    if (mode === "ribbon") {
      drawRibbons(analysis, false);
      return;
    }

    if (mode === "sparkle") {
      const nowMs = performance.now();
      let dt = lastFrameAt ? (nowMs - lastFrameAt) / 1000 : 0.016;
      lastFrameAt = nowMs;
      dt = Math.min(dt, 0.06);

      const level = utils.clamp(analysis.level, 0, 1);
      const bass = utils.clamp(analysis.bass, 0, 1);
      if (!sparks.length) seedSparks(30, level);
      stepSparks(dt, level, bass);
      drawSparkleFloor(level, bass);
      drawSparkParticles();
      return;
    }

    blendLevels(targetLevels(spectrum));
    renderWave(1);
  }

  function setMode(next) {
    if (modeList().indexOf(next) === -1) return mode;
    if (next === mode) return mode;

    mode = next;
    sparks = [];
    lastFrameAt = 0;
    levels.fill(0);

    if (ctx) drawIdle();
    return mode;
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
    setMode: setMode,
    resize: measure,
    dispose: dispose,
    get mode() { return mode; },
  };
})(window);
