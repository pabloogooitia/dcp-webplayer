// Worker de decodificación JPEG 2000 (OpenJPEG compilado a WebAssembly).
//
// Recibe el codestream de un fotograma, lo decodifica (a resolución completa o
// con niveles de resolución reducidos) y convierte el color X'Y'Z' (gamma 2.6)
// del DCP a sRGB. Devuelve un RGBA de 8 bits listo para pintar en un canvas.
//
// GitHub Pages no permite las cabeceras COOP/COEP, así que no hay hilos WASM:
// cada worker tiene su propia instancia del decodificador y el player usa varios.

/* global OpenJPEGWASM */
importScripts('../vendor/openjpeg/openjpegwasm_decode.js');

const ready = OpenJPEGWASM({
  locateFile: f => new URL('../vendor/openjpeg/' + f, self.location.href).href,
  print() {}, printErr() {}       // OpenJPEG escribe [INFO] en cada fotograma
});
let decoder = null;

// ---------------------------------------------------------------- color

// DCI: XYZ = (CV / 4095)^2.6 · 52.37 / 48 (blanco de referencia 48 cd/m²)
// Luego XYZ → RGB lineal (primarios sRGB/Rec.709, D65) y codificación sRGB.
const XYZ_TO_SRGB = [
  3.2404542, -1.5371385, -0.4985314,
  -0.9692660, 1.8760108, 0.0415560,
  0.0556434, -0.2040259, 1.0572252
];
const LUT_IN = new Float32Array(4096);
for (let i = 0; i < 4096; i++) LUT_IN[i] = Math.pow(i / 4095, 2.6) * (52.37 / 48);
const OUT_N = 4096;
const LUT_OUT = new Uint8Array(OUT_N + 1);
for (let i = 0; i <= OUT_N; i++) {
  const v = i / OUT_N;
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  LUT_OUT[i] = Math.round(Math.max(0, Math.min(1, s)) * 255);
}

function toRGBA(src, w, h, comps, bits, mode) {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const shift = bits > 12 ? bits - 12 : 0, up = bits < 12 ? 12 - bits : 0;
  const m = XYZ_TO_SRGB;
  if (comps < 3) {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = (src[i * comps] >> shift) << up;
      const g = mode === 'raw' ? v >> 4 : LUT_OUT[Math.min(OUT_N, (Math.min(1, LUT_IN[v]) * OUT_N) | 0)];
      out[j] = out[j + 1] = out[j + 2] = g; out[j + 3] = 255;
    }
    return out;
  }
  if (mode === 'raw') {
    // Sin conversión: X'Y'Z' tal cual (verdoso). Útil para comprobar.
    for (let i = 0, k = 0, j = 0; i < n; i++, k += comps, j += 4) {
      out[j] = ((src[k] >> shift) << up) >> 4; out[j + 1] = ((src[k + 1] >> shift) << up) >> 4;
      out[j + 2] = ((src[k + 2] >> shift) << up) >> 4; out[j + 3] = 255;
    }
    return out;
  }
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  for (let i = 0, k = 0, j = 0; i < n; i++, k += comps, j += 4) {
    const X = LUT_IN[(src[k] >> shift) << up], Y = LUT_IN[(src[k + 1] >> shift) << up], Z = LUT_IN[(src[k + 2] >> shift) << up];
    let r = m0 * X + m1 * Y + m2 * Z, g = m3 * X + m4 * Y + m5 * Z, b = m6 * X + m7 * Y + m8 * Z;
    r = r < 0 ? 0 : r > 1 ? 1 : r; g = g < 0 ? 0 : g > 1 ? 1 : g; b = b < 0 ? 0 : b > 1 ? 1 : b;
    out[j] = LUT_OUT[(r * OUT_N) | 0]; out[j + 1] = LUT_OUT[(g * OUT_N) | 0]; out[j + 2] = LUT_OUT[(b * OUT_N) | 0]; out[j + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------- mensajes

self.onmessage = async ev => {
  const { id, data, level = 0, mode = 'srgb' } = ev.data;
  try {
    const mod = await ready;
    if (!decoder) decoder = new mod.J2KDecoder();
    const t0 = performance.now();
    const bytes = new Uint8Array(data);
    decoder.getEncodedBuffer(bytes.length).set(bytes);
    decoder.readHeader();
    const head = decoder.getFrameInfo();
    const maxLevel = decoder.getNumDecompositions();
    const lvl = Math.max(0, Math.min(level, maxLevel));
    if (lvl > 0) decoder.decodeSubResolution(lvl, 0); else decoder.decode();
    const info = decoder.getFrameInfo();
    const raw = decoder.getDecodedBuffer();
    const comps = info.componentCount, bits = info.bitsPerSample;
    const bps = bits > 8 ? 2 : 1;
    const samples = raw.length / bps;
    // A resolución reducida el tamaño es ceil(W / 2^nivel) (los DCP no tienen offset de imagen)
    let w = Math.ceil(info.width / (1 << lvl)), h = Math.ceil(info.height / (1 << lvl));
    if (w * h * comps !== samples) { w = info.width >> lvl; h = info.height >> lvl; }
    if (w * h * comps !== samples) throw new Error('Tamaño decodificado inesperado');
    const src = bps === 2 ? new Uint16Array(raw.buffer, raw.byteOffset, samples) : raw;
    const t1 = performance.now();
    const rgba = toRGBA(src, w, h, comps, bits, mode);
    const t2 = performance.now();
    self.postMessage({ id, ok: true, width: w, height: h, fullWidth: info.width, fullHeight: info.height, level: lvl, maxLevel,
      comps, bits, reversible: decoder.getIsReversible(), rgba: rgba.buffer, decodeMs: t1 - t0, colorMs: t2 - t1 }, [rgba.buffer]);
  } catch (e) {
    // si OpenJPEG falla, la instancia puede quedar en mal estado: la rehacemos
    decoder = null;
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
