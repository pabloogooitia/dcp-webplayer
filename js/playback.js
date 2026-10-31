// Reproducción continua (fase 2): precarga de fotogramas por delante, varios
// workers decodificando a la vez, sonido por trozos programados en Web Audio y
// la imagen sincronizada con el reloj del sonido.
//
// No hay decodificación JPEG 2000 por hardware en los navegadores (WebCodecs no
// la soporta), así que la fluidez depende de la resolución reducida, de cuántos
// núcleos tenga el ordenador y de ir siempre unos segundos por delante.

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BATCH = 8;                  // fotogramas que se leen del disco de una vez
const BUFFER_BYTES = 512 * 1024 * 1024;   // tope de memoria del búfer de imagen
const PREROLL_S = 10;             // segundos que se precargan antes de arrancar
const AHEAD_S = 12;               // segundos que se intenta tener por delante al reproducir
const PREROLL_MAX_WAIT = 45000;   // si en 45 s no se ha llenado, arranca con lo que haya

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
    // fotogramas por delante: hasta 12 s, según la memoria que ocupen (a 1/4 caben
    // de sobra; a 1/2 en 2K, unos 9 s). Nunca menos de 1 s.
    return Math.max(Math.round(this.fps), Math.min(Math.round(this.fps * AHEAD_S), Math.floor(BUFFER_BYTES / this.frameBytes)));
  }

  async start(g0) {
    this.running = true;
    this.g0 = g0; this.cur = g0; this.next = g0; this.end = this.cpl.duration - 1;
    this.drawn = 0; this.lastDrawn = -1;
    this.win = { t: performance.now(), drawn: 0, frames: 0, clean: 0, buf: null };
    this.fetchLoop();
    // Precarga: esperamos a tener 10 s seguidos (o lo que quepa en memoria, o lo
    // que quede de CPL) antes de arrancar. Tarda más en empezar, pero luego hay
    // margen para aguantar los tirones del disco o de la decodificación.
    this.need = Math.min(Math.round(this.fps * PREROLL_S), this.ahead, this.end - g0 + 1);
    const t0 = performance.now();
    while (this.running && this.readyFrom(g0) < this.need && performance.now() - t0 < PREROLL_MAX_WAIT) {
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
    return { state, fps: this.fps, level: this.level, buffered: this.readyFrom(this.cur), ahead: this.ahead,
      need: this.need, lost, total, inflight: this.inflight };
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

  /**
   * Calidad automática: si se pierden fotogramas, o si el búfer se va vaciando
   * (la decodificación no llega a tiempo real y acabaría cortándose), baja la
   * resolución; si va sobrado, la sube. Con 10 s de búfer no hay que esperar a
   * perder fotogramas para darse cuenta: basta con ver que el búfer baja.
   */
  adapt() {
    if (!this.auto) return;
    const now = performance.now();
    if (now - this.win.t < 2000) return;
    const w = this.win;
    const lostRate = w.frames ? 1 - w.drawn / w.frames : 0;
    const buf = this.readyFrom(this.cur);
    const full = buf >= this.ahead * 0.8;
    // ¿el búfer ha bajado en esta ventana (más de un cuarto de segundo) y ya está por
    // debajo de la mitad? Entonces no se llega a tiempo real y acabaría cortándose.
    const draining = w.buf !== null && w.buf - buf > this.fps * 0.25 && buf < this.ahead * 0.5;
    w.buf = buf;
    if ((lostRate > 0.1 || draining) && this.level < this.maxLevel) {
      // Este nivel no aguanta: se baja y ya no se vuelve a subir a él en esta
      // reproducción (si no, la resolución cambiaría cada pocos segundos).
      this.level++; w.clean = 0;
      this.minLevel = Math.max(this.minLevel, this.level);
    } else if (lostRate === 0 && full) {
      w.clean++;
      if (w.clean >= 3 && this.level > this.minLevel) { this.level--; w.clean = 0; }
    } else w.clean = 0;
    w.t = now; w.drawn = 0; w.frames = 0;
  }
}
