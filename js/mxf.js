// Lector MXF mínimo para DCPs (SMPTE e Interop).
//
// Lee solo lo necesario con File.slice(): las partition packs, el RIP (Random
// Index Pack), los metadatos de cabecera (para resolución, canales, etc.) y
// los index table segments. Con eso sabe en qué byte empieza cada fotograma
// sin cargar nunca el archivo entero (los MXF de un largo pesan cientos de GB).
//
// Referencias: SMPTE ST 377-1 (MXF), ST 429-3/4/6 (DCP), ST 429-5 (Timed Text).

const MAX_META = 8 * 1024 * 1024;      // tope de metadatos de cabecera que leemos
const MAX_INDEX = 256 * 1024 * 1024;   // tope de índice (un largo de 3 h son ~3 MB)

/** Lee [off, off+len) del archivo como Uint8Array. */
export async function readBytes(file, off, len) {
  const end = Math.min(file.size, off + len);
  if (end <= off) return new Uint8Array(0);
  return new Uint8Array(await file.slice(off, end).arrayBuffer());
}

const hex = (b, s = 0, e = b.length) => Array.from(b.subarray(s, e), x => x.toString(16).padStart(2, '0')).join('');

/** Compara una clave con un prefijo hexadecimal ignorando el byte 7 (versión del registro). */
function keyMatch(buf, pos, prefix) {
  const n = prefix.length / 2;
  for (let i = 0; i < n; i++) {
    if (i === 7) continue;
    if (buf[pos + i] !== parseInt(prefix.substr(i * 2, 2), 16)) return false;
  }
  return true;
}

const PARTITION = '060e2b34020501010d01020101';
const PRIMER = '060e2b34020501010d01020101050100';
const RIP = '060e2b34020501010d01020101110100';
const INDEX = '060e2b34025301010d01020101100100';
const FILL = '060e2b34010101010301021001';
const CRYPT = '060e2b34020401010d010301027e0100';
const LOCALSET = '060e2b3402530101';
const CRYPTO_CTX = '060e2b34025301010d01040102020000';

/** ¿Es un KLV de esencia (imagen, sonido, timed text...)? 06 0e 2b 34 01 02 01 xx 0d 01 03 01 */
function isEssenceKey(b, p) {
  return b[p] === 0x06 && b[p + 1] === 0x0e && b[p + 2] === 0x2b && b[p + 3] === 0x34 &&
    b[p + 4] === 0x01 && b[p + 5] === 0x02 && b[p + 8] === 0x0d && b[p + 9] === 0x01 &&
    b[p + 10] === 0x03 && b[p + 11] === 0x01;
}
function isCryptKey(b, p) { return keyMatch(b, p, CRYPT); }
function isFillKey(b, p) { return keyMatch(b, p, FILL); }
function isPartitionKey(b, p) { return keyMatch(b, p, PARTITION) && b[p + 13] >= 2 && b[p + 13] <= 4; }

/** Lee la longitud BER que empieza en p. Devuelve [longitud, bytes usados]. */
function readBER(b, p) {
  const first = b[p];
  if (first < 0x80) return [first, 1];
  const n = first & 0x7f;
  if (n === 0 || n > 8) throw new Error('Longitud BER no válida');
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[p + 1 + i];
  return [v, 1 + n];
}

/** Lee un KL (clave + longitud) en una posición del archivo. */
async function readKL(file, off) {
  const b = await readBytes(file, off, 25);
  if (b.length < 17) return null;
  const [len, n] = readBER(b, 16);
  return { key: b.subarray(0, 16), len, hdr: 16 + n, off, total: 16 + n + len, buf: b };
}

const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const u64 = (b, p) => u32(b, p) * 4294967296 + u32(b, p + 4);
const i64 = (b, p) => { const hi = u32(b, p); return hi >= 0x80000000 ? -((~hi >>> 0) * 4294967296 + (~u32(b, p + 4) >>> 0) + 1) : hi * 4294967296 + u32(b, p + 4); };

function parsePartition(b, p, len) {
  // b[p] = primer byte del valor de la partition pack
  const v = {
    major: u16(b, p), minor: u16(b, p + 2), kag: u32(b, p + 4),
    thisPartition: u64(b, p + 8), previousPartition: u64(b, p + 16), footerPartition: u64(b, p + 24),
    headerByteCount: u64(b, p + 32), indexByteCount: u64(b, p + 40), indexSID: u32(b, p + 48),
    bodyOffset: u64(b, p + 52), bodySID: u32(b, p + 60), op: hex(b, p + 64, p + 80), essenceContainers: []
  };
  if (len >= 88) {
    const n = u32(b, p + 80), sz = u32(b, p + 84);
    for (let i = 0; i < n && 88 + (i + 1) * sz <= len; i++) v.essenceContainers.push(hex(b, p + 88 + i * sz, p + 88 + (i + 1) * sz));
  }
  return v;
}

