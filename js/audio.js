// Sonido: lectura del MXF de audio (PCM 24 bits, normalmente 48 kHz) y escucha con Web Audio.

import { MXFReader } from './mxf.js';

/**
 * Mezcla a estéreo: L/R directos, C a −3 dB a los dos lados, surround a −3 dB
 * en su lado y traseros (BsL/BsR) a −6 dB. LFE, HI, VI, sincronismo, etc. no entran.
 */
const DOWNMIX = {
  L: [1, 0], R: [0, 1], C: [0.7071, 0.7071],
  Ls: [0.7071, 0], Rs: [0, 0.7071], Lss: [0.7071, 0], Rss: [0, 0.7071],
  BsL: [0.5, 0], BsR: [0, 0.5], Lrs: [0.5, 0], Rrs: [0, 0.5], Lc: [0.7071, 0], Rc: [0, 0.7071],
  M1: [0.7071, 0.7071], M: [0.7071, 0.7071], Mono: [0.7071, 0.7071]
};

export class SoundReel {
  constructor(asset) {
    this.asset = asset;
    this.reader = null;
  }
  async open() {
    if (this.reader) return this.reader;
    const r = new MXFReader(this.asset.file);
    await r.open();
    this.reader = r;
    const inf = r.info;
    this.rate = inf.audioSamplingRate || 48000;
    this.bits = inf.quantizationBits || 24;
    const er = this.asset.editRate || [24, 1];
    this.samplesPerUnit = Math.round(this.rate * er[1] / er[0]);
    this.channels = inf.channelCount || 0;
    if (!this.channels && r.eubc) {
      // sin descriptor: lo deducimos del tamaño de cada edit unit
      const u = await r.readUnit(0);
      this.channels = Math.round(u.data.length / (3 * this.samplesPerUnit));
    }
    this.encrypted = r.encrypted;
    return r;
  }

  /** Lee `count` edit units desde `unit` → Float32Array[] (una por canal). */
  async read(unit, count) {
    await this.open();
    const units = await this.reader.readUnits(unit, count);
    const ch = this.channels, bps = Math.round(this.bits / 8) || 3, spu = this.samplesPerUnit;
    const out = Array.from({ length: ch }, () => new Float32Array(spu * count));
    let s = 0;
    for (const u of units) {
      if (!u) { s += spu; continue; }        // encriptado: silencio
      const n = Math.floor(u.length / (bps * ch));
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < ch; c++) {
          const p = (i * ch + c) * bps;
          let v;
          if (bps === 3) { v = (u[p] | (u[p + 1] << 8) | (u[p + 2] << 16)); if (v & 0x800000) v |= ~0xffffff; v /= 8388608; }
          else if (bps === 2) { v = (u[p] | (u[p + 1] << 8)); if (v & 0x8000) v |= ~0xffff; v /= 32768; }
          else { v = (u[p] | (u[p + 1] << 8) | (u[p + 2] << 16) | (u[p + 3] << 24)) / 2147483648; }
          out[c][s + i] = v;
        }
      }
      s += spu;
    }
    return out;
  }
}

export class AudioOut {
  constructor() {
    this.ctx = null;
    this.src = null;
    this.gain = null;
    this.volume = 0.8;
  }
  ensure() {
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new C({ sampleRate: 48000 }); } catch (e) { this.ctx = new C(); }
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }

  /**
   * Reproduce los canales. mode: 'stereo' (mezcla) o el número de un canal (se oye por los dos lados).
   * Devuelve { startTime, duration } en tiempo del AudioContext.
   */
  play(chans, labels, rate, mode, onEnded) {
    this.stop();
    const ctx = this.ensure();
    const len = chans.length ? chans[0].length : 0;
    if (!len) return null;
    const buf = ctx.createBuffer(2, len, rate);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    if (mode === 'stereo') {
      chans.forEach((d, c) => {
        const k = DOWNMIX[labels[c]];
        if (!k) return;
        for (let i = 0; i < len; i++) { L[i] += d[i] * k[0]; R[i] += d[i] * k[1]; }
      });
      // si la mezcla satura, bajamos el conjunto (no hay limitador)
      let peak = 0;
      for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      if (peak > 1) { const g = 1 / peak; for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; } }
    } else {
      const d = chans[mode];
      if (d) { L.set(d); R.set(d); }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.onended = () => { if (this.src === src) { this.src = null; onEnded && onEnded(); } };
    const startTime = ctx.currentTime + 0.05;
    src.start(startTime);
    this.src = src;
    return { startTime, duration: len / rate };
  }

  stop() {
    if (this.src) { const s = this.src; this.src = null; try { s.stop(); } catch (e) { /* ya parado */ } }
  }
  get playing() { return !!this.src; }
}

/** Nivel RMS y pico de cada canal en dBFS (para ver qué canales tienen señal). */
export function levels(chans) {
  return chans.map(d => {
    let s = 0, pk = 0;
    for (let i = 0; i < d.length; i++) { const v = d[i]; s += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
    const rms = Math.sqrt(s / (d.length || 1));
    return { rms: rms > 0 ? 20 * Math.log10(rms) : -Infinity, peak: pk > 0 ? 20 * Math.log10(pk) : -Infinity };
  });
}
