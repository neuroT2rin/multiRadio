/**
 * services/analyser.js — единый поставщик данных о спектре.
 *
 * Один AnalyserNode обслуживает и фоновую визуализацию, и мини-спектр,
 * и индикаторы эквалайзера. Данные читаются ровно один раз за кадр:
 * визуализатор вызывает read() и передаёт результат дальше.
 *
 * Возвращаемый объект:
 *  {
 *    active: boolean,        // есть ли подключённый анализатор
 *    silent: boolean,        // играет, но данных нет (обычно CORS)
 *    level, bass, mid, treble: 0..1,
 *    spectrum: number[64],   // логарифмические полосы, сглаженные
 *    eqBands: number[10],    // энергии под полосы эквалайзера
 *    wave: Uint8Array,       // осциллограмма
 *    beat: boolean           // удар в этом кадре
 *  }
 */
(function (global) {
  "use strict";

  const MR = (global.MR = global.MR || {});
  const utils = MR.utils;

  const SPECTRUM_SIZE = 64;
  const EQ_BANDS = MR.defaults.eqBands.length;
  const BASS_RANGE = [20, 250];
  const MID_RANGE = [250, 2000];
  const TREBLE_RANGE = [2000, 14000];

  const player = {
    analyserNode: null,
    sampleRate: 44100,
    freq: null,
    wave: null,
    spectrum: new Array(SPECTRUM_SIZE).fill(0),
    eqBands: new Array(EQ_BANDS).fill(0),
    level: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    silentFrames: 0,
    history: [],
    lastBeatAt: 0,
  };

  function ensureBuffers() {
    if (!player.analyserNode) return false;
    const bins = player.analyserNode.frequencyBinCount;
    const fftSize = player.analyserNode.fftSize;
    if (!player.freq || player.freq.length !== bins) {
      player.freq = new Uint8Array(bins);
    }
    if (!player.wave || player.wave.length !== fftSize) {
      player.wave = new Uint8Array(fftSize);
    }
    player.sampleRate = player.analyserNode.context
      ? player.analyserNode.context.sampleRate
      : 44100;
    return true;
  }

  function attach(node) {
    player.analyserNode = node || null;
    player.freq = null;
    player.wave = null;
    player.silentFrames = 0;
    player.history.length = 0;
    player.spectrum.fill(0);
    player.eqBands.fill(0);
    player.level = 0;
    player.bass = 0;
    player.mid = 0;
    player.treble = 0;
    ensureBuffers();
  }

  function detach() {
    attach(null);
  }

  function binFor(hz) {
    const bins = player.freq.length;
    const nyquist = player.sampleRate / 2;
    return utils.clamp(Math.round((hz / nyquist) * bins), 0, bins - 1);
  }

  function rangeAverage(fromHz, toHz) {
    const start = binFor(fromHz);
    const end = Math.max(start + 1, binFor(toHz));
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += player.freq[i];
    return (sum / (end - start)) / 255;
  }

  function smooth(previous, next, attack, release) {
    const factor = next > previous ? attack : release;
    return previous + (next - previous) * factor;
  }

  function computeSpectrum() {
    const minLog = Math.log(30);
    const maxLog = Math.log(16000);
    const steps = SPECTRUM_SIZE;

    for (let i = 0; i < steps; i += 1) {
      const fromHz = Math.exp(minLog + ((maxLog - minLog) * i) / steps);
      const toHz = Math.exp(minLog + ((maxLog - minLog) * (i + 1)) / steps);
      const raw = Math.pow(rangeAverage(fromHz, toHz), 0.8);
      player.spectrum[i] = smooth(player.spectrum[i], raw, 0.55, 0.16);
    }
  }

  function computeEqBands() {
    MR.defaults.eqBands.forEach(function (band, index) {
      const from = Math.max(20, band.freq / 1.6);
      const to = Math.min(16000, band.freq * 1.6);
      const raw = Math.pow(rangeAverage(from, to), 0.75);
      player.eqBands[index] = smooth(player.eqBands[index], raw, 0.6, 0.18);
    });
  }

  function computeWaveLevel() {
    const wave = player.wave;
    let sum = 0;
    for (let i = 0; i < wave.length; i += 1) {
      const value = (wave[i] - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / wave.length);
    return utils.clamp(rms * 3.4, 0, 1);
  }

  function detectBeat(now) {
    const bass = player.bass;
    player.history.push(bass);
    if (player.history.length > 43) player.history.shift();

    const average = player.history.reduce(function (sum, value) { return sum + value; }, 0) /
      player.history.length;

    const isBeat = bass > 0.14 &&
      bass > average * 1.28 &&
      now - player.lastBeatAt > 170;

    if (isBeat) player.lastBeatAt = now;
    return isBeat;
  }

  function idleResult() {
    return {
      active: false,
      silent: false,
      level: player.level,
      bass: player.bass,
      mid: player.mid,
      treble: player.treble,
      spectrum: player.spectrum,
      eqBands: player.eqBands,
      wave: player.wave || new Uint8Array(0),
      beat: false,
    };
  }

  /**
   * Читает данные анализатора. Вызывать один раз за кадр.
   * @param {number} now метка времени performance.now()
   */
  function read(now) {
    if (!player.analyserNode || !ensureBuffers()) {
      // Плавно гасим значения, чтобы визуализация замирала, а не дёргалась.
      player.level += (0 - player.level) * 0.06;
      player.bass += (0 - player.bass) * 0.08;
      player.mid += (0 - player.mid) * 0.08;
      player.treble += (0 - player.treble) * 0.08;
      for (let i = 0; i < player.spectrum.length; i += 1) {
        player.spectrum[i] += (0 - player.spectrum[i]) * 0.08;
      }
      for (let i = 0; i < player.eqBands.length; i += 1) {
        player.eqBands[i] += (0 - player.eqBands[i]) * 0.08;
      }
      return idleResult();
    }

    player.analyserNode.getByteFrequencyData(player.freq);
    player.analyserNode.getByteTimeDomainData(player.wave);

    computeSpectrum();
    computeEqBands();

    const rawLevel = computeWaveLevel();
    player.level = smooth(player.level, rawLevel, 0.45, 0.1);
    player.bass = smooth(player.bass, rangeAverage(BASS_RANGE[0], BASS_RANGE[1]), 0.5, 0.14);
    player.mid = smooth(player.mid, rangeAverage(MID_RANGE[0], MID_RANGE[1]), 0.45, 0.12);
    player.treble = smooth(player.treble, rangeAverage(TREBLE_RANGE[0], TREBLE_RANGE[1]), 0.45, 0.12);

    const playing = Boolean(
      MR.store && MR.store.state.playback && MR.store.state.playback.isPlaying
    );
    if (playing && rawLevel < 0.0015) {
      player.silentFrames += 1;
    } else {
      player.silentFrames = 0;
    }

    return {
      active: true,
      silent: player.silentFrames > 90,
      level: player.level,
      bass: player.bass,
      mid: player.mid,
      treble: player.treble,
      spectrum: player.spectrum,
      eqBands: player.eqBands,
      wave: player.wave,
      beat: detectBeat(now),
    };
  }

  MR.analyser = {
    attach: attach,
    detach: detach,
    read: read,
    size: SPECTRUM_SIZE,
    get isAttached() { return Boolean(player.analyserNode); },
  };
})(window);