/** Tipo de partición a partir de la clave: header/body/footer y si es generic stream. */
function partitionKind(key) {
  const k = key[13], s = key[14];
  return { kind: k === 2 ? 'header' : k === 3 ? (s === 0x11 ? 'generic' : 'body') : 'footer', closed: s === 2 || s === 4, complete: s === 3 || s === 4 };
}

export class MXFReader {
  constructor(file, name = file.name) {
    this.file = file;
    this.name = name;
    this.partitions = [];      // { off, kind, pack, essenceStart }
    this.info = {};            // datos de los descriptores
    this.offsets = null;       // Float64Array con StreamOffset de cada edit unit (VBR)
    this.eubc = 0;             // EditUnitByteCount (CBR)
    this.indexStart = 0;
    this.encrypted = false;
    this.essenceKey = null;
    this.scanned = false;
  }

  /** Abre el MXF: partitions, metadatos e índice. */
  async open(onProgress) {
    const f = this.file;
    // 1) Header partition (con posible run-in de hasta 64 KB)
    const head = await readBytes(f, 0, 65536);
    let hp = -1;
    for (let i = 0; i + 16 <= head.length; i++) {
      if (head[i] === 0x06 && head[i + 1] === 0x0e && keyMatch(head, i, PARTITION) && head[i + 13] === 2) { hp = i; break; }
    }
    if (hp < 0) throw new Error('No parece un archivo MXF (no hay header partition)');
    this.runIn = hp;
    const [hlen, hn] = readBER(head, hp + 16);
    const headerPack = parsePartition(head, hp + 16 + hn, hlen);
    this.headerPack = headerPack;
    this.op = headerPack.op;

    // 2) Lista de particiones: RIP o cadena desde el footer
    let offs = await this._readRIP();
    if (!offs) offs = await this._walkPartitionChain(headerPack);
    if (!offs) offs = [0];
    offs = [...new Set(offs)].sort((a, b) => a - b);

    // 3) Cada partición: pack, metadatos, índice, inicio de esencia
    const segs = [];
    for (const po of offs) {
      const off = po + this.runIn;
      const kl = await readKL(f, off);
      if (!kl || !isPartitionKey(kl.buf, 0)) continue;
      const pb = await readBytes(f, off + kl.hdr, kl.len);
      const pack = parsePartition(pb, 0, kl.len);
      const part = { off, ...partitionKind(kl.key), pack, essenceStart: null };
      let pos = off + kl.total;
      pos = await this._skipFill(pos);
      if (pack.headerByteCount > 0) {
        if (!this.metaParsed) {
          const mb = await readBytes(f, pos, Math.min(pack.headerByteCount, MAX_META));
          this._parseMetadata(mb);
          this.metaParsed = true;
        }
        pos += pack.headerByteCount;
        pos = await this._skipFill(pos);
      }
      if (pack.indexByteCount > 0) {
        const ib = await readBytes(f, pos, Math.min(pack.indexByteCount, MAX_INDEX));
        this._parseIndex(ib, segs);
        pos += pack.indexByteCount;
      }
      if (pack.bodySID !== 0) {
        part.essenceStart = await this._findEssenceStart(pos, part.kind === 'generic');
      }
      this.partitions.push(part);
    }
    // 4) Índice consolidado
    this._buildIndex(segs);
    // 5) Comprobación: el fotograma 0 tiene que caer en un KLV de esencia. Si no, recorremos.
    const ok = await this._checkIndex();
    if (!ok) await this.scan(onProgress);
    return this;
  }

  get bodyParts() {
    return this.partitions.filter(p => p.pack.bodySID !== 0 && p.kind !== 'generic' && p.essenceStart != null)
      .sort((a, b) => a.pack.bodyOffset - b.pack.bodyOffset);
  }

  /** Número de edit units (fotogramas) del archivo. */
  get duration() {
    if (this.offsets) return this.offsets.length;
    if (this.eubc && this.indexDuration) return this.indexDuration;
    return this.info.containerDuration || 0;
  }

