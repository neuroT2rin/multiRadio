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

  const MODES = ["spectrum", "aurora", "orbit", "tunnel", "spiral"];
  const PARTICLE_COUNT = 64;
  const STAR_COUNT = 90;

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

  function drawTunnel(analysis, now, hue, energy, idle) {
    const cx = width / 2;
    const cy = height * 0.5;
    const level = idle ? 0 : utils.clamp(analysis.level, 0, 1);
    const bass = idle ? 0 : utils.clamp(analysis.bass, 0, 1);
    const treble = idle ? 0 : utils.clamp(analysis.treble, 0, 1);
    const maxRadius = Math.hypot(width, height) * 0.55;
    const ringCount = 30;
    const speed = 0.00005 + level * 0.00016 + bass * 0.00007;
    const offset = (now * speed) % 1;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Спицы туннеля — задают перспективу.
    for (let i = 0; i < 28; i += 1) {
      const angle = (i / 28) * Math.PI * 2 + now * 0.00002;
      ctx.beginPath();
      ctx.moveTo(
        cx + Math.cos(angle) * maxRadius * 0.04,
        cy + Math.sin(angle) * maxRadius * 0.04
      );
      ctx.lineTo(cx + Math.cos(angle) * maxRadius, cy + Math.sin(angle) * maxRadius);
      ctx.strokeStyle = hsla(hue + 20, 85, 58, 0.025 + energy * 0.035);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Кольца, летящие из глубины на зрителя.
    for (let i = 0; i < ringCount; i += 1) {
      const p = (i / ringCount + offset) % 1;
      const radius = maxRadius * Math.pow(p, 2.3);
      if (radius < 1.5) continue;

      const depth = 1 - p;
      const alpha = Math.pow(depth, 0.6) * (0.1 + energy * 0.24) * (0.35 + p);
      const wobble = 1 + bass * 0.015 * Math.sin(now * 0.0024 + i * 0.9);

      ctx.beginPath();
      ctx.arc(cx, cy, radius * wobble, 0, Math.PI * 2);
      ctx.strokeStyle = hsla(hue + p * 90 + treble * 20, 92, 64, Math.min(1, alpha));
      ctx.lineWidth = 0.7 + p * 3.4;
      ctx.stroke();
    }

    // Свечение в центре туннеля.
    const glowRadius = maxRadius * (0.16 + level * 0.08 + beatFlash * 0.03);
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
    glow.addColorStop(0, hsla(hue + 50, 95, 74, 0.3 + energy * 0.3));
    glow.addColorStop(0.45, hsla(hue + 25, 90, 62, 0.1 + energy * 0.1));
    glow.addColorStop(1, hsla(hue, 90, 55, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    if (beatFlash > 0.02) {
      ctx.beginPath();
      ctx.arc(cx, cy, maxRadius * (0.55 + (1 - beatFlash) * 0.4), 0, Math.PI * 2);
      ctx.strokeStyle = hsla(hue + 50, 95, 72, beatFlash * 0.2);
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
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
