// Pool de workers de decodificación. Cada worker tiene su instancia de OpenJPEG.

export class DecoderPool {
  constructor(size) {
    const hc = navigator.hardwareConcurrency || 4;
    this.size = size || Math.max(1, Math.min(6, hc - 1));   // cada worker ~50-100 MB
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(new URL('./decoder-worker.js', import.meta.url));
      w.busy = false;
      w.onmessage = ev => this._done(w, ev.data);
      w.onerror = ev => { console.error('Error en el worker', ev.message); this._done(w, { id: w.job, ok: false, error: ev.message || 'Error en el worker' }); };
      this.workers.push(w);
    }
  }

  get idle() { return this.workers.filter(w => !w.busy).length; }
  get busy() { return this.workers.length - this.idle + this.queue.length; }

  /** Decodifica un codestream. data se copia (el original no se toca). */
  decode(data, level = 0, mode = 'srgb') {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const buf = data.slice().buffer;     // copia transferible
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, data: buf, level, mode });
      this._pump();
    });
  }

  /** Quita de la cola los trabajos que aún no han empezado (p. ej. al saltar a otro sitio). */
  clearQueue() {
    for (const j of this.queue) { const p = this.pending.get(j.id); this.pending.delete(j.id); p && p.reject(new Error('cancelado')); }
    this.queue = [];
  }

  _pump() {
    for (const w of this.workers) {
      if (w.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      w.busy = true; w.job = job.id;
      w.postMessage(job, [job.data]);
    }
  }

  _done(w, msg) {
    w.busy = false;
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (p) msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
    this._pump();
  }
}