  async _readRIP() {
    const f = this.file;
    if (f.size < 40) return null;
    const tail = await readBytes(f, f.size - 4, 4);
    const len = u32(tail, 0);
    if (len < 20 || len > 1 << 20 || len > f.size) return null;
    const b = await readBytes(f, f.size - len, len);
    if (!keyMatch(b, 0, RIP)) return null;
    const [vlen, n] = readBER(b, 16);
    const out = [];
    for (let p = 16 + n; p + 12 <= 16 + n + vlen - 4; p += 12) out.push(u64(b, p + 4));
    return out.length ? out : null;
  }

  async _walkPartitionChain(headerPack) {
    if (!headerPack.footerPartition) return null;
    const out = [0];
    let off = headerPack.footerPartition, guard = 0;
    while (off && guard++ < 100000) {
      out.push(off);
      const kl = await readKL(this.file, off + this.runIn);
      if (!kl || !isPartitionKey(kl.buf, 0)) break;
      const pb = await readBytes(this.file, off + this.runIn + kl.hdr, 32);
      const prev = u64(pb, 16);
      if (prev >= off) break;
      off = prev;
    }
    return out;
  }

  async _skipFill(pos) {
    for (let i = 0; i < 8; i++) {
      const kl = await readKL(this.file, pos);
      if (!kl || !isFillKey(kl.buf, 0)) return pos;
      pos += kl.total;
    }
    return pos;
  }

  /** Desde pos, salta relleno, metadatos e índices hasta el primer KLV de esencia. */
  async _findEssenceStart(pos, generic) {
    for (let i = 0; i < 4096; i++) {
      const kl = await readKL(this.file, pos);
      if (!kl) return null;
      const b = kl.buf;
      if (generic) {
        if (!isFillKey(b, 0)) return pos;
      } else if (isEssenceKey(b, 0) || isCryptKey(b, 0)) {
        if (!this.essenceKey) this.essenceKey = hex(b, 0, 16);
        if (isCryptKey(b, 0)) this.encrypted = true;
        return pos;
      }
      if (isPartitionKey(b, 0)) return null;
      pos += kl.total;
    }
    return null;
  }

  /** Recorre los sets locales de los metadatos de cabecera y apunta lo que interesa. */
  _parseMetadata(b) {
    const info = this.info;
    let p = 0;
    while (p + 17 <= b.length) {
      if (!(b[p] === 0x06 && b[p + 1] === 0x0e && b[p + 2] === 0x2b && b[p + 3] === 0x34)) break;
      let len, n;
      try { [len, n] = readBER(b, p + 16); } catch (e) { break; }
      const v = p + 16 + n, end = Math.min(b.length, v + len);
      if (keyMatch(b, p, CRYPTO_CTX)) this.encrypted = true;
      if (keyMatch(b, p, LOCALSET)) {
        const setType = b[p + 13];   // 0x29 RGBA, 0x28 CDCI, 0x48 Wave, 0x64 Timed Text...
        let q = v;
        while (q + 4 <= end) {
          const tag = u16(b, q), l = u16(b, q + 2), d = q + 4;
          if (d + l > end) break;
          switch (tag) {
            case 0x3203: if (l >= 4) info.storedWidth = u32(b, d); break;
            case 0x3202: if (l >= 4) info.storedHeight = u32(b, d); break;
            case 0x3001: if (l >= 8) info.sampleRate = [u32(b, d), u32(b, d + 4)]; break;
            case 0x3002: if (l >= 8) info.containerDuration = i64(b, d); break;
            case 0x320e: if (l >= 8) info.aspectRatio = [u32(b, d), u32(b, d + 4)]; break;
            case 0x3d03: if (l >= 8) info.audioSamplingRate = u32(b, d) / (u32(b, d + 4) || 1); break;
            case 0x3d07: if (l >= 4) info.channelCount = u32(b, d); break;
            case 0x3d01: if (l >= 4) info.quantizationBits = u32(b, d); break;
            case 0x3d0a: if (l >= 2) info.blockAlign = u16(b, d); break;
          }
          q = d + l;
        }
        if (setType === 0x29 || setType === 0x28) info.pictureDescriptor = true;
        if (setType === 0x48 || setType === 0x47) info.soundDescriptor = true;
        if (setType === 0x64) info.timedTextDescriptor = true;
        if (setType === 0x63) info.stereoscopic = true;
      }
      p = v + len;
    }
  }

