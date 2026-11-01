// Carga de la carpeta del DCP y lectura de ASSETMAP, PKL y CPL (SMPTE e Interop).

// ---------------------------------------------------------------- archivos

/** Archivos de un <input type=file webkitdirectory> → [{ path, file }]. */
export function filesFromInput(list) {
  return Array.from(list, f => ({ path: f.webkitRelativePath || f.name, file: f }));
}

/** Archivos de un drop (carpetas incluidas, recorriendo subcarpetas). */
export async function filesFromDrop(dataTransfer) {
  const out = [];
  const items = Array.from(dataTransfer.items || []);
  const entries = items.map(it => it.webkitGetAsEntry ? it.webkitGetAsEntry() : null).filter(Boolean);
  if (!entries.length) return Array.from(dataTransfer.files || [], f => ({ path: f.name, file: f }));
  const readAll = dir => new Promise((res, rej) => {
    const r = dir.createReader(), acc = [];
    const next = () => r.readEntries(batch => { if (!batch.length) res(acc); else { acc.push(...batch); next(); } }, rej);
    next();
  });
  const fileOf = e => new Promise((res, rej) => e.file(res, rej));
  async function walk(e) {
    if (e.isFile) out.push({ path: e.fullPath.replace(/^\//, ''), file: await fileOf(e) });
    else if (e.isDirectory) for (const c of await readAll(e)) await walk(c);
  }
  for (const e of entries) await walk(e);
  return out;
}

// ---------------------------------------------------------------- XML

const parser = new DOMParser();
export function parseXML(text) {
  const doc = parser.parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML mal formado');
  return doc;
}
/** Hijos directos por nombre local (sin importar el namespace). */
export const kids = (el, name) => el ? Array.from(el.children).filter(c => c.localName === name) : [];
export const kid = (el, name) => kids(el, name)[0] || null;
export const txt = (el, name) => { const k = name ? kid(el, name) : el; return k ? k.textContent.trim() : ''; };
/** Primer descendiente con ese nombre local. */
export const desc = (el, name) => el ? (el.getElementsByTagNameNS('*', name)[0] || null) : null;
export const uuidOf = s => (s || '').trim().toLowerCase().replace(/^urn:uuid:/, '');
const num = (s, d = 0) => { const n = parseInt(s, 10); return isNaN(n) ? d : n; };
const rat = s => { const p = (s || '').trim().split(/\s+/).map(Number); return p.length === 2 && p[1] ? p : null; };

// ---------------------------------------------------------------- paquete

/**
 * Busca ASSETMAPs y monta el mapa uuid → archivo (de todos los DCP cargados a la vez,
 * así una VF puede usar los archivos de su OV si se cargan juntas).
 */
export async function loadPackages(files) {
  const byPath = new Map();
  for (const f of files) byPath.set(norm(f.path), f);
  const amFiles = files.filter(f => /^assetmap(\.xml)?$/i.test(base(f.path)));
  const assets = new Map();       // uuid → { path, file, type, size, hash, pkl }
  const packages = [];
  const warnings = [];

  for (const am of amFiles) {
    let doc;
    try { doc = parseXML(await am.file.text()); } catch (e) { warnings.push('No se puede leer ' + am.path + ': ' + e.message); continue; }
    const root = doc.documentElement;
    const smpte = /smpte-ra\.org/.test(root.namespaceURI || '');
    const dir = dirname(am.path);
    const pkg = { path: dir || '(raíz)', assetmap: am.path, amFile: am.file, standard: smpte ? 'SMPTE' : 'Interop', pkls: [], cpls: [], issuer: txt(root, 'Issuer'), creator: txt(root, 'Creator') };
    for (const a of kids(kid(root, 'AssetList'), 'Asset')) {
      const id = uuidOf(txt(a, 'Id'));
      const chunk = desc(a, 'Chunk');
      let p = txt(chunk, 'Path').replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/^\.\//, '');
      const full = norm((dir ? dir + '/' : '') + p);
      const f = byPath.get(full) || null;
      const isPkl = /true/i.test(txt(a, 'PackingList'));
      const prev = assets.get(id);
      if (!prev || (!prev.file && f)) assets.set(id, { id, path: (dir ? dir + '/' : '') + p, file: f ? f.file : null, isPkl, pkg });
      if (isPkl) pkg.pkls.push(id);
    }
    packages.push(pkg);
  }

  // PKLs: tipos, tamaños y hashes
  for (const pkg of packages) {
    for (const pid of pkg.pkls) {
      const a = assets.get(pid);
      if (!a || !a.file) { warnings.push('Falta la PKL ' + pid); continue; }
      try {
        const root = parseXML(await a.file.text()).documentElement;
        pkg.annotation = pkg.annotation || txt(root, 'AnnotationText');
        for (const x of kids(kid(root, 'AssetList'), 'Asset')) {
          const id = uuidOf(txt(x, 'Id'));
          const t = assets.get(id);
          const info = { type: txt(x, 'Type'), size: num(txt(x, 'Size')), hash: txt(x, 'Hash'), original: txt(x, 'OriginalFileName'), annotation: txt(x, 'AnnotationText') };
          if (t) Object.assign(t, info);
          else assets.set(id, { id, path: null, file: null, pkg, ...info });
        }
      } catch (e) { warnings.push('No se puede leer la PKL: ' + e.message); }
    }
  }

  // CPLs: cualquier XML cuyo elemento raíz sea CompositionPlaylist
  for (const a of assets.values()) {
    if (!a.file || !/\.xml$/i.test(a.path || '')) continue;
    if (a.type && /mxf|image|font|ttf|otf/i.test(a.type)) continue;
    const head = await a.file.slice(0, 4096).text();
    if (!/<([\w-]+:)?CompositionPlaylist[\s>]/.test(head)) continue;
    try {
      const cpl = parseCPL(parseXML(await a.file.text()), assets);
      cpl.file = a.file; cpl.path = a.path; cpl.pkg = a.pkg;
      a.pkg.cpls.push(cpl);
    } catch (e) { warnings.push('No se puede leer la CPL ' + a.path + ': ' + e.message); }
  }

  // Sin ASSETMAP: avisamos y probamos con las CPL sueltas (sin poder enlazar los MXF)
  if (!amFiles.length) {
    for (const f of files.filter(f => /\.xml$/i.test(f.path))) {
      const head = await f.file.slice(0, 4096).text();
      if (!/<([\w-]+:)?CompositionPlaylist[\s>]/.test(head)) continue;
      const pkg = { path: dirname(f.path), standard: '?', pkls: [], cpls: [] };
      const cpl = parseCPL(parseXML(await f.file.text()), assets);
      cpl.file = f.file; cpl.path = f.path; cpl.pkg = pkg;
      pkg.cpls.push(cpl); packages.push(pkg);
    }
    warnings.push('No hay ASSETMAP: no se puede saber qué archivo MXF es cada pista.');
  }
  return { packages, assets, warnings, cpls: packages.flatMap(p => p.cpls) };
}

const norm = p => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').toLowerCase();
const base = p => p.split('/').pop();
const dirname = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

// ---------------------------------------------------------------- CPL

function parseAsset(el, assets) {
  if (!el) return null;
  const id = uuidOf(txt(el, 'Id'));
  const editRate = rat(txt(el, 'EditRate')) || [24, 1];
  const intrinsic = num(txt(el, 'IntrinsicDuration'));
  const entry = num(txt(el, 'EntryPoint'), 0);
  const dur = kid(el, 'Duration') ? num(txt(el, 'Duration')) : intrinsic - entry;
  const a = assets.get(id);
  return {
    id, editRate, intrinsic, entry, duration: dur,
    keyId: uuidOf(txt(el, 'KeyId')) || null,
    hash: txt(el, 'Hash'),
    annotation: txt(el, 'AnnotationText'),
    language: txt(el, 'Language'),
    frameRate: rat(txt(el, 'FrameRate')),
    sar: txt(el, 'ScreenAspectRatio'),
    file: a && a.file ? a.file : null,
    path: a ? a.path : null,
    type: el.localName,
    dataType: txt(el, 'DataType')
  };
}

export function parseCPL(doc, assets) {
  const root = doc.documentElement;
  const ns = root.namespaceURI || '';
  const cpl = {
    id: uuidOf(txt(root, 'Id')),
    standard: /smpte-ra\.org/.test(ns) ? 'SMPTE' : /digicine\.com/.test(ns) ? 'Interop' : '?',
    title: txt(root, 'ContentTitleText'),
    annotation: txt(root, 'AnnotationText'),
    kind: txt(root, 'ContentKind'),
    issuer: txt(root, 'Issuer'),
    creator: txt(root, 'Creator'),
    issueDate: txt(root, 'IssueDate'),
    version: txt(kid(root, 'ContentVersion'), 'LabelText'),
    ratings: kids(kid(root, 'RatingList'), 'Rating').map(r => txt(r, 'Label')).filter(Boolean),
    reels: [],
    meta: {}
  };
  for (const r of kids(kid(root, 'ReelList'), 'Reel')) {
    const list = kid(r, 'AssetList');
    if (!list) continue;
    const ch = Array.from(list.children);
    const find = (...names) => ch.find(c => names.includes(c.localName));
    const pic = find('MainPicture', 'MainStereoscopicPicture');
    const reel = {
      id: uuidOf(txt(r, 'Id')),
      picture: parseAsset(pic, assets),
      sound: parseAsset(find('MainSound'), assets),
      subtitle: parseAsset(find('MainSubtitle'), assets),
      caption: parseAsset(find('MainClosedCaption', 'ClosedCaption'), assets),
      markers: parseAsset(find('MainMarkers'), assets),
      aux: ch.filter(c => c.localName === 'AuxData').map(c => parseAsset(c, assets))
    };
    if (reel.picture) reel.picture.stereo = pic.localName === 'MainStereoscopicPicture';
    // Marcadores (FFOC, LFOC, FFEC...)
    const mk = find('MainMarkers');
    if (mk) reel.markerList = kids(kid(mk, 'MarkerList'), 'Marker').map(m => ({ label: txt(m, 'Label'), offset: num(txt(m, 'Offset')) }));
    // Metadatos SMPTE (ST 429-16)
    const meta = find('CompositionMetadataAsset');
    if (meta) {
      cpl.meta.soundConfig = txt(meta, 'MainSoundConfiguration');
      cpl.meta.sampleRate = txt(meta, 'MainSoundSampleRate');
      const sa = kid(meta, 'MainPictureStoredArea'), aa = kid(meta, 'MainPictureActiveArea');
      if (sa) cpl.meta.stored = [num(txt(sa, 'Width')), num(txt(sa, 'Height'))];
      if (aa) cpl.meta.active = [num(txt(aa, 'Width')), num(txt(aa, 'Height'))];
      cpl.meta.fullTitle = txt(meta, 'FullContentTitleText');
      cpl.meta.version = txt(meta, 'VersionNumber');
    }
    if (reel.picture) cpl.reels.push(reel);
  }
  // Encriptado: cualquier pista con <KeyId>
  const enc = new Set();
  for (const r of cpl.reels) {
    if (r.picture && r.picture.keyId) enc.add('imagen');
    if (r.sound && r.sound.keyId) enc.add('sonido');
    if (r.subtitle && r.subtitle.keyId) enc.add('subtítulos');
    if (r.caption && r.caption.keyId) enc.add('subtítulos cerrados');
    for (const a of r.aux) if (a.keyId) enc.add(/0e090604/i.test(a.dataType) ? 'Atmos' : 'datos auxiliares');
  }
  cpl.encryptedTracks = [...enc];
  cpl.encrypted = enc.size > 0;
  cpl.keyCount = new Set(cpl.reels.flatMap(r => [r.picture, r.sound, r.subtitle, r.caption, ...r.aux].filter(a => a && a.keyId).map(a => a.keyId))).size;
  // Duración total en fotogramas de imagen
  let t = 0;
  for (const r of cpl.reels) { r.start = t; r.duration = r.picture.duration; t += r.duration; }
  cpl.duration = t;
  cpl.editRate = cpl.reels.length ? cpl.reels[0].picture.editRate : [24, 1];
  return cpl;
}

// ---------------------------------------------------------------- ficha

/** Formato de imagen por resolución o por ScreenAspectRatio. */
export function pictureFormat(w, h, sar) {
  let ratio = w && h ? w / h : 0;
  if (!ratio && sar) {
    const p = sar.trim().split(/\s+/).map(Number);
    ratio = p.length === 2 && p[1] ? p[0] / p[1] : p[0];
  }
  let name = '';
  if (Math.abs(ratio - 1.85) < 0.03) name = 'Flat';
  else if (Math.abs(ratio - 2.39) < 0.04) name = 'Scope';
  else if (Math.abs(ratio - 1.896) < 0.02) name = 'Full container';
  else if (ratio) name = ratio.toFixed(2) + ':1';
  return { name, ratio };
}

export function resolutionClass(w) { return w > 2048 ? '4K' : w ? '2K' : ''; }

/** Texto de sonido: 5.1 / 7.1 / canales, Atmos. */
export function soundText(cpl, channels) {
  const parts = [];
  const cfg = cpl.meta.soundConfig || '';
  const m = cfg.match(/^(\d+)\s*\//);
  if (m) {
    const k = m[1];
    parts.push(k === '51' ? '5.1' : k === '71' ? '7.1' : k === '71DS' ? '7.1 DS' : k === '20' ? '2.0' : k === '10' ? 'Mono' : k);
  } else if (/^71DS/.test(cfg)) parts.push('7.1 DS');
  if (!m && channels === 6) parts.push('5.1');            // Interop no lo dice: 6 canales es 5.1
  if (!m && channels === 8) parts.push('7.1?');
  if (channels) parts.push(channels + ' canales');
  const atmos = cpl.reels.some(r => r.aux.some(a => /0e090604/i.test(a.dataType)));
  if (atmos) parts.push('Dolby Atmos');
  return parts.join(' · ') || (cpl.reels.some(r => r.sound) ? 'Sí' : 'Sin sonido');
}

/** Nombres de canal: de MainSoundConfiguration si está; si no, el orden estándar de los DCP. */
export function channelLabels(cpl, n) {
  const std = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'HI', 'VI-N', 'Lc', 'Rc', 'BsL', 'BsR', 'DBox', 'Sync', 'Sign', '-'];
  const cfg = cpl.meta.soundConfig || '';
  const i = cfg.indexOf('/');
  let labels = i >= 0 ? cfg.slice(i + 1).split(',').map(s => s.trim()) : [];
  // Interop/7.1 sin metadatos: en 8 canales los 7.1 suelen ir L R C LFE Lss Rss Lrs Rrs; dejamos el estándar
  const out = [];
  for (let c = 0; c < n; c++) {
    // '-' en MainSoundConfiguration = canal sin uso
    out.push(labels[c] || std[c] || String(c + 1));
  }
  return out;
}

export function fmtTC(frame, fps) {
  fps = Math.round(fps) || 24;
  const f = Math.max(0, Math.floor(frame));
  const s = Math.floor(f / fps);
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f % fps)}`;
}

export function fmtDuration(frames, fps) {
  const s = Math.round(frames / (fps || 24));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (h ? h + ' h ' : '') + (h || m ? m + ' min ' : '') + sec + ' s';
}

export const kindName = k => ({
  feature: 'Largometraje', trailer: 'Tráiler', teaser: 'Teaser', advertisement: 'Publicidad', short: 'Corto',
  test: 'Prueba', rating: 'Calificación', transitional: 'Transición', policy: 'Aviso', psa: 'Aviso público', episode: 'Episodio', promo: 'Promo'
}[(k || '').toLowerCase()] || k || '—');
