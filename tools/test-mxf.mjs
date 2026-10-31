// Prueba del lector MXF en Node (solo para desarrollo).
// Uso: node tools/test-mxf.mjs archivo.mxf [...]
import { openAsBlob } from 'node:fs';
import { MXFReader, parseJ2KHeader, cryptSourceKey } from '../js/mxf.js';

for (const path of process.argv.slice(2)) {
  const blob = await openAsBlob(path);
  const r = new MXFReader(blob, path.split('/').pop());
  const t = Date.now();
  await r.open();
  console.log('\n' + r.name, (Date.now() - t) + ' ms');
  console.log(' particiones:', r.partitions.map(p => `${p.kind}@${p.off} sid=${p.pack.bodySID} es=${p.essenceStart}`).join(' | '));
  console.log(' info:', JSON.stringify(r.info), 'dur', r.duration, 'eubc', r.eubc, 'scanned', r.scanned, 'enc', r.encrypted);
  const u0 = await r.readUnit(0);
  const last = await r.readUnit(r.duration - 1);
  console.log(' unidad 0:', u0.data.length, 'bytes, clave', u0.key, '· última:', last.data.length);
  if (u0.encrypted) console.log(' encriptado, esencia original:', cryptSourceKey(u0.data));
  const j = parseJ2KHeader(u0.data);
  if (j) console.log(' J2K:', JSON.stringify(j));
  if (r.info.timedTextDescriptor || /17010b01$/.test(u0.key)) {
    console.log(' XML:', new TextDecoder().decode(u0.data).slice(0, 120).replace(/\n/g, ' '));
    const gs = await r.readGenericStreams();
    console.log(' generic streams:', gs.map(g => g.data.length));
  }
  if (r.eubc) {
    const us = await r.readUnits(10, 5);
    console.log(' readUnits(10,5):', us.map(u => u && u.length));
  }
}