  _parseIndex(b, segs) {
    let p = 0;
    while (p + 17 <= b.length) {
      let len, n;
      try { [len, n] = readBER(b, p + 16); } catch (e) { break; }
      const v = p + 16 + n, end = Math.min(b.length, v + len);
      if (keyMatch(b, p, INDEX)) {
        const seg = { start: 0, duration: 0, eubc: 0, entries: null, entryLen: 0, editRate: null };
        let q = v;
        while (q + 4 <= end) {
          const tag = u16(b, q), l = u16(b, q + 2), d = q + 4;
          if (d + l > end) break;
          switch (tag) {
            case 0x3f0b: seg.editRate = [u32(b, d), u32(b, d + 4)]; break;
            case 0x3f0c: seg.start = i64(b, d); break;
            case 0x3f0d: seg.duration = i64(b, d); break;
            case 0x3f05: seg.eubc = u32(b, d); break;
            case 0x3f06: seg.indexSID = u32(b, d); break;
            case 0x3f07: seg.bodySID = u32(b, d); break;
            case 0x3f0a: {
              const cnt = u32(b, d), el = u32(b, d + 4);
              const arr = new Float64Array(cnt);
              for (let i = 0; i < cnt && d + 8 + i * el + 11 <= d + l; i++) arr[i] = u64(b, d + 8 + i * el + 3);
              seg.entries = arr; seg.entryLen = el;
              break;
            }
          }
          q = d + l;
        }
        segs.push(seg);
      } else if (!isFillKey(b, p)) {
        // otra cosa dentro del índice: la saltamos
      }
      p = v + len;
    }
  }

  _buildIndex(segs) {
    if (!segs.length) return;
    this.editRate = segs[0].editRate;
    const cbr = segs.find(s => s.eubc > 0);
    const vbr = segs.filter(s => s.entries && s.entries.length);
    if (vbr.length) {
      let total = 0;
      for (const s of vbr) total = Math.max(total, s.start + s.entries.length);
      const arr = new Float64Array(total).fill(-1);
      for (const s of vbr) arr.set(s.entries, s.start);
      // si quedan huecos el índice está incompleto
      if (arr.indexOf(-1) === -1) this.offsets = arr;
    } else if (cbr) {
      this.eubc = cbr.eubc;
      this.indexDuration = segs.reduce((m, s) => Math.max(m, s.start + s.duration), 0);
    }
  }

  /** Byte del archivo donde empieza el KLV de la edit unit n. */
  locate(n) {
    let so;
    if (this.offsets) {
      if (n < 0 || n >= this.offsets.length) return null;
      so = this.offsets[n];
      if (this.scanned) return so;       // tras el recorrido guardamos posiciones absolutas
    } else if (this.eubc) {
      so = n * this.eubc;
    } else return null;
    const parts = this.bodyParts;
    let part = null;
    for (const p of parts) if (p.pack.bodyOffset <= so) part = p;
    if (!part) return null;
    return part.essenceStart + (so - part.pack.bodyOffset);
  }

  async _checkIndex() {
    if (!this.offsets && !this.eubc) return false;
    const pos = this.locate(0);
    if (pos == null) return false;
    const kl = await readKL(this.file, pos);
    if (!kl) return false;
    return isEssenceKey(kl.buf, 0) || isCryptKey(kl.buf, 0);
  }

  /** Recorrido lineal de KLVs (solo si no hay índice). Lee solo las cabeceras. */
  async scan(onProgress) {
    const parts = this.bodyParts;
    const out = [];
    let pos = parts.length ? parts[0].essenceStart : await this._findEssenceStart(this.runIn, false);
    if (pos == null) throw new Error('No se encuentra la esencia dentro del MXF');
    const f = this.file;
    let key = null, lastReport = 0;
    while (pos < f.size) {
      const kl = await readKL(f, pos);
      if (!kl) break;
      const b = kl.buf;
      if (isEssenceKey(b, 0) || isCryptKey(b, 0)) {
        const k = hex(b, 0, 16);
        if (!key) key = k;
        if (k === key) out.push(pos);
        if (isCryptKey(b, 0)) this.encrypted = true;
      } else if (isPartitionKey(b, 0) && b[13] === 4) {
        break;   // footer
      }
      pos += kl.total;
      if (onProgress && pos - lastReport > 64 * 1024 * 1024) { lastReport = pos; onProgress(pos / f.size); }
    }
    this.offsets = Float64Array.from(out);
    this.scanned = true;
    this.essenceKey = key;
  }

