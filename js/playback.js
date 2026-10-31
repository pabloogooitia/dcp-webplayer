// Reproducción continua (fase 2): precarga de fotogramas por delante, varios
// workers decodificando a la vez, sonido por trozos programados en Web Audio y
// la imagen sincronizada con el reloj del sonido.
//
// No hay decodificación JPEG 2000 por hardware en los navegadores (WebCodecs no
// la soporta), así que la fluidez depende de la resolución reducida, de cuántos
// núcleos tenga el ordenador y de ir siempre unos segundos por delante.

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BATCH = 8;                  // fotogramas que se leen del disco de una vez
const BUFFER_BYTES = 192 * 1024 * 1024;

export class Playback {
  /**
   * o: { pool, cpl, fps, locate(g), getReader(i), level, auto, minLevel, maxLevel, color,
   *      draw(res, g), onTick(g, stats), onEnd(g), readAudio(g, n) → {chans, labels, rate} | null,
   *      audioOut, audioMode(), onLevels(lv, labels) }
   */
  constructor(o) {
    Object.assign(this, o);
    this.buffer = new Map();
    this.running = false;
    this.inflight = 0;
  }

  get frameBytes() {
    const w = this.width || 2048, h = this.height || 1080;
    return Math.ceil(w / (1 << this.level)) * Math.ceil(h / (1 << this.level)) * 4;
  }
  get ahead() {
    // fotogramas por delante: entre 1 y 4 segundos, según la memoria que ocupen
    return Math.max(Math.round(this.fps), Math.min(Math.round(this.fps * 4), Math.floor(BUFFER_BYTES / this.frameBytes)));
  }

  async start(g0) {
    this.running = true;
    this.g0 = g0; this.cur = g0; this.next = g0; this.end = this.cpl.duration - 1;
    this.drawn = 0; this.lastDrawn = -1;
    this.win = { t: performance.now(), drawn: 0, frames: 0, clean: 0 };
    this.fetchLoop();
    // Precarga: esperamos a tener ~1 s seguido (o lo que quede) antes de arrancar
    const need = Math.min(Math.round(this.fps), this.end - g0 + 1);
    const t0 = performance.now();
    while (this.running && this.readyFrom(g0) < need && performance.now() - t0 < 6000) {
      this.onTick(g0, this.stats('Precargando'));
      await sleep(40);
    }
    if (!this.running) return;
    // Reloj: el del sonido si hay; si no, el del navegador
    this.audioNext = g0;
    this.hasAudio = !!this.readAudio && this.hasSound;
    if (this.hasAudio) {
      const ctx = this.audioOut.ensure();
      this.startTime = ctx.currentTime + 0.25;
      await this.scheduleAudio();
    } else {
      this.startPerf = performance.now() + 100;
    }
    if (!this.running) return;
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.audioOut && this.audioOut.stop();
    this.pool.clearQueue();
    this.buffer.clear();
  }

  readyFrom(g) { let n = 0; while (this.buffer.has(g + n)) n++; return n; }

  clock() {
    if (this.hasAudio) return this.audioOut.ctx.currentTime - this.startTime;
    return (performance.now() - this.startPerf) / 1000;
  }

  stats(state) {
    const total = Math.max(1, this.cur - this.g0 + 1);
    const lost = state === 'Precargando' ? 0 : Math.max(0, total - this.drawn);
    return { state, level: this.level, buffered: this.readyFrom(this.cur), ahead: this.ahead, lost, total, inflight: this.inflight };
  }

  /** Lee del disco por delante y manda a decodificar. */
  async fetchLoop() {
    while (this.running) {
      if (this.next < this.cur) this.next = this.cur;          // nos hemos quedado atrás: saltamos
      const ahead = this.next - this.cur;
      const slots = this.pool.size * 2 - this.inflight;
      if (this.next > this.end || ahead >= this.ahead || slots <= 0) { await sleep(10); continue; }
      const { i, reel, offset, local } = this.locate(this.next);
      const count = Math.max(1, Math.min(BATCH, reel.duration - offset, this.end - this.next + 1, this.ahead - ahead, slots));
      let units;
      try {
        const rd = await this.getReader(i);
        units = await rd.readRange(local, count);
      } catch (e) {
        console.warn('Error leyendo fotogramas', e);
        this.next += count;
        continue;
      }
      if (!this.running) return;
      const base = this.next, level = this.level;
      units.forEach((u, k) => {
        const g = base + k;
        if (!u || u.encrypted) return;
        this.inflight++;
        this.pool.decode(u.data, level, this.color)
          .then(res => { if (this.running && g >= this.cur) this.buffer.set(g, res); })
          .catch(() => {})
          .finally(() => { this.inflight--; });
      });
      this.next += count;
    }
  }

  /** Programa el sonido en trozos de 1 s hasta 2 s por delante del reloj. */
  async scheduleAudio() {
    if (this.aBusy || !this.hasAudio) return;
    this.aBusy = true;
    try {
      const ctx = this.audioOut.ctx;
      while (this.running && this.audioNext <= this.end &&
        this.startTime + (this.audioNext - this.g0) / this.fps < ctx.currentTime + 2) {
        const n = Math.min(Math.round(this.fps), this.end - this.audioNext + 1);
        const a = await this.readAudio(this.audioNext, n);
        if (!this.running) break;
        const when = this.startTime + (this.audioNext - this.g0) / this.fps;
        if (a) {
          this.audioOut.schedule(a.chans, a.labels, a.rate, this.audioMode(), when);
          this.onLevels && this.onLevels(a.chans, a.labels);
        }
        this.audioNext += n;
      }
    } catch (e) {
      console.warn('Error con el sonido', e);
    } finally { this.aBusy = false; }
  }

  tick() {
    if (!this.running) return;
    const t = this.clock();
    const g = Math.min(this.end, this.g0 + Math.max(0, Math.floor(t * this.fps)));
    if (g > this.cur) {
      this.win.frames += g - this.cur;
      for (const k of this.buffer.keys()) if (k < g) this.buffer.delete(k);
      this.cur = g;
    }
    const res = this.buffer.get(g);
    if (res && g !== this.lastDrawn) {
      this.draw(res, g);
      this.lastDrawn = g; this.drawn++; this.win.drawn++;
    }
    this.onTick(g, this.stats('Reproduciendo'));
    if (this.hasAudio) this.scheduleAudio();
    this.adapt();
    if (t * this.fps >= this.end - this.g0 + 1) {
      this.running = false;
      this.audioOut && this.audioOut.stop();
      this.onEnd(this.end);
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Calidad automática: si se pierden fotogramas, baja la resolución; si va sobrado, la sube. */
  adapt() {
    if (!this.auto) return;
    const now = performance.now();
    if (now - this.win.t < 2000) return;
    const w = this.win;
    const lostRate = w.frames ? 1 - w.drawn / w.frames : 0;
    const full = this.readyFrom(this.cur) >= this.ahead * 0.8;
    if (lostRate > 0.1 && this.level < this.maxLevel) {
      this.level++; w.clean = 0;
    } else if (lostRate === 0 && full) {
      w.clean++;
      if (w.clean >= 3 && this.level > this.minLevel) { this.level--; w.clean = 0; }
    } else w.clean = 0;
    w.t = now; w.drawn = 0; w.frames = 0;
  }
}
