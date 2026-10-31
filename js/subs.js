// Subtítulos: SMPTE Timed Text (ST 428-7, dentro de un MXF) e Interop (XML con PNG y fuentes en la carpeta).

import { MXFReader } from './mxf.js';
import { parseXML, kids, kid, txt, uuidOf } from './dcp.js';

let fontCounter = 0;

/** Atributo sin importar mayúsculas (Valign / VAlign...). */
function attr(el, name) {
  if (!el || !el.attributes) return null;
  const n = name.toLowerCase();
  for (const a of el.attributes) if (a.localName.toLowerCase() === n) return a.value;
  return null;
}

/** Tiempo de subtítulo → segundos. SMPTE: HH:MM:SS:EE (EE en TimeCodeRate). Interop: HH:MM:SS:TTT (TTT en ticks de 4 ms). */
function parseTime(s, standard, tcRate) {
  if (s == null || s === '') return 0;
  s = String(s).trim();
  if (/^\d+$/.test(s)) return standard === 'SMPTE' ? +s / tcRate : +s / 250;   // FadeUpTime en Interop puede ser un número de ticks
  let m = s.match(/^(\d+):(\d+):(\d+)[.](\d+)$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + parseFloat('0.' + m[4]);
  m = s.match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return 0;
  const base = +m[1] * 3600 + +m[2] * 60 + +m[3];
  return base + (standard === 'SMPTE' ? +m[4] / tcRate : +m[4] / 250);
}

function argb(s, def) {
  if (!s || !/^[0-9a-f]{8}$/i.test(s)) return def;
  const a = parseInt(s.slice(0, 2), 16) / 255, r = parseInt(s.slice(2, 4), 16), g = parseInt(s.slice(4, 6), 16), b = parseInt(s.slice(6, 8), 16);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/** Estilo heredado de los <Font> anidados. */
function fontStyle(el, parent) {
  const st = { ...parent };
  const id = attr(el, 'ID') || attr(el, 'Id');
  if (id) st.fontId = id;
  const size = attr(el, 'Size'); if (size) st.size = parseFloat(size);
  const color = attr(el, 'Color'); if (color) st.color = argb(color, st.color);
  const it = attr(el, 'Italic'); if (it) st.italic = it === 'yes';
  const w = attr(el, 'Weight'); if (w) st.bold = w === 'bold';
  const u = attr(el, 'Underlined'); if (u) st.underline = u === 'yes';
  const ef = attr(el, 'Effect'); if (ef) st.effect = ef;
  const ec = attr(el, 'EffectColor'); if (ec) st.effectColor = argb(ec, st.effectColor);
  const sc = attr(el, 'Script'); if (sc) st.script = sc;
  return st;
}

const DEFAULT_STYLE = { size: 42, color: 'rgba(255,255,255,1)', italic: false, bold: false, effect: 'none', effectColor: 'rgba(0,0,0,1)' };

/** Lee los trozos de texto de un <Text>, con su estilo. */
function runsOf(el, st, out) {
  for (const n of el.childNodes) {
    if (n.nodeType === 3) {
      const t = n.nodeValue.replace(/\s+/g, ' ');
      if (t) out.push({ text: t, ...st });
    } else if (n.nodeType === 1) {
      const ln = n.localName;
      if (ln === 'Font') runsOf(n, fontStyle(n, st), out);
      else if (ln === 'Space') out.push({ text: ' '.repeat(Math.max(1, Math.round(parseFloat(attr(n, 'Size') || '0.5') * 2))), ...st });
      else if (ln === 'Ruby') { const b = kid(n, 'Rb'); if (b) runsOf(b, st, out); }
      else runsOf(n, st, out);
    }
  }
  return out;
}

function position(el, standard) {
  return {
    valign: (attr(el, 'Valign') || 'center').toLowerCase(),
    vpos: parseFloat(attr(el, 'Vposition') || '0') || 0,
    halign: (attr(el, 'Halign') || 'center').toLowerCase(),
    hpos: parseFloat(attr(el, 'Hposition') || '0') || 0,
    direction: attr(el, 'Direction') || 'ltr'
  };
}

/** Recorre el XML y saca la lista de eventos { tin, tout, items[] } en segundos. */
function parseSubtitleXML(doc, standard) {
  const root = doc.documentElement;
  const tcRate = parseFloat(txt(root, 'TimeCodeRate')) || (txt(root, 'EditRate') ? parseFloat(txt(root, 'EditRate')) : 24);
  const startTime = standard === 'SMPTE' ? parseTime(txt(root, 'StartTime') || '00:00:00:00', standard, tcRate) : 0;
  const events = [];
  const imageRefs = [];
  const walk = (el, st) => {
    for (const c of el.children) {
      const ln = c.localName;
      if (ln === 'Font') walk(c, fontStyle(c, st));
      else if (ln === 'SubtitleList') walk(c, st);
      else if (ln === 'Subtitle') {
        const ev = {
          spot: attr(c, 'SpotNumber'),
          tin: parseTime(attr(c, 'TimeIn'), standard, tcRate) - startTime,
          tout: parseTime(attr(c, 'TimeOut'), standard, tcRate) - startTime,
          fadeUp: parseTime(attr(c, 'FadeUpTime'), standard, tcRate),
          fadeDown: parseTime(attr(c, 'FadeDownTime'), standard, tcRate),
          items: []
        };
        const inner = (e, s) => {
          for (const d of e.children) {
            if (d.localName === 'Font') inner(d, fontStyle(d, s));
            else if (d.localName === 'Text') ev.items.push({ type: 'text', ...position(d, standard), runs: runsOf(d, s, []), style: s });
            else if (d.localName === 'Image') {
              const ref = d.textContent.trim();
              imageRefs.push(ref);
              ev.items.push({ type: 'image', ...position(d, standard), ref });
            }
          }
        };
        inner(c, st);
        events.push(ev);
      }
    }
  };
  walk(root, DEFAULT_STYLE);
  events.sort((a, b) => a.tin - b.tin);
  const fonts = kids(root, 'LoadFont').map(f => ({ id: attr(f, 'ID') || attr(f, 'Id'), uri: attr(f, 'URI') || f.textContent.trim() }));
  return {
    events, fonts, imageRefs,
    language: txt(root, 'Language'),
    title: txt(root, 'ContentTitleText') || txt(root, 'MovieTitle'),
    reelNumber: txt(root, 'ReelNumber')
  };
}

const isPNG = b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isFont = b => (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || String.fromCharCode(b[0], b[1], b[2], b[3]) === 'OTTO' || String.fromCharCode(b[0], b[1], b[2], b[3]) === 'true';

async function registerFont(bytes) {
  try {
    const name = 'dcpfont' + (++fontCounter);
    const ff = new FontFace(name, bytes);
    await ff.load();
    document.fonts.add(ff);
    return name;
  } catch (e) { return null; }
}

/**
 * Carga los subtítulos de una pista de la CPL.
 * asset: pista de la CPL ({ file, path }); allFiles: Map ruta-en-minúsculas → File (para Interop).
 */
export async function loadSubtitleAsset(asset, allFiles) {
  if (!asset || !asset.file) throw new Error('Falta el archivo de subtítulos');
  const isMXF = /\.mxf$/i.test(asset.path || asset.file.name);
  let doc, standard, fontMap = {}, imageMap = {};
  if (isMXF) {
    const r = new MXFReader(asset.file);
    await r.open();
    const u = await r.readUnit(0);
    if (u.encrypted) throw new Error('Subtítulos encriptados');
    doc = parseXML(new TextDecoder('utf-8').decode(u.data));
    standard = 'SMPTE';
    const parsed = parseSubtitleXML(doc, standard);
    // Recursos (fuentes y PNG) en las particiones generic stream. Se asignan por orden:
    // las fuentes a los LoadFont y los PNG a las <Image> en el orden en que aparecen.
    const res = await r.readGenericStreams();
    const fonts = res.filter(x => isFont(x.data)), pngs = res.filter(x => isPNG(x.data));
    for (let i = 0; i < parsed.fonts.length && i < fonts.length; i++) fontMap[parsed.fonts[i].id] = await registerFont(fonts[i].data);
    if (!parsed.fonts.length && fonts.length) fontMap['*'] = await registerFont(fonts[0].data);
    const uniq = [...new Set(parsed.imageRefs)];
    uniq.forEach((ref, i) => { if (pngs[i]) imageMap[ref] = URL.createObjectURL(new Blob([pngs[i].data], { type: 'image/png' })); });
    return finish(parsed, standard, fontMap, imageMap, 'SMPTE Timed Text (MXF)');
  }
  const text = await asset.file.text();
  doc = parseXML(text);
  const rootName = doc.documentElement.localName;
  standard = rootName === 'DCSubtitle' ? 'Interop' : 'SMPTE';
  const parsed = parseSubtitleXML(doc, standard);
  const dir = (asset.path || '').replace(/[^/]*$/, '');
  const fileAt = rel => allFiles.get((dir + rel).replace(/\\/g, '/').toLowerCase()) || allFiles.get(rel.toLowerCase());
  for (const f of parsed.fonts) {
    const file = f.uri && fileAt(f.uri);
    if (file) fontMap[f.id] = await registerFont(await file.arrayBuffer());
  }
  for (const ref of new Set(parsed.imageRefs)) {
    const file = fileAt(ref) || fileAt(ref.replace(/^urn:uuid:/, '') + '.png');
    if (file) imageMap[ref] = URL.createObjectURL(file);
  }
  return finish(parsed, standard, fontMap, imageMap, rootName === 'DCSubtitle' ? 'Interop (XML)' : 'SMPTE (XML suelto)');
}

function finish(parsed, standard, fontMap, imageMap, kindName) {
  for (const ev of parsed.events) {
    for (const it of ev.items) {
      if (it.type === 'image') it.url = imageMap[it.ref] || null;
      else for (const r of it.runs) r.family = fontMap[r.fontId] || fontMap['*'] || null;
    }
  }
  return { ...parsed, standard, kindName, fontsLoaded: Object.values(fontMap).filter(Boolean).length, imagesLoaded: Object.keys(imageMap).length };
}

/** Eventos visibles en el instante t (segundos desde el principio del archivo de subtítulos). */
export function activeAt(subs, t) {
  if (!subs) return [];
  return subs.events.filter(e => t >= e.tin && t < e.tout);
}

/** Pinta los eventos en la capa de subtítulos. stageH = alto en píxeles de la imagen en pantalla. */
export function renderSubs(layer, events, stageH, t) {
  layer.textContent = '';
  for (const ev of events) {
    let op = 1;
    if (ev.fadeUp > 0 && t - ev.tin < ev.fadeUp) op = (t - ev.tin) / ev.fadeUp;
    if (ev.fadeDown > 0 && ev.tout - t < ev.fadeDown) op = Math.min(op, (ev.tout - t) / ev.fadeDown);
    for (const it of ev.items) {
      const d = document.createElement('div');
      d.className = 'sub-item';
      d.style.opacity = Math.max(0, Math.min(1, op));
      let tx = '0', ty = '0';
      if (it.valign === 'top') d.style.top = it.vpos + '%';
      else if (it.valign === 'bottom') d.style.bottom = it.vpos + '%';
      else { d.style.top = (50 + it.vpos) + '%'; ty = '-50%'; }
      if (it.halign === 'left') d.style.left = it.hpos + '%';
      else if (it.halign === 'right') d.style.right = it.hpos + '%';
      else { d.style.left = (50 + it.hpos) + '%'; tx = '-50%'; }
      d.style.transform = `translate(${tx},${ty})`;
      if (it.type === 'image') {
        if (it.url) {
          const img = document.createElement('img');
          img.src = it.url;
          // los PNG se hacen para una pantalla de 1080 de alto
          img.style.height = 'auto';
          img.onload = () => { img.style.width = (img.naturalWidth * stageH / 1080) + 'px'; };
          d.appendChild(img);
        } else d.textContent = '[imagen ' + it.ref + ']';
      } else {
        d.dir = it.direction === 'rtl' ? 'rtl' : 'ltr';
        for (const r of it.runs) {
          const s = document.createElement('span');
          s.textContent = r.text;
          // tamaño: puntos sobre una pantalla de 11 × 72 puntos de alto (criterio de DCP-o-matic)
          s.style.fontSize = (r.size * stageH / (11 * 72)).toFixed(1) + 'px';
          s.style.color = r.color;
          if (r.italic) s.style.fontStyle = 'italic';
          if (r.bold) s.style.fontWeight = '700';
          if (r.underline) s.style.textDecoration = 'underline';
          if (r.family) s.style.fontFamily = `"${r.family}", Arial, sans-serif`;
          const px = Math.max(1, stageH / 540);
          if (r.effect === 'border') s.style.textShadow = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 1], [0, -1], [1, 0], [-1, 0]].map(([x, y]) => `${x * px}px ${y * px}px 0 ${r.effectColor}`).join(',');
          else if (r.effect === 'shadow') s.style.textShadow = `${2 * px}px ${2 * px}px ${px}px ${r.effectColor}`;
          if (r.script === 'super') s.style.verticalAlign = 'super';
          if (r.script === 'sub') s.style.verticalAlign = 'sub';
          d.appendChild(s);
        }
      }
      layer.appendChild(d);
    }
  }
}