  /**
   * Lee el valor del KLV de la edit unit n.
   * Devuelve { data, key, encrypted }. Si está encriptado, data es el triplete.
   */
  async readUnit(n) {
    const pos = this.locate(n);
    if (pos == null) throw new Error('Fotograma ' + n + ' fuera del archivo');
    // Si sabemos dónde empieza el siguiente, lo leemos todo de una vez.
    let guess = 0;
    if (this.offsets && n + 1 < this.offsets.length) guess = this.offsets[n + 1] - this.offsets[n];
    else if (this.eubc) guess = this.eubc;
    let b = guess > 25 && guess < 512 * 1024 * 1024 ? await readBytes(this.file, pos, guess) : await readBytes(this.file, pos, 25);
    if (b.length < 17) throw new Error('Fin de archivo inesperado');
    const [len, nb] = readBER(b, 16);
    const hdr = 16 + nb;
    const encrypted = isCryptKey(b, 0);
    if (!isEssenceKey(b, 0) && !encrypted) throw new Error('El índice apunta a algo que no es esencia (fotograma ' + n + ')');
    if (b.length < hdr + len) b = await readBytes(this.file, pos, hdr + len);
    return { data: b.subarray(hdr, hdr + len), key: hex(b, 0, 16), encrypted, pos };
  }

  /**
   * Lee varias edit units seguidas (para el sonido). Devuelve un array de Uint8Array.
   * En CBR van contiguas, así que se lee un solo trozo.
   */
  async readUnits(n, count) {
    const out = [];
    const first = this.locate(n);
    const last = this.locate(n + count - 1);
    if (first == null || last == null) {
      for (let i = 0; i < count; i++) {
        try { out.push((await this.readUnit(n + i)).data); } catch (e) { break; }
      }
      return out;
    }
    const endKL = await readKL(this.file, last);
    const b = await readBytes(this.file, first, last - first + endKL.total);
    let p = 0;
    while (p + 17 <= b.length && out.length < count) {
      const [len, nb] = readBER(b, p + 16);
      if (isEssenceKey(b, p)) out.push(b.subarray(p + 16 + nb, p + 16 + nb + len));
      else if (isCryptKey(b, p)) { this.encrypted = true; out.push(null); }
      p += 16 + nb + len;
    }
    return out;
  }

  /** Datos de las particiones "generic stream" (fuentes y PNG de los subtítulos SMPTE). */
  async readGenericStreams() {
    const out = [];
    for (const p of this.partitions) {
      if (p.kind !== 'generic' || p.essenceStart == null) continue;
      const kl = await readKL(this.file, p.essenceStart);
      if (!kl || kl.len > 64 * 1024 * 1024) continue;
      const b = await readBytes(this.file, p.essenceStart + kl.hdr, kl.len);
      out.push({ bodySID: p.pack.bodySID, data: b });
    }
    return out;
  }
}

/** Si el valor es un triplete encriptado (SMPTE 429-6), devuelve la clave de la esencia original. */
export function cryptSourceKey(v) {
  try {
    let p = 0;
    const items = [];
    for (let i = 0; i < 4; i++) {
      const [l, n] = readBER(v, p);
      items.push(v.subarray(p + n, p + n + l));
      p += n + l;
    }
    return hex(items[2]);
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- JPEG 2000

/** Lee la cabecera SIZ de un codestream J2K: tamaño, componentes, bits y perfil. */
export function parseJ2KHeader(b) {
  if (!(b[0] === 0xff && b[1] === 0x4f && b[2] === 0xff && b[3] === 0x51)) return null;
  const p = 4;
  const rsiz = u16(b, p + 2);
  const xsiz = u32(b, p + 4), ysiz = u32(b, p + 8), xo = u32(b, p + 12), yo = u32(b, p + 16);
  const csiz = u16(b, p + 36);
  const bits = (b[p + 38] & 0x7f) + 1;
  // Buscamos COD para saber cuántos niveles de descomposición tiene
  let q = p + u16(b, p), levels = null;
  for (let i = 0; i < 64 && q + 4 < b.length; i++) {
    const m = u16(b, q), l = u16(b, q + 2);
    if (m === 0xff52) { levels = b[q + 2 + 2 + 5]; break; }
    if (m === 0xff90 || m === 0xff93) break;
    q += 2 + l;
  }
  return { width: xsiz - xo, height: ysiz - yo, components: csiz, bits, rsiz, levels };
}

/** Nombre del perfil J2K (Rsiz). */
export function j2kProfileName(rsiz) {
  const names = { 0: 'J2K Part 1 (sin perfil de cine)', 3: 'DCI 2K', 4: 'DCI 4K', 5: 'DCI 2K escalable', 6: 'DCI 4K escalable', 7: 'DCI LTS' };
  return names[rsiz & 0xff] || ('Rsiz 0x' + rsiz.toString(16));
}
