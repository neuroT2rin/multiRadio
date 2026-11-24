/**
 * visualizer/background.js — полноэкранная визуализация.
 *
 * Три режима:
 *  • spectrum — круговой спектр с ядром, кольцами и частицами;
 *  • aurora   — слоистые волны, реагирующие на бас;
 *  • orbit    — орбиты со шлейфами и звёздами.
 *
 * Canvas масштабируется под devicePixelRatio, размеры пересчитываются
 * только при реальном изменении окна (а не каждый кадр, как раньше).
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;

  const MODES = ["spectrum", "aurora", "orbit", "tunnel", "spiral", "voice"];
  const PARTICLE_COUNT = 64;
  const STAR_COUNT = 90;

  /** Палитры «Туннеля»: музыка меняет цвет и скорость их переключения. */
  const TUNNEL_PALETTES = [
    [186, 198, 210, 224, 258],
    [262, 280, 296, 312, 332],
    [12, 30, 348, 316, 288],
    [150, 164, 178, 194, 208],
    [36, 46, 26, 318, 288],
  ];
  const TUNNEL_RINGS = 28;
  const TUNNEL_SEGMENTS = 48;
  const TUNNEL_RIBS = 16;
  const TUNNEL_SPACING = 100;
  const TUNNEL_NEAR = 90;
  const TUNNEL_FOCAL = 780;
  const TUNNEL_RADIUS = 132;
  /** Шаг точек кольца на одно продольное ребро (48 / 16 = 3). */
  const TUNNEL_RIB_STRIDE = TUNNEL_SEGMENTS / TUNNEL_RIBS;
  /** Диагональ холста 1440×900 — эталон, от которого труба масштабируется под экран. */
  const TUNNEL_REF_DIAGONAL = 1700;
  /** Запас bbox: толщина линии и свечение вокруг уже посчитанных точек. */
  const TUNNEL_CULL_MARGIN = 72;
  /** Скорость камеры на единицу сглаженного множителя, px/с. */
  const TUNNEL_BASE_SPEED = 160;
  const TUNNEL_SPEED_MIN = 0.2;
  const TUNNEL_SPEED_MAX = 2.4;

  /** «Голос»: число точек осциллограммы и оттенки трёх формантных полос. */
  const VOICE_POINTS = 128;
  const VOICE_HUES = [176, 198, 262];

  let tunnelProgress = 0;
  let tunnelLastAt = 0;
  let tunnelCamera = 0;
  let tunnelSpeed = 0.55;
  let tunnelBpm = 0;
  let tunnelLastBeatAt = 0;
  let tunnelTime = 0;
  let tunnelViewScale = 1;

  /**
   * Точки колец и рёбер создаются один раз: в кадре только перезаписываются
   * координаты, без аллокаций массивов и объектов.
   */
  const tunnelRings = [];
  const tunnelRibs = [];

  (function buildTunnelBuffers() {
    for (let order = 0; order < TUNNEL_RINGS; order += 1) {
      const points = new Array(TUNNEL_SEGMENTS);
      for (let i = 0; i < TUNNEL_SEGMENTS; i += 1) {
        points[i] = { x: 0, y: 0 };
      }
      tunnelRings.push({ index: order, depth: 0, visible: true, points: points });
    }

    for (let rib = 0; rib < TUNNEL_RIBS; rib += 1) {
      const points = new Array(TUNNEL_RINGS);
      for (let order = 0; order < TUNNEL_RINGS; order += 1) {
        points[order] = tunnelRings[order].points[rib * TUNNEL_RIB_STRIDE];
      }
      tunnelRibs.push(points);
    }
  })();

  /** Осевая линия туннеля: плавные изгибы, которые меняются во времени. */
  function tunnelPathX(z) {
    return 62 * Math.sin(z * 0.0011 + tunnelTime * 0.07) +
      26 * Math.sin(z * 0.0029 + 1.7 + tunnelTime * 0.05);
  }

  function tunnelPathY(z) {
    return 34 * Math.cos(z * 0.0014 + 0.6 + tunnelTime * 0.03) +
      18 * Math.sin(z * 0.0031 + tunnelTime * 0.04);
  }

  /** Радиус туннеля «дышит» по глубине и масштабируется под размер холста. */
  function tunnelPathRadius(z) {
    return TUNNEL_RADIUS * tunnelViewScale * (1 +
      0.16 * Math.sin(z * 0.0032 + tunnelTime * 0.22) +
      0.08 * Math.sin(z * 0.0061 - tunnelTime * 0.13));
  }

  let voiceWave = null;
  let voiceLevel = 0;
  const voiceBands = [0, 0, 0];
  let voiceLastAt = 0;
  let voiceGlow = null;
  let voiceStroke = null;
  let voiceGradWidth = 0;
  let voiceGradHeight = 0;

  let canvas = null;
  let ctx = null;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let mode = "spectrum";

  let particles = [];
  let stars = [];
  let orbiters = [];
  let beatFlash = 0;
  let rotation = 0;
  let lastAnalysis = null;

  function hsla(hue, saturation, lightness, alpha) {
    return "hsla(" + hue + ", " + saturation + "%, " + lightness + "%, " + alpha + ")";
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function buildParticles() {
    particles = new Array(PARTICLE_COUNT).fill(null).map(function () {
      return {
        x: Math.random(),
        y: Math.random(),
        vx: randomBetween(-0.008, 0.008),
        vy: randomBetween(-0.006, 0.006),
        size: randomBetween(0.6, 2.2),
        alpha: randomBetween(0.18, 0.55),
        hue: randomBetween(-30, 60),
        phase: randomBetween(0, Math.PI * 2),
      };
    });
  }

  function buildStars() {
    stars = new Array(STAR_COUNT).fill(null).map(function () {
      return {
        x: Math.random(),
        y: Math.random() * 0.9,
        size: randomBetween(0.5, 1.7),
        alpha: randomBetween(0.15, 0.6),
        phase: randomBetween(0, Math.PI * 2),
      };
    });
  }

  function buildOrbiters() {
    orbiters = new Array(6).fill(null).map(function (_, index) {
      return {
        radius: 0.16 + index * 0.055,
        speed: 0.00016 + index * 0.000045,
        offset: (Math.PI * 2 * index) / 6,
        tilt: 0.38 + (index % 3) * 0.08,
        size: 1.6 + (index % 3),
        hue: index * 38,
        trail: [],
      };
    });
  }

  function resize() {
    if (!canvas) return false;

    const nextWidth = Math.max(1, global.innerWidth);
    const nextHeight = Math.max(1, global.innerHeight);
    const nextDpr = Math.min(global.devicePixelRatio || 1, 2);

    if (nextWidth === width && nextHeight === height && nextDpr === dpr) return false;

    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (lastAnalysis) draw(lastAnalysis, 0, performance.now());
    return true;
  }

  function drawParticles(now, energy, hue, seconds) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    particles.forEach(function (particle) {
      particle.x += particle.vx * seconds;
      particle.y += particle.vy * seconds;

      if (particle.x < -0.02) particle.x = 1.02;
      if (particle.x > 1.02) particle.x = -0.02;
      if (particle.y < -0.02) particle.y = 1.02;
      if (particle.y > 1.02) particle.y = -0.02;

      const twinkle = 0.55 + 0.45 * Math.sin(now * 0.001 + particle.phase);
      const x = particle.x * width;
      const y = particle.y * height;
      const radius = particle.size * (1 + energy * 0.8);

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = hsla(hue + particle.hue, 80, 72, particle.alpha * twinkle * (0.45 + energy));
      ctx.fill();
    });

    ctx.restore();
  }

  function drawCoreGlow(cx, cy, radius, hue, energy) {
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 3.2);
    glow.addColorStop(0, hsla(hue, 90, 62, 0.22 + energy * 0.24));
    glow.addColorStop(0.4, hsla(hue + 24, 85, 55, 0.08 + energy * 0.08));
    glow.addColorStop(1, hsla(hue + 40, 80, 50, 0));

    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSpectrum(analysis, now, hue, energy, idle) {
    const cx = width / 2;
    const cy = height * 0.5;
    const baseRadius = Math.min(width, height) * 0.085 +
      (idle ? 0 : utils.clamp(analysis.level, 0, 1) * 34) +
      beatFlash * 7;

    drawCoreGlow(cx, cy, baseRadius, hue, energy);

    // Ядро.
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseRadius);
    core.addColorStop(0, hsla(hue, 95, 70, 0.38 + energy * 0.35));
    core.addColorStop(0.6, hsla(hue + 20, 90, 58, 0.18 + energy * 0.2));
    core.addColorStop(1, hsla(hue + 40, 90, 50, 0.02));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
    ctx.fill();

    // Кольца-дуги.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    for (let ring = 0; ring < 3; ring += 1) {
      const radius = baseRadius * (1.45 + ring * 0.5);
      const start = ring * 1.9;
      const length = 1.1 + ring * 0.35;

      ctx.beginPath();
      ctx.arc(0, 0, radius, start, start + length);
      ctx.strokeStyle = hsla(hue + ring * 45, 85, 62, 0.10 + energy * 0.14);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();

    // Круговая волна по осциллограмме.
    if (!idle && analysis.wave && analysis.wave.length > 0) {
      const wave = analysis.wave;
      const points = 140;
      ctx.beginPath();
      for (let i = 0; i <= points; i += 1) {
        const index = Math.floor((i / points) * (wave.length - 1));
        const amplitude = ((wave[index] - 128) / 128) * baseRadius * 0.28;
        const angle = (i / points) * Math.PI * 2 - Math.PI / 2;
        const radius = baseRadius * 1.02 + amplitude;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = hsla(hue + 60, 90, 70, 0.32 + energy * 0.25);
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }

    // Радиальные полосы.
    const values = analysis && analysis.spectrum ? analysis.spectrum : null;
    const bars = 72;
    const inner = baseRadius * 1.18 + 5;
    const maxLength = Math.min(width, height) * 0.27;

    ctx.lineCap = "round";

    for (let i = 0; i < bars; i += 1) {
      const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const mirror = i <= bars / 2 ? i : bars - i;
      const spectrumIndex = Math.min(
        values ? values.length - 1 : 0,
        Math.floor((mirror / bars) * (values ? values.length : 1))
      );
      const value = values
        ? Math.pow(utils.clamp(values[spectrumIndex], 0, 1), 0.92)
        : 0.06 + 0.03 * Math.sin(i * 0.5 + now * 0.0008);

      const length = 5 + value * maxLength * (0.55 + energy * 0.6);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      ctx.beginPath();
      ctx.moveTo(cx + cos * inner, cy + sin * inner);
      ctx.lineTo(cx + cos * (inner + length), cy + sin * (inner + length));
      ctx.strokeStyle = hsla(hue + value * 95, 90, 62, 0.16 + value * 0.66);
      ctx.lineWidth = 1.4 + value * 3.4;
      ctx.stroke();
    }

    // Вспышка на удар.
    if (beatFlash > 0.02) {
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius * (1.4 + (1 - beatFlash) * 2.2), 0, Math.PI * 2);
      ctx.strokeStyle = hsla(hue + 30, 95, 70, beatFlash * 0.28);
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  function drawAurora(analysis, now, hue, energy, idle) {
    const bass = idle ? 0 : utils.clamp(analysis.bass, 0, 1);
    const treble = idle ? 0 : utils.clamp(analysis.treble, 0, 1);
    const step = 26;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (let layer = 2; layer >= 0; layer -= 1) {
      const baseY = height * (0.34 + layer * 0.13);
      const amplitude = height * (0.05 + bass * 0.12) * (0.7 + layer * 0.4);
      const phase = now * (0.00018 + layer * 0.00006) + layer * 2.1;
      const frequency = 0.0026 * (1 + treble * 0.9) * (1 + layer * 0.2);

      const gradient = ctx.createLinearGradient(0, baseY - amplitude * 3, 0, height * 1.05);
      gradient.addColorStop(0, hsla(hue + layer * 45, 90, 62, 0.16 + energy * 0.12));
      gradient.addColorStop(0.45, hsla(hue + layer * 45 + 18, 90, 52, 0.08 + energy * 0.08));
      gradient.addColorStop(1, hsla(hue + layer * 45, 90, 40, 0));

      ctx.beginPath();
      ctx.moveTo(0, height);

      for (let x = 0; x <= width + step; x += step) {
        const y = baseY +
          Math.sin(x * frequency + phase) * amplitude +
          Math.sin(x * frequency * 0.37 + phase * 1.7) * amplitude * 0.55;
        ctx.lineTo(x, y);
      }

      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // Светящаяся кромка.
      ctx.beginPath();
      for (let x = 0; x <= width + step; x += step) {
        const y = baseY +
          Math.sin(x * frequency + phase) * amplitude +
          Math.sin(x * frequency * 0.37 + phase * 1.7) * amplitude * 0.55;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = hsla(hue + layer * 45 + 20, 95, 72, 0.14 + energy * 0.22);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Мягкое пятно света у горизонта.
    const glow = ctx.createRadialGradient(
      width * 0.5, height * 0.72, 0,
      width * 0.5, height * 0.72, Math.min(width, height) * 0.7
    );
    glow.addColorStop(0, hsla(hue + 20, 90, 58, 0.10 + energy * 0.10));
    glow.addColorStop(1, hsla(hue + 20, 90, 58, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    if (beatFlash > 0.02) {
      const bandHeight = height * 0.16;
      const bandY = height * 0.62 - bandHeight / 2;
      const flash = ctx.createLinearGradient(0, bandY, 0, bandY + bandHeight);
      flash.addColorStop(0, hsla(hue + 10, 95, 70, 0));
      flash.addColorStop(0.5, hsla(hue + 30, 95, 70, beatFlash * 0.16));
      flash.addColorStop(1, hsla(hue + 10, 95, 70, 0));
      ctx.fillStyle = flash;
      ctx.fillRect(0, bandY, width, bandHeight);
    }

    ctx.restore();
  }

  function drawOrbit(analysis, now, hue, energy, idle) {
    const cx = width / 2;
    const cy = height * 0.46;
    const base = Math.min(width, height);
    const level = idle ? 0 : utils.clamp(analysis.level, 0, 1);
    const bass = idle ? 0 : utils.clamp(analysis.bass, 0, 1);
    const treble = idle ? 0 : utils.clamp(analysis.treble, 0, 1);

    // Звёзды.
    stars.forEach(function (star) {
      const twinkle = 0.4 + 0.6 * Math.abs(Math.sin(now * 0.0007 + star.phase));
      ctx.beginPath();
      ctx.arc(star.x * width, star.y * height, star.size, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(220, 240, 255, " + (star.alpha * twinkle * 0.7) + ")";
      ctx.fill();
    });

    // Ядро «дышит» под музыку: радиус, яркость и ореол зависят от уровня,
    // баса и удара, а не стоят на месте.
    const coreRadius = base * (
      0.045 + level * 0.085 + bass * 0.035 + beatFlash * 0.03 + treble * 0.012
    );
    const glowRadius = coreRadius * (1.1 + energy * 0.55);

    drawCoreGlow(cx, cy, glowRadius, hue, energy);

    // Двойной ореол вокруг ядра.
    const halo = ctx.createRadialGradient(cx, cy, coreRadius * 0.35, cx, cy, coreRadius * 2.6);
    halo.addColorStop(0, hsla(hue + 10, 95, 68, 0.16 + energy * 0.18));
    halo.addColorStop(0.5, hsla(hue + 26, 92, 60, 0.06 + energy * 0.08));
    halo.addColorStop(1, hsla(hue + 40, 90, 55, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius * 2.6, 0, Math.PI * 2);
    ctx.fill();

    // Эллиптические орбиты.
    for (let i = 0; i < 3; i += 1) {
      const radius = base * (0.16 + i * 0.11);
      ctx.beginPath();
      ctx.ellipse(cx, cy, radius, radius * 0.42, -0.18, 0, Math.PI * 2);
      ctx.strokeStyle = hsla(hue + i * 40, 80, 60, 0.08 + energy * 0.08);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius);
    core.addColorStop(0, hsla(hue, 95, 78, Math.min(1, 0.72 + energy * 0.26)));
    core.addColorStop(0.55, hsla(hue + 14, 92, 64, 0.22 + energy * 0.2));
    core.addColorStop(1, hsla(hue + 20, 90, 55, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
    ctx.fill();

    // Энергетическое кольцо — видимая амплитуда реакции на громкость.
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius * (1.3 + level * 0.5), 0, Math.PI * 2);
    ctx.strokeStyle = hsla(hue + 30, 95, 70, 0.1 + energy * 0.22);
    ctx.lineWidth = 0.8 + level * 1.8;
    ctx.stroke();

    // Планеты со шлейфами.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    orbiters.forEach(function (orbiter) {
      const radius = base * (orbiter.radius + level * 0.02);
      const angle = now * orbiter.speed + orbiter.offset;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius * orbiter.tilt;

      orbiter.trail.unshift({ x: x, y: y });
      if (orbiter.trail.length > 14) orbiter.trail.pop();

      for (let i = orbiter.trail.length - 1; i >= 0; i -= 1) {
        const point = orbiter.trail[i];
        const alpha = (1 - i / orbiter.trail.length) * 0.22;
        ctx.beginPath();
        ctx.arc(point.x, point.y, Math.max(0.4, orbiter.size * (1 - i / orbiter.trail.length)), 0, Math.PI * 2);
        ctx.fillStyle = hsla(hue + orbiter.hue, 85, 65, alpha);
        ctx.fill();
      }

      const size = orbiter.size * (1 + level * 0.9 + beatFlash * 0.4);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, size * 6);
      glow.addColorStop(0, hsla(hue + orbiter.hue, 90, 70, 0.7));
      glow.addColorStop(0.35, hsla(hue + orbiter.hue, 90, 62, 0.22));
      glow.addColorStop(1, hsla(hue + orbiter.hue, 90, 60, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, size * 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fill();
    });

    ctx.restore();

    if (beatFlash > 0.02) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, base * (0.4 + (1 - beatFlash) * 0.15), base * 0.17, -0.18, 0, Math.PI * 2);
      ctx.strokeStyle = hsla(hue + 40, 95, 70, beatFlash * 0.18);
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  function smoothStep(t) {
    return t * t * (3 - 2 * t);
  }

  /** Кратчайший переход между оттенками по кругу. */
  function lerpHue(from, to, t) {
    const diff = ((to - from + 540) % 360) - 180;
    return (from + diff * t + 360) % 360;
  }

  /** Сглаженная кривая Catmull-Rom по точкам. */
  function traceSmooth(points) {
    ctx.moveTo(points[0].x, points[0].y);
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

  /**
   * Неоднородность стены: у камеры она сильнее, в глубине — мягче,
   * чтобы дальние кольца сходились к точке схода и не пересекались.
   */
  function tunnelWobble(theta, z, depth, totalDepth, time) {
    const taper = utils.clamp(1.1 - depth / totalDepth, 0.25, 1);
    return 1 + taper * (
      0.12 * Math.sin(3 * theta + z * 0.012 + time * 0.6) +
      0.06 * Math.sin(5 * theta - z * 0.02 + time * 0.9) +
      0.04 * Math.sin(2 * theta + z * 0.028 - time * 0.5)
    );
  }

  /** Замкнутая сглаженная кривая Catmull-Rom — контур стены туннеля. */
  function traceClosedSmooth(points) {
    const n = points.length;
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 0; i < n; i += 1) {
      const p0 = points[(i - 1 + n) % n];
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const p3 = points[(i + 2) % n];

      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6,
        p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6,
        p2.y - (p3.y - p1.y) / 6,
        p2.x,
        p2.y
      );
    }

    ctx.closePath();
  }

  /**
   * «Туннель» — полёт сквозь органический туннель.
   *
   * Стены — замкнутые кривые Безье с неоднородным радиусом, закрученные по
   * глубине. Кольца и продольные рёбра рисуются, пока их bbox (с запасом на
   * толщину линии и свечение) пересекается с холстом: раннего гашения по
   * глубине больше нет, поэтому кривые доходят до краёв экрана и не обрываются
   * в центре. Скорость камеры плавно следует за темпом трека (BPM по
   * интервалам ударов) и его энергией; в паузе — медленный дрейф.
   */
  function drawTunnel(analysis, now, hue, energy, idle) {
    const level = idle ? 0 : utils.clamp(analysis.level, 0, 1);
    const mid = idle ? 0 : utils.clamp(analysis.mid, 0, 1);
    const treble = idle ? 0 : utils.clamp(analysis.treble, 0, 1);

    // dt не бывает отрицательным: время кадра может прийти из другого источника
    // (resize/видимость вкладки), и тогда камера не должна ехать назад.
    const dt = tunnelLastAt
      ? utils.clamp(now - tunnelLastAt, 0, 80) / 1000
      : 0.016;
    tunnelLastAt = now;
    tunnelTime = now * 0.001;
    tunnelViewScale = utils.clamp(
      Math.hypot(width, height) / TUNNEL_REF_DIAGONAL,
      0.5,
      1.5
    );

    // Темп: интервалы между ударами → BPM (сглаженный).
    // Удар приходит не чаще, чем раз в 170 мс (см. analyser.detectBeat).
    const beat = Boolean(!idle && analysis && analysis.beat);
    if (beat) {
      if (tunnelLastBeatAt) {
        const gap = now - tunnelLastBeatAt;
        if (gap >= 170 && gap <= 1600) {
          const instantBpm = 60000 / gap;
          tunnelBpm = tunnelBpm
            ? tunnelBpm + (instantBpm - tunnelBpm) * 0.2
            : instantBpm;
        }
      }
      tunnelLastBeatAt = now;
    } else if (tunnelBpm && now - tunnelLastBeatAt > 2200) {
      // Музыка стихла — плавно возвращаемся к спокойному дрейфу.
      tunnelBpm *= Math.exp(-dt * 1.1);
      if (tunnelBpm < 1) tunnelBpm = 0;
    }

    // Множитель скорости: 60 BPM → 0, 170 BPM и выше → 1.
    const tempo = tunnelBpm ? utils.clamp((tunnelBpm - 60) / 110, 0, 1) : 0;
    const loudness = idle
      ? 0
      : utils.clamp(level * 0.62 + mid * 0.28 + treble * 0.1, 0, 1);
    const targetSpeed = idle
      ? TUNNEL_SPEED_MIN
      : utils.clamp(
        0.3 + tempo * 1.05 + loudness * 0.8 + beatFlash * 0.18,
        TUNNEL_SPEED_MIN,
        TUNNEL_SPEED_MAX
      );

    // Экспоненциальное сглаживание — камера разгоняется и тормозит без рывков.
    tunnelSpeed += (targetSpeed - tunnelSpeed) * (1 - Math.exp(-dt * 3.4));
    tunnelCamera += dt * TUNNEL_BASE_SPEED * tunnelSpeed;

    // Цвет: та же палитра, что и раньше; музыка меняет скорость перехода.
    const paletteSpeed = 0.08 + level * 0.55 + treble * 0.3 + beatFlash * 0.9;
    tunnelProgress += dt * paletteSpeed;

    const count = TUNNEL_PALETTES.length;
    // Остаток берём с положительным знаком: прогресс только растёт, но защита
    // от выбросов времени не должна давать undefined-палитру.
    const current = ((Math.floor(tunnelProgress) % count) + count) % count;
    const next = (current + 1) % count;
    const mix = smoothStep(tunnelProgress - Math.floor(tunnelProgress));
    const paletteA = TUNNEL_PALETTES[current];
    const paletteB = TUNNEL_PALETTES[next];

    const totalDepth = TUNNEL_RINGS * TUNNEL_SPACING;
    const offset = tunnelCamera % TUNNEL_SPACING;
    const camX = tunnelPathX(tunnelCamera);
    const camY = tunnelPathY(tunnelCamera);
    const cx = width / 2;
    const cy = height * 0.5;

    // Ближайшее кольцо — с минимальным (index * SPACING - offset) mod totalDepth;
    // при offset > 0 это index 1, иначе 0. Дальше глубина только растёт.
    const firstIndex = offset > 0 ? 1 : 0;

    // 1) Точки всех колец (в порядке «ближнее → дальнее») и их bbox.
    for (let order = 0; order < TUNNEL_RINGS; order += 1) {
      const index = (firstIndex + order) % TUNNEL_RINGS;
      const ring = tunnelRings[order];
      const depth = TUNNEL_NEAR +
        ((index * TUNNEL_SPACING - offset + totalDepth) % totalDepth);
      const scale = TUNNEL_FOCAL / depth;
      const z = tunnelCamera + depth;
      const ringX = cx + (tunnelPathX(z) - camX) * scale;
      const ringY = cy + (tunnelPathY(z) - camY) * scale;
      const radius = tunnelPathRadius(z) * scale;

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      for (let i = 0; i < TUNNEL_SEGMENTS; i += 1) {
        const theta = (i / TUNNEL_SEGMENTS) * Math.PI * 2;
        const wobble = tunnelWobble(theta, z, depth, totalDepth, tunnelTime);
        const rr = radius * wobble;
        const x = ringX + Math.cos(theta) * rr;
        const y = ringY + Math.sin(theta) * rr;
        const point = ring.points[i];

        point.x = x;
        point.y = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

      ring.index = index;
      ring.depth = depth;
      ring.visible = maxX > -TUNNEL_CULL_MARGIN &&
        minX < width + TUNNEL_CULL_MARGIN &&
        maxY > -TUNNEL_CULL_MARGIN &&
        minY < height + TUNNEL_CULL_MARGIN;
    }

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";

    // 2) Продольные рёбра стен — плавные кривые по уже посчитанным точкам.
    for (let rib = 0; rib < TUNNEL_RIBS; rib += 1) {
      const points = tunnelRibs[rib];

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;

      for (let order = 0; order < TUNNEL_RINGS; order += 1) {
        const point = points[order];
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      }

      if (maxX < -TUNNEL_CULL_MARGIN || minX > width + TUNNEL_CULL_MARGIN ||
        maxY < -TUNNEL_CULL_MARGIN || minY > height + TUNNEL_CULL_MARGIN) {
        continue;
      }

      const paletteIndex = rib % paletteA.length;
      const ribHue = lerpHue(paletteA[paletteIndex], paletteB[paletteIndex], mix);

      ctx.beginPath();
      traceSmooth(points);
      ctx.strokeStyle = hsla(ribHue + 18, 88, 64, 0.06 + energy * 0.07);
      ctx.lineWidth = 1.05;
      ctx.stroke();
    }

    // 3) Замкнутые органические стены туннеля.
    for (let order = 0; order < TUNNEL_RINGS; order += 1) {
      const ring = tunnelRings[order];
      if (!ring.visible) continue;

      const depth = ring.depth;
      const paletteIndex = ring.index % paletteA.length;
      const ringHue = lerpHue(paletteA[paletteIndex], paletteB[paletteIndex], mix) +
        (depth / totalDepth) * 34;
      const sizeFade = 1 - depth / (totalDepth + TUNNEL_NEAR);
      // Мягкая глубина: дальние кольца чуть прозрачнее, но никогда не гаснут.
      const depthShade = 0.55 + 0.45 * (1 - depth / totalDepth);
      const alpha = Math.min(1, (0.12 + energy * 0.28) * depthShade);

      ctx.beginPath();
      traceClosedSmooth(ring.points);
      ctx.strokeStyle = hsla(ringHue, 90, 64, alpha * 0.5);
      ctx.lineWidth = Math.max(0.6, 4.2 * sizeFade);
      ctx.stroke();

      ctx.strokeStyle = hsla(ringHue, 96, 76, alpha);
      ctx.lineWidth = Math.max(0.5, 1.1 * sizeFade + 0.35);
      ctx.stroke();
    }

    ctx.restore();

    // Дымка в глубине туннеля, привязанная к текущей палитре.
    const fogHue = lerpHue(paletteA[0], paletteB[0], mix);
    const fog = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(width, height) * 0.6);
    fog.addColorStop(0, hsla(fogHue, 90, 58, 0.07 + energy * 0.07));
    fog.addColorStop(1, hsla(fogHue, 90, 45, 0));
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, width, height);
  }

  /* ------------------------------------------------------------------ */
  /* «Голос» — спокойная визуализация речи.                              */
  /* Три форманты (200–800, 800–2000, 2000–4500 Гц) ведут светящиеся дуги, */
  /* а по центру живёт сглаженная осциллограмма из analysis.wave.         */
  /* ------------------------------------------------------------------ */

  /** Речь тише музыки: мягкая гамма и усиление, чтобы полосы дышали. */
  function voiceShape(value) {
    return utils.clamp(Math.pow(utils.clamp(value, 0, 1), 0.7) * 1.35, 0, 1);
  }

  /** Экспоненциальное сглаживание, не зависящее от частоты кадров. */
  function voiceEase(current, target, dt, attack, release) {
    const tau = target > current ? attack : release;
    return current + (target - current) * (1 - Math.exp(-dt / tau));
  }

  /** Средняя энергия спектра в речевой полосе, Гц (лог-шкала анализатора). */
  function voiceSpectrumBand(values, fromHz, toHz) {
    if (!values || !values.length) return 0;
    const steps = values.length;
    const minLog = Math.log(30);
    const maxLog = Math.log(16000);
    const from = utils.clamp(
      Math.floor((steps * (Math.log(fromHz) - minLog)) / (maxLog - minLog)),
      0,
      steps - 1
    );
    const to = utils.clamp(
      Math.ceil((steps * (Math.log(toHz) - minLog)) / (maxLog - minLog)),
      from + 1,
      steps
    );
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += values[i];
    return sum / (to - from);
  }

  function buildVoice() {
    voiceWave = new Float32Array(VOICE_POINTS);
    voiceBands[0] = 0;
    voiceBands[1] = 0;
    voiceBands[2] = 0;
    voiceLevel = 0;
    voiceLastAt = 0;
    voiceGlow = null;
    voiceStroke = null;
    voiceGradWidth = 0;
    voiceGradHeight = 0;
  }

  /** Градиенты зависят только от размеров — обновляем их при resize, не в кадре. */
  function ensureVoiceGradients() {
    if (!voiceWave) buildVoice();
    if (voiceGlow && voiceGradWidth === width && voiceGradHeight === height) return;

    const cx = width / 2;
    const cy = height * 0.5;
    const base = Math.min(width, height);
    const halfSpan = Math.min(width * 0.39, base * 0.56);

    voiceGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(140, base * 0.66));
    voiceGlow.addColorStop(0, hsla(184, 86, 64, 0.2));
    voiceGlow.addColorStop(0.45, hsla(222, 82, 58, 0.08));
    voiceGlow.addColorStop(1, hsla(262, 80, 52, 0));

    voiceStroke = ctx.createLinearGradient(cx - halfSpan, 0, cx + halfSpan, 0);
    voiceStroke.addColorStop(0, hsla(170, 92, 64, 1));
    voiceStroke.addColorStop(0.5, hsla(192, 94, 72, 1));
    voiceStroke.addColorStop(1, hsla(266, 92, 74, 1));

    voiceGradWidth = width;
    voiceGradHeight = height;
  }

  /** Верхняя и нижняя дуги эллипса с разрывами по бокам — «формантные ленты». */
  function traceVoiceArcs(cx, cy, rx, ry, gap) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, Math.PI + gap, Math.PI * 2 - gap);
    ctx.moveTo(cx + Math.cos(gap) * rx, cy + Math.sin(gap) * ry);
    ctx.ellipse(cx, cy, rx, ry, 0, gap, Math.PI - gap);
  }

  /** Осциллограмма: фиксированные 128 точек, без аллокаций в каждом кадре. */
  function traceVoiceWave(x0, cy, stepX, amplitude, idleSine, now) {
    ctx.beginPath();
    for (let i = 0; i < VOICE_POINTS; i += 1) {
      const drift = idleSine ? Math.sin(i * 0.16 + now * 0.0012) * idleSine : 0;
      const y = cy + voiceWave[i] * amplitude + drift;
      if (i === 0) ctx.moveTo(x0, y);
      else ctx.lineTo(x0 + i * stepX, y);
    }
  }

  function drawVoice(analysis, now, hue, energy, idle) {
    ensureVoiceGradients();

    const cx = width / 2;
    const cy = height * 0.5;
    const base = Math.min(width, height);
    const halfSpan = Math.min(width * 0.39, base * 0.56);
    const dt = voiceLastAt ? utils.clamp(now - voiceLastAt, 0, 120) / 1000 : 0.016;
    voiceLastAt = now;

    const spectrum = !idle && analysis && analysis.spectrum ? analysis.spectrum : null;
    let targetLow = 0;
    let targetMid = 0;
    let targetHigh = 0;
    let targetLevel = 0;

    if (spectrum) {
      targetLow = voiceShape(voiceSpectrumBand(spectrum, 200, 800));
      targetMid = voiceShape(voiceSpectrumBand(spectrum, 800, 2000));
      targetHigh = voiceShape(voiceSpectrumBand(spectrum, 2000, 4500));
      targetLevel = voiceShape(voiceSpectrumBand(spectrum, 200, 4000));
    }

    voiceBands[0] = voiceEase(voiceBands[0], targetLow, dt, 0.05, 0.22);
    voiceBands[1] = voiceEase(voiceBands[1], targetMid, dt, 0.05, 0.26);
    voiceBands[2] = voiceEase(voiceBands[2], targetHigh, dt, 0.04, 0.3);
    voiceLevel = voiceEase(voiceLevel, targetLevel, dt, 0.05, 0.26);

    const breath = 0.5 + 0.5 * Math.sin(now * 0.0009);

    // Дымка вокруг центра: в тишине «дышит» вместо пустого экрана.
    ctx.save();
    ctx.fillStyle = voiceGlow;
    ctx.globalAlpha = idle
      ? 0.22 + breath * 0.22
      : 0.34 + voiceLevel * 0.42 + utils.clamp(energy, 0, 1) * 0.12;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Осевая линия, к которой возвращается волна в паузах.
    ctx.save();
    ctx.strokeStyle = hsla(hue, 82, 66, idle ? 0.1 + breath * 0.05 : 0.1 + voiceLevel * 0.12);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - halfSpan, cy);
    ctx.lineTo(cx + halfSpan, cy);
    ctx.stroke();
    ctx.restore();

    // Осциллограмма: обновляем точки один раз за кадр, паузы гасим плавно.
    const source = !idle && analysis && analysis.wave ? analysis.wave : null;
    const waveLength = source ? source.length : 0;

    for (let i = 0; i < VOICE_POINTS; i += 1) {
      let target = 0;
      if (waveLength > 1) {
        const index = Math.round((i / (VOICE_POINTS - 1)) * (waveLength - 1));
        target = (source[index] - 128) / 128;
      }
      voiceWave[i] = voiceEase(voiceWave[i], target, dt, 0.035, 0.16);
    }

    const amplitude = base * 0.115 * (idle ? 0.12 : 0.55 + voiceLevel * 0.85);
    const idleSine = idle ? base * 0.0045 : 0;
    const stepX = (halfSpan * 2) / (VOICE_POINTS - 1);
    const x0 = cx - halfSpan;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Заливка под волной — мягкое «тело» голоса.
    traceVoiceWave(x0, cy, stepX, amplitude, idleSine, now);
    ctx.lineTo(x0 + halfSpan * 2, cy);
    ctx.lineTo(x0, cy);
    ctx.closePath();
    ctx.fillStyle = hsla(hue + 28, 86, 66, idle ? 0.03 : 0.05 + voiceLevel * 0.05);
    ctx.fill();

    // Формантные дуги: внешняя — высокая полоса, внутренняя — низкая.
    for (let band = 2; band >= 0; band -= 1) {
      const value = voiceBands[band];
      const rx = base * (0.245 + band * 0.105) * (1 + value * 0.035) +
        (idle ? base * 0.006 * breath : 0);
      const ry = rx * (0.5 + band * 0.02);
      const gap = 0.16 + band * 0.04 + (idle ? 0 : (1 - value) * 0.05) +
        Math.sin(now * 0.00022 + band * 1.7) * 0.025;
      const alpha = idle ? 0.05 + breath * 0.05 : 0.1 + value * 0.55;
      const lineWidth = 0.9 + value * 3.4;

      traceVoiceArcs(cx, cy, rx, ry, gap);
      ctx.strokeStyle = hsla(VOICE_HUES[band], 92, 64, alpha * 0.32);
      ctx.lineWidth = lineWidth * 6;
      ctx.stroke();

      traceVoiceArcs(cx, cy, rx, ry, gap);
      ctx.strokeStyle = hsla(VOICE_HUES[band], 95, 74, alpha);
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }

    // Свечение и чистая линия осциллограммы.
    traceVoiceWave(x0, cy, stepX, amplitude, idleSine, now);
    ctx.strokeStyle = hsla(hue + 12, 90, 66, idle ? 0.08 : 0.1 + voiceLevel * 0.16);
    ctx.lineWidth = 7;
    ctx.stroke();

    traceVoiceWave(x0, cy, stepX, amplitude, idleSine, now);
    ctx.globalAlpha = idle ? 0.32 + breath * 0.22 : 0.55 + voiceLevel * 0.45;
    ctx.strokeStyle = voiceStroke;
    ctx.lineWidth = 1.7;
    ctx.stroke();

    ctx.restore();
  }

  function drawSpiral(analysis, now, hue, energy, idle) {
    const cx = width / 2;
    const cy = height * 0.5;
    const base = Math.min(width, height);
    const level = idle ? 0 : utils.clamp(analysis.level, 0, 1);
    const bass = idle ? 0 : utils.clamp(analysis.bass, 0, 1);
    const treble = idle ? 0 : utils.clamp(analysis.treble, 0, 1);
    const maxRadius = base * 0.45;
    const arms = 4;
    const dots = 120;
    const spin = now * (0.00004 + treble * 0.00014) + rotation * 0.6;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Спиральные рукава из светящихся точек.
    for (let arm = 0; arm < arms; arm += 1) {
      const armOffset = (Math.PI * 2 * arm) / arms;

      for (let i = 0; i < dots; i += 1) {
        const t = i / (dots - 1);
        const radius = maxRadius * (0.06 + t * 0.98) * (1 + level * 0.05) *
          (1 + bass * 0.01 * Math.sin(i * 0.5 + now * 0.002));
        const angle = armOffset + t * 2.8 + spin;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius * 0.7;
        const alpha = (0.06 + energy * 0.34) * Math.pow(1 - t, 0.55);
        const size = 0.5 + Math.pow(1 - t, 1.4) * 2.4 + level * 1.1;

        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = hsla(hue + t * 110 + arm * 14, 92, 68, Math.min(1, alpha));
        ctx.fill();
      }
    }

    drawCoreGlow(cx, cy, base * (0.05 + level * 0.04), hue, energy);

    const coreRadius = base * (0.06 + level * 0.05 + beatFlash * 0.02);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius);
    core.addColorStop(0, hsla(hue + 30, 95, 76, Math.min(1, 0.6 + energy * 0.3)));
    core.addColorStop(0.55, hsla(hue + 10, 92, 62, 0.2 + energy * 0.2));
    core.addColorStop(1, hsla(hue, 90, 55, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    if (beatFlash > 0.02) {
      ctx.beginPath();
      ctx.ellipse(
        cx, cy,
        base * (0.3 + (1 - beatFlash) * 0.2),
        base * 0.2,
        0, 0, Math.PI * 2
      );
      ctx.strokeStyle = hsla(hue + 60, 95, 72, beatFlash * 0.16);
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
  }

  function draw(analysis, dtMs, now) {
    if (!ctx) return;
    if (!width || !height) {
      if (!resize()) return;
    }

    lastAnalysis = analysis;

    const seconds = utils.clamp(dtMs || 0, 0, 80) / 1000;
    const playing = Boolean(
      MR.store && MR.store.state.playback && MR.store.state.playback.isPlaying
    );
    const idle = !analysis || !analysis.active || !playing;

    const level = idle ? 0 : utils.clamp(analysis.level, 0, 1);
    const bass = idle ? 0 : utils.clamp(analysis.bass, 0, 1);
    const treble = idle ? 0 : utils.clamp(analysis.treble, 0, 1);

    if (analysis && analysis.beat) beatFlash = 1;
    else beatFlash = Math.max(0, beatFlash * Math.pow(0.9, Math.max(1, (dtMs || 16.7) / 16.7)));

    rotation += seconds * (0.06 + level * 0.3);

    const hue = 196 + Math.sin(now * 0.00004) * 16 + treble * 26;
    const energy = idle
      ? 0.16 + 0.05 * Math.sin(now * 0.0018)
      : 0.32 + level * 0.65 + bass * 0.15;

    ctx.clearRect(0, 0, width, height);

    drawParticles(now, energy, hue, seconds);

    if (mode === "aurora") {
      drawAurora(analysis, now, hue, energy, idle);
    } else if (mode === "orbit") {
      drawOrbit(analysis, now, hue, energy, idle);
    } else if (mode === "tunnel") {
      drawTunnel(analysis, now, hue, energy, idle);
    } else if (mode === "spiral") {
      drawSpiral(analysis, now, hue, energy, idle);
    } else if (mode === "voice") {
      drawVoice(analysis, now, hue, energy, idle);
    } else {
      drawSpectrum(analysis, now, hue, energy, idle);
    }
  }

  function setMode(nextMode) {
    if (MODES.indexOf(nextMode) === -1) return;
    mode = nextMode;
    orbiters.forEach(function (orbiter) { orbiter.trail.length = 0; });
    if (ctx) draw(lastAnalysis, 0, performance.now());
  }

  function init() {
    canvas = document.getElementById("bg-canvas");
    if (!canvas) return;

    ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    buildParticles();
    buildStars();
    buildOrbiters();
    buildVoice();
    resize();

    global.addEventListener("resize", utils.debounce(resize, 160));
  }

  MR.bg = {
    init: init,
    draw: draw,
    resize: resize,
    setMode: setMode,
    get mode() { return mode; },
  };
})(window);
