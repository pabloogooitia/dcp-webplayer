// Prueba rápida del decodificador OpenJPEG WASM en Node (solo para desarrollo).
// Uso: node tools/test-decoder.js archivo.j2c
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'vendor', 'openjpeg');
const OpenJPEG = require(path.join(dir, 'openjpegwasm_decode.js'));

(async () => {
  const m = await OpenJPEG({ locateFile: f => path.join(dir, f) });
  const d = new m.J2KDecoder();
  console.log('métodos:', Object.getOwnPropertyNames(Object.getPrototypeOf(d)).join(', '));
  const data = fs.readFileSync(process.argv[2]);
  d.getEncodedBuffer(data.length).set(data);
  d.readHeader();
  console.log('cabecera:', d.getFrameInfo());
  for (const lvl of [0, 1, 2]) {
    const t = Date.now();
    if (lvl) d.decodeSubResolution(lvl, 0); else d.decode();
    const fi = d.getFrameInfo();
    const out = d.getDecodedBuffer();
    const u16 = new Uint16Array(out.buffer, out.byteOffset, out.length / 2);
    console.log('nivel', lvl, (Date.now() - t) + ' ms', fi, out.length, Array.from(u16.slice(0, 9)),
      'px(1000,500)=', Array.from(u16.slice((500 * fi.width + 1000) * 3, (500 * fi.width + 1000) * 3 + 3)));
  }
})();
