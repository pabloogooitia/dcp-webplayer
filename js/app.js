// DCP Web Player · interfaz y lógica del visor (fase 1).

import { filesFromInput, filesFromDrop, loadPackages, pictureFormat, resolutionClass, soundText, channelLabels, fmtTC, fmtDuration, kindName } from './dcp.js';
import { MXFReader, parseJ2KHeader, j2kProfileName, cryptSourceKey } from './mxf.js';
import { DecoderPool } from './decoder-pool.js';
import { loadSubtitleAsset, activeAt, renderSubs } from './subs.js';
import { SoundReel, AudioOut, levels } from './audio.js';
import { Playback } from './playback.js';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- estado

const S = {
  files: [], byPath: new Map(), data: null, cpl: null,
  reels: [],            // por bobina: { reel, pic: Promise<MXFReader>, snd: SoundReel, subs: Promise }
  frame: 0, fps: 24, editRate: [24, 1],
  quality: 'auto', color: 'srgb', showSubs: true, audioMode: 'stereo', playRes: 'auto',
  pictureInfo: null, channels: 0, labels: [],
  token: 0, fullTimer: null, cache: new Map(), cacheBytes: 0,
  play: null            // { startTime, g0, end, raf }
};
const pool = new DecoderPool();
const audio = new AudioOut();
const CACHE_MAX = 320 * 1024 * 1024;
window.__dcp = S;           // para depurar desde la consola

// ---------------------------------------------------------------- tema

(function theme() {
  const KEY = 'dcpplayer-theme';
  let t = null;
  try { t = localStorage.getItem(KEY); } catch (e) { /* sin almacenamiento */ }
  if (t) document.documentElement.dataset.theme = t;
  $('themeBtn').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch (e) { /* nada */ }
  };
})();

// ---------------------------------------------------------------- carga

const drop = $('drop');
drop.onclick = () => $('dirInput').click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('dirInput').click(); } };
$('dirInput').onchange = e => { if (e.target.files.length) handleFiles(filesFromInput(e.target.files)); e.target.value = ''; };
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
document.addEventListener('drop', async e => {
  e.preventDefault(); drop.classList.remove('over');
  setStatus('Leyendo la carpeta…');
  try { handleFiles(await filesFromDrop(e.dataTransfer)); } catch (err) { showErrors(['No se puede leer lo arrastrado: ' + err.message]); }
});

// ---------------------------------------------------------------- vaciar

/** Quita todos los DCPs cargados y deja la página como recién abierta (las opciones se mantienen). */
function clearAll() {
  stopPlay(false);
  audio.stop();
  clearTimeout(S.fullTimer);
  S.token++;                      // invalida las decodificaciones y lecturas en marcha
  pool.clearQueue();
  Object.assign(S, {
    files: [], byPath: new Map(), data: null, cpl: null, reels: [], frame: 0,
    pictureInfo: null, channels: 0, labels: [], soundRate: 0, soundBits: 0, soundError: null
  });
  S.cache.clear(); S.cacheBytes = 0;
  for (const id of ['cplPanel', 'ficha', 'player', 'reelsPanel', 'clearBtn']) $(id).classList.add('hidden');
  $('ficha').innerHTML = ''; $('cplList').innerHTML = ''; $('reelsTable').innerHTML = '';
  $('subs').textContent = ''; $('subs')._key = '';
  $('meters').innerHTML = ''; $('audioNote').textContent = ''; $('hud').textContent = '';
  setMsg(''); clearCanvas();
  drop.classList.remove('compact');
  drop.querySelector('strong').textContent = 'Arrastra aquí la carpeta del DCP';
  setStatus(''); showErrors([]);
}
$('clearBtn').onclick = clearAll;

function setStatus(t) { $('status').textContent = t || ''; }
function showErrors(list) { $('errors').innerHTML = list.map(x => `<div>${esc(x)}</div>`).join(''); }

async function handleFiles(files) {
  stopPlay(false);
  S.files = files;
  S.byPath = new Map(files.map(f => [f.path.replace(/\\/g, '/').toLowerCase(), f.file]));
  setStatus(`Leyendo ${files.length} archivos…`);
  showErrors([]);
  let data;
  try { data = await loadPackages(files); } catch (e) { showErrors(['Error leyendo el DCP: ' + e.message]); setStatus(''); return; }
  S.data = data;
  if (!data.cpls.length) {
    setStatus('');
    showErrors(['No se ha encontrado ninguna CPL. ¿Es la carpeta de un DCP? (tiene que tener ASSETMAP o ASSETMAP.xml, la PKL y la CPL)'].concat(data.warnings));
    return;
  }
  drop.classList.add('compact');
  drop.querySelector('strong').textContent = 'Cargar otro DCP';
  $('clearBtn').classList.remove('hidden');
  setStatus(`${data.packages.length} DCP · ${data.cpls.length} CPL`);
  showErrors(data.warnings);
  renderCplList();
  // Si hay varias, empezamos por la primera no encriptada
  selectCPL(data.cpls.find(c => !c.encrypted) || data.cpls[0]);
}

function renderCplList() {
  const cpls = S.data.cpls;
  $('cplPanel').classList.toggle('hidden', cpls.length < 2);
  $('cplList').innerHTML = cpls.map((c, i) => `
    <div class="cpl-item${c === S.cpl ? ' on' : ''}" data-i="${i}">
      <div class="t">${esc(c.title || c.annotation || c.id)}</div>
      <span class="d">${esc(kindName(c.kind))} · ${fmtDuration(c.duration, c.editRate[0] / c.editRate[1])} · ${c.reels.length} bob.${(w => w.bytes ? ' · ' + fmtBytes(w.bytes) : '')(packageWeight(c))}</span>
      ${c.encrypted ? '<span class="badge b-bad">Encriptado</span>' : '<span class="badge b-ok">Libre</span>'}
    </div>`).join('');
  $('cplList').querySelectorAll('.cpl-item').forEach(el => el.onclick = () => selectCPL(cpls[+el.dataset.i]));
}

// ---------------------------------------------------------------- CPL

async function selectCPL(cpl) {
  stopPlay(false);
  pool.clearQueue();
  S.cpl = cpl;
  S.cache.clear(); S.cacheBytes = 0;
  S.editRate = cpl.editRate;
  S.fps = cpl.editRate[0] / cpl.editRate[1];
  S.frame = 0;
  S.pictureInfo = null; S.channels = 0; S.labels = [];
  S.reels = cpl.reels.map(reel => ({ reel, pic: null, snd: reel.sound && reel.sound.file && !reel.sound.keyId ? new SoundReel(reel.sound) : null, subs: null, subsData: null }));
  renderCplList();
  renderFicha();
  renderReels();
  $('player').classList.remove('hidden');
  $('seek').max = Math.max(0, cpl.duration - 1);
  renderReelMarks();
  $('meters').innerHTML = '';
  $('audioNote').textContent = '';
  // Datos técnicos de los MXF (primera bobina): resolución, perfil, canales
  probe(cpl).then(() => { if (S.cpl === cpl) { renderFicha(); renderAudioOptions(); } });
  // Subtítulos de todas las bobinas en segundo plano
  S.reels.forEach((r, i) => { if (r.reel.subtitle) getSubs(i).then(() => { if (S.cpl === cpl) { renderSubtitlesNow(); renderFicha(); } }).catch(() => {}); });
  show(0);
}

async function getPicReader(i) {
  const r = S.reels[i];
  if (!r.pic) {
    const a = r.reel.picture;
    if (!a.file) return Promise.reject(new Error('missing'));
    r.pic = new MXFReader(a.file).open(p => setStatus('Indexando el MXF de imagen… ' + Math.round(p * 100) + ' %'));
    r.pic.then(() => setStatus(S.data ? `${S.data.packages.length} DCP · ${S.data.cpls.length} CPL` : ''), () => {});
  }
  return r.pic;
}

function getSubs(i) {
  const r = S.reels[i];
  if (!r.subs) {
    r.subs = loadSubtitleAsset(r.reel.subtitle, S.byPath).then(d => { r.subsData = d; return d; }, e => { r.subsError = e.message; throw e; });
  }
  return r.subs;
}

async function probe(cpl) {
  // Imagen: descriptor del MXF + cabecera J2K del primer fotograma
  const i = S.reels.findIndex(r => r.reel.picture.file);
  if (i >= 0) {
    try {
      const rd = await getPicReader(i);
      const info = { width: rd.info.storedWidth, height: rd.info.storedHeight, encryptedMXF: rd.encrypted, indexed: !rd.scanned };
      const u = await rd.readUnit(S.reels[i].reel.picture.entry);
      if (u.encrypted) info.encryptedMXF = true;
      else {
        const j = parseJ2KHeader(u.data);
        if (j) Object.assign(info, { width: j.width, height: j.height, bits: j.bits, comps: j.components, profile: j2kProfileName(j.rsiz), levels: j.levels });
      }
      info.frameBytes = u.data.length;
      S.pictureInfo = info;
      setRatio(info.width, info.height);
    } catch (e) { S.pictureInfo = { error: e.message }; }
  }
  // Sonido
  const s = S.reels.find(r => r.snd);
  if (s) {
    try { await s.snd.open(); S.channels = s.snd.channels; S.soundRate = s.snd.rate; S.soundBits = s.snd.bits; } catch (e) { S.soundError = e.message; }
  } else {
    const any = S.reels.find(r => r.reel.sound && r.reel.sound.file);
    if (any) {
      try { const rd = await new MXFReader(any.reel.sound.file).open(); S.channels = rd.info.channelCount || 0; S.soundRate = rd.info.audioSamplingRate; } catch (e) { /* nada */ }
    }
  }
  S.labels = channelLabels(cpl, S.channels);
}

function setRatio(w, h) {
  if (!w || !h) return;
  $('stage').style.setProperty('--ratio', (w / h).toFixed(4));
}

// ---------------------------------------------------------------- ficha

/** Bytes → «45,3 GB» (unidades decimales, como el Finder del Mac). */
function fmtBytes(n) {
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i ? n.toLocaleString('es-ES', { maximumFractionDigits: n < 10 ? 2 : 1 }) : n) + ' ' + u[i];
}

/**
 * Peso del paquete de la CPL (la OV o la VF): los archivos que lista su ASSETMAP
 * y que se han cargado, más el propio ASSETMAP. Si es una VF que usa archivos de
 * otro paquete (su OV), también el total de lo que necesita la CPL.
 */
function packageWeight(c) {
  const pkg = c.pkg, own = new Set(), used = new Set();
  if (S.data) for (const a of S.data.assets.values()) if (a.pkg === pkg && a.file) own.add(a.file);
  if (pkg.amFile) own.add(pkg.amFile);
  let borrowed = false;
  for (const r of c.reels) for (const a of [r.picture, r.sound, r.subtitle, r.caption, ...(r.aux || [])]) {
    if (!a || !a.file) continue;
    used.add(a.file);
    if (!own.has(a.file)) borrowed = true;
  }
  const sum = set => [...set].reduce((t, f) => t + (f.size || 0), 0);
  const all = new Set([...own, ...used]);
  return { bytes: sum(own), files: own.size, borrowed, total: sum(all) };
}


function renderFicha() {
  const c = S.cpl, pi = S.pictureInfo || {};
  const fps = S.fps;
  const p0 = c.reels[0].picture;
  const w = pi.width || (c.meta.stored && c.meta.stored[0]), h = pi.height || (c.meta.stored && c.meta.stored[1]);
  const fmt = pictureFormat(w, h, p0.sar);
  const res = resolutionClass(w);
  const stereo = c.reels.some(r => r.picture.stereo);
  const frameRate = p0.frameRate ? p0.frameRate[0] / p0.frameRate[1] : fps;
  const subs = c.reels.filter(r => r.subtitle);
  const subLang = [...new Set(subs.map(r => r.subtitle.language || (S.reels[c.reels.indexOf(r)].subsData || {}).language).filter(Boolean))];
  const subKind = (S.reels.find(r => r.subsData) || {}).subsData;
  const caps = c.reels.filter(r => r.caption);
  const missing = [];
  c.reels.forEach((r, i) => {
    for (const [k, a] of [['imagen', r.picture], ['sonido', r.sound], ['subtítulos', r.subtitle]]) if (a && !a.file) missing.push(`bobina ${i + 1}: ${k}`);
  });
  const chips = [
    c.standard,
    kindName(c.kind),
    [res, fmt.name].filter(Boolean).join(' ') + (w ? ` (${w}×${h})` : ''),
    (stereo ? '3D · ' : '') + `${+frameRate.toFixed(3)} fps`,
    'Sonido: ' + soundText(c, S.channels),
    subs.length ? 'Subtítulos' + (subLang.length ? ' (' + subLang.join(', ') + ')' : '') : 'Sin subtítulos',
    `${c.reels.length} ${c.reels.length === 1 ? 'bobina' : 'bobinas'}`,
    fmtDuration(c.duration, fps)
  ];
  if (caps.length) chips.push('Subtítulos cerrados (CCAP)');
  const wgt = packageWeight(c);
  if (wgt.bytes) chips.push(fmtBytes(wgt.bytes));
  const verdict = c.encrypted
    ? `<span class="badge b-bad verdict">Encriptado · necesita KDM: no se puede reproducir aquí</span>`
    : `<span class="badge b-ok verdict">Libre · no necesita KDM</span>`;
  const kv = [
    ['Peso', wgt.bytes ? `${fmtBytes(wgt.bytes)} · ${wgt.files} ${wgt.files === 1 ? 'archivo' : 'archivos'} en la carpeta` +
      (wgt.borrowed ? ` · ${fmtBytes(wgt.total)} contando los archivos de la OV que usa` : '') : ''],
    ['Duración', `${fmtTC(c.duration, fps)} · ${c.duration} fotogramas a ${S.editRate.join('/')} · ${fmtDuration(c.duration, fps)}`],
    ['Imagen', [res && fmt.name ? `${res} ${fmt.name}` : '', w ? `${w}×${h}` : '', pi.profile, pi.bits ? `${pi.bits} bits` : '', pi.levels != null ? `${pi.levels} niveles de resolución` : '', stereo ? '3D (estereoscópico)' : '2D'].filter(Boolean).join(' · ') + (pi.error ? ' · ' + pi.error : '')],
    ['Sonido', soundText(c, S.channels) + (S.soundRate ? ` · ${S.soundRate / 1000} kHz` : '') + (S.soundBits ? ` · ${S.soundBits} bits` : '') + (c.meta.soundConfig ? ` · ${c.meta.soundConfig}` : '')],
    ['Subtítulos', subs.length ? `${subs.length} de ${c.reels.length} bobinas` + (subKind ? ` · ${subKind.kindName}` : '') + (subLang.length ? ` · ${subLang.join(', ')}` : '') : 'No'],
    ['Encriptado', c.encrypted ? `Sí: ${c.encryptedTracks.join(', ')} · ${c.keyCount} ${c.keyCount === 1 ? 'clave' : 'claves'} (KeyId)` : 'No (ninguna pista lleva KeyId)'],
    ['Emisor', [c.issuer, c.creator].filter(Boolean).join(' · ')],
    ['Fecha', c.issueDate],
    ['Versión', c.version],
    ['Calificación', c.ratings.join(', ')],
    ['Id CPL', `<span class="mono">${esc(c.id)}</span>`, true],
    ['Carpeta', `<span class="mono">${esc(c.pkg.path)}</span>`, true]
  ];
  if (missing.length) kv.unshift(['Faltan archivos', `<span class="badge b-warn">${esc(missing.join(' · '))}</span> <span class="note">¿Es una VF? Carga también la carpeta de su OV a la vez.</span>`, true]);
  if (pi.encryptedMXF && !c.encrypted) kv.unshift(['Aviso', '<span class="badge b-warn">La CPL no tiene KeyId, pero el MXF de imagen lleva esencia encriptada</span>', true]);
  $('ficha').classList.remove('hidden');
  $('ficha').innerHTML = `
    <div class="title-row">
      <div style="min-width:0;flex:1 1 300px">
        <div class="title">${esc(c.title || '(sin título)')}</div>
        ${c.annotation && c.annotation !== c.title ? `<div class="anno">${esc(c.annotation)}</div>` : ''}
      </div>
      ${verdict}
    </div>
    <div class="chips">${chips.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>
    <div class="kv">${kv.filter(x => x[1]).map(([k, v, raw]) => `<div><span>${esc(k)}</span><span>${raw ? v : esc(v)}</span></div>`).join('')}</div>`;
}

function renderReels() {
  const c = S.cpl, fps = S.fps;
  const cell = a => {
    if (!a) return '<span class="note">—</span>';
    const state = !a.file ? '<span class="badge b-warn">falta</span>' : a.keyId ? '<span class="badge b-bad">encriptado</span>' : '<span class="badge b-ok">ok</span>';
    const name = a.path ? a.path.split('/').pop() : a.id;
    return `${state}<div class="f">${esc(name)}</div>`;
  };
  $('reelsPanel').classList.remove('hidden');
  $('reelsTable').innerHTML = `<tr><th>#</th><th>Empieza</th><th>Duración</th><th>Entry point</th><th>Imagen</th><th>Sonido</th><th>Subtítulos</th></tr>` +
    c.reels.map((r, i) => `<tr data-i="${i}"><td>${i + 1}</td><td>${fmtTC(r.start, fps)}</td><td>${fmtTC(r.duration, fps)}<div class="f">${r.duration} fot.</div></td>
      <td>${r.picture.entry}${r.picture.entry ? '' : ''}<div class="f">de ${r.picture.intrinsic}</div></td>
      <td>${cell(r.picture)}</td><td>${cell(r.sound)}</td><td>${cell(r.subtitle)}</td></tr>`).join('');
  $('reelsTable').querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => seek(c.reels[+tr.dataset.i].start));
}

function renderReelMarks() {
  const c = S.cpl;
  $('reelmarks').innerHTML = c.reels.length < 2 ? '' : c.reels.map((r, i) => `<span style="left:${(r.start / Math.max(1, c.duration - 1) * 100).toFixed(3)}%">B${i + 1}</span>`).join('');
}

function renderAudioOptions() {
  const sel = $('optAudio');
  const n = S.channels;
  sel.innerHTML = '<option value="stereo">Mezcla estéreo</option>' + S.labels.map((l, i) => `<option value="${i}">Canal ${i + 1} · ${esc(l)}</option>`).join('');
  sel.value = S.audioMode;
  if (sel.value !== String(S.audioMode)) { S.audioMode = 'stereo'; sel.value = 'stereo'; }
  const anySound = S.cpl.reels.some(r => r.sound);
  const encSound = S.cpl.reels.some(r => r.sound && r.sound.keyId);
  const playable = S.cpl.reels.some(r => r.sound && r.sound.file && !r.sound.keyId);
  $('bPlay').disabled = !playable;
  $('audioNote').textContent = !anySound ? 'Esta CPL no tiene sonido.' : encSound ? 'El sonido está encriptado: no se puede escuchar.' : (S.soundError ? 'Sonido: ' + S.soundError : (n ? `${n} canales. Pulsa un canal para escucharlo solo.` : ''));
}

// ---------------------------------------------------------------- posición

/** Fotograma global → { i (bobina), reel, local (edit unit en el MXF de imagen), offset (desde el principio de la bobina) } */
function locate(g) {
  const reels = S.cpl.reels;
  let i = reels.length - 1;
  for (let k = 0; k < reels.length; k++) if (g < reels[k].start + reels[k].duration) { i = k; break; }
  const reel = reels[i];
  const offset = g - reel.start;
  return { i, reel, offset, local: reel.picture.entry + offset };
}

function seek(g, opts) {
  stopPlay(false);
  g = Math.max(0, Math.min(S.cpl.duration - 1, Math.round(g)));
  show(g, opts);
}

function updatePosition(g) {
  const { i, offset } = locate(g);
  const fps = S.fps;
  $('tc').textContent = fmtTC(g, fps);
  $('pos').textContent = `fotograma ${g} de ${S.cpl.duration} · bobina ${i + 1}/${S.cpl.reels.length} (${fmtTC(offset, fps)})`;
  $('seek').value = g;
  $('reelsTable').querySelectorAll('tr[data-i]').forEach(tr => tr.classList.toggle('cur', +tr.dataset.i === i));
}

function setMsg(big, small, bad) {
  $('msg').innerHTML = big ? `<div class="big${bad ? ' bad' : ''}">${esc(big)}</div>${small ? `<div class="small">${esc(small)}</div>` : ''}` : '';
}

function clearCanvas() {
  const cv = $('view');
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
}

// ---------------------------------------------------------------- imagen

function previewLevel(w, fast) {
  // 2K → 1/2 (nivel 1), 4K → 1/4 (nivel 2). Al escuchar, una más.
  const base = (w || 2048) > 2048 ? 2 : 1;
  return base + (fast ? 1 : 0);
}

/** Muestra el fotograma global g. */
async function show(g, { fast = false } = {}) {
  S.frame = g;
  const token = ++S.token;
  clearTimeout(S.fullTimer);
  updatePosition(g);
  renderSubtitlesNow();
  const { i, reel, local } = locate(g);
  const pic = reel.picture;
  if (!pic.file) {
    clearCanvas(); $('hud').textContent = '';
    setMsg(`Falta el archivo de imagen de la bobina ${i + 1}`, '¿Es una VF (versión) que usa la imagen de otro DCP? Carga a la vez la carpeta de la OV.');
    return;
  }
  if (pic.keyId) {
    clearCanvas(); $('hud').textContent = '';
    setMsg('Encriptado · necesita KDM: no se puede reproducir aquí', 'La imagen de esta CPL está encriptada (lleva KeyId). La KDM solo la descifra la clave privada del servidor de cada sala, así que el navegador no puede verla. La ficha de arriba sí es correcta.', true);
    return;
  }
  let rd;
  try { rd = await getPicReader(i); } catch (e) {
    if (token !== S.token) return;
    clearCanvas(); setMsg('No se puede leer el MXF de imagen', e.message, true); return;
  }
  if (token !== S.token) return;
  const w = (S.pictureInfo && S.pictureInfo.width) || rd.info.storedWidth;
  const want = S.quality === 'full' ? [0] : S.quality === 'reduced' ? [previewLevel(w, fast)] : fast ? [previewLevel(w, true)] : [previewLevel(w, false), 0];
  // caché: si ya está el definitivo, directamente; si solo está la vista reducida, se pinta mientras tanto
  const ck = l => `${S.cpl.id}:${i}:${local}:${l}:${S.color}`;
  const cf = S.cache.get(ck(want[want.length - 1]));
  if (cf) { draw(cf, g); return; }
  const cp = want.length > 1 && S.cache.get(ck(want[0]));
  if (cp) draw(cp, g);
  let unit;
  try { unit = await rd.readUnit(local); } catch (e) {
    if (token !== S.token) return;
    clearCanvas(); setMsg('No se puede leer el fotograma', e.message, true); return;
  }
  if (token !== S.token) return;
  if (unit.encrypted) {
    clearCanvas();
    setMsg('Encriptado · necesita KDM: no se puede reproducir aquí', 'La esencia del MXF está encriptada (' + (cryptSourceKey(unit.data) || 'triplete SMPTE 429-6') + ').', true);
    return;
  }
  if (!fast) pool.clearQueue();
  const run = async l => {
    const key = ck(l);
    let res = S.cache.get(key);
    if (!res) {
      res = await pool.decode(unit.data, l, S.color);
      putCache(key, res);
    }
    if (token === S.token || (fast && S.play)) draw(res, g);
  };
  try {
    await run(want[0]);
    if (want.length > 1 && token === S.token) {
      S.fullTimer = setTimeout(() => { if (token === S.token) run(want[1]).catch(err => { if (err.message !== 'cancelado') console.warn(err); }); }, 120);
    }
  } catch (e) {
    if (e.message === 'cancelado' || token !== S.token) return;
    clearCanvas(); setMsg('Error al decodificar el fotograma', e.message, true);
  }
}

function putCache(key, res) {
  const bytes = res.rgba.byteLength;
  S.cache.set(key, res); S.cacheBytes += bytes;
  for (const [k, v] of S.cache) {
    if (S.cacheBytes <= CACHE_MAX) break;
    S.cache.delete(k); S.cacheBytes -= v.rgba.byteLength;
  }
}

function draw(res, g, playing) {
  const cv = $('view');
  if (cv.width !== res.width || cv.height !== res.height) { cv.width = res.width; cv.height = res.height; }
  const ctx = cv.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(res.rgba), res.width, res.height), 0, 0);
  cv.dataset.frame = g; cv.dataset.level = res.level;      // (lo usan las pruebas automáticas)
  setRatio(res.fullWidth, res.fullHeight);
  setMsg('');
  if (playing) return;           // durante la reproducción el HUD lo pone onTick
  const scale = res.level ? `1/${1 << res.level}` : 'completa';
  $('hud').textContent = `${res.width}×${res.height} · resolución ${scale} · ${Math.round(res.decodeMs + res.colorMs)} ms`;
}

// ---------------------------------------------------------------- subtítulos

function renderSubtitlesNow() {
  const layer = $('subs');
  if (!S.cpl || !S.showSubs) { layer.textContent = ''; layer._key = ''; return; }
  const { i, reel, offset } = locate(S.frame);
  const r = S.reels[i];
  if (!reel.subtitle || !r.subsData) { layer.textContent = ''; layer._key = ''; return; }
  // tiempo dentro del archivo de subtítulos (respetando su EntryPoint)
  const er = reel.subtitle.editRate;
  const t = offset / S.fps + reel.subtitle.entry * er[1] / er[0];
  const box = $('stage').getBoundingClientRect();
  const pw = (S.pictureInfo && S.pictureInfo.width) || 0;
  renderSubs(layer, activeAt(r.subsData, t), box.height, t, pw ? box.width / pw : 0);
}
new ResizeObserver(() => renderSubtitlesNow()).observe($('stage'));

// ---------------------------------------------------------------- sonido

/** Lee el sonido de n fotogramas desde el fotograma global g (cruzando bobinas). */
async function readAudioRange(g0, total) {
  const c = S.cpl;
  let rate = 48000, labels = S.labels, g = g0, left = total;
  const parts = [];
  while (left > 0) {
    const { i, reel, offset } = locate(g);
    const n = Math.min(left, reel.duration - offset);
    const r = S.reels[i];
    let data = null;
    if (r.snd) {
      await r.snd.open();
      rate = r.snd.rate;
      const er = reel.sound.editRate;
      // posición en el MXF de sonido: su EntryPoint + el mismo tiempo desde el principio de la bobina
      const su = reel.sound.entry + Math.round(offset / S.fps * er[0] / er[1]);
      const cnt = Math.round(n / S.fps * er[0] / er[1]);
      data = await r.snd.read(su, cnt);
    }
    parts.push({ data, frames: n });       // sin sonido en esa bobina: silencio
    g += n; left -= n;
  }
  const ch = S.channels || (parts.find(p => p.data) || { data: [] }).data.length;
  if (!ch) return null;
  const lens = parts.map(p => p.data ? p.data[0].length : Math.round(p.frames / S.fps * rate));
  const tot = lens.reduce((a, b) => a + b, 0);
  const chans = Array.from({ length: ch }, () => new Float32Array(tot));
  let o = 0;
  parts.forEach((p, k) => { if (p.data) p.data.forEach((d, c2) => chans[c2] && chans[c2].set(d.subarray(0, lens[k]), o)); o += lens[k]; });
  if (labels.length !== ch) labels = channelLabels(c, ch);
  return { chans, labels, rate };
}

function playLevels(w) {
  // niveles de resolución reducida (1 = 1/2, 2 = 1/4, 3 = 1/8) según la opción elegida
  const is4K = (w || 2048) > 2048;
  if (S.playRes === 'auto') return { level: is4K ? 3 : 2, auto: true, min: is4K ? 2 : 1, max: is4K ? 4 : 3 };
  const l = +S.playRes;
  return { level: l, auto: false, min: l, max: l };
}

/** Reproducción continua desde la posición actual hasta el final o hasta Parar. */
async function play() {
  if (S.play) { stopPlay(); return; }
  const c = S.cpl;
  if (S.frame >= c.duration - 1) S.frame = 0;
  const { reel } = locate(S.frame);
  if (reel.picture.keyId && !c.reels.some(r => r.sound && r.sound.file && !r.sound.keyId)) return;
  clearTimeout(S.fullTimer);
  S.token++;
  pool.clearQueue();
  const pi = S.pictureInfo || {};
  const lv = playLevels(pi.width);
  const hasSound = c.reels.some(r => r.sound && r.sound.file && !r.sound.keyId);
  let lastMeters = 0;
  const pb = new Playback({
    pool, cpl: c, fps: S.fps, locate, getReader: getPicReader, color: S.color,
    width: pi.width, height: pi.height,
    level: lv.level, auto: lv.auto, minLevel: lv.min, maxLevel: lv.max,
    hasSound, readAudio: readAudioRange, audioOut: audio,
    audioMode: () => S.audioMode === 'stereo' ? 'stereo' : +S.audioMode,
    draw: (res, g) => draw(res, g, true),
    onTick: (g, st) => {
      if (g !== S.frame) { S.frame = g; updatePosition(g); }
      renderSubtitlesNow();
      const pct = st.total ? Math.round(st.lost / st.total * 100) : 0;
      const sec = n => (n / st.fps).toFixed(1).replace('.', ',');
      $('hud').textContent = st.state === 'Precargando'
        ? `Precargando… ${sec(st.buffered)} / ${sec(st.need)} s · resolución 1/${1 << st.level}`
        : `▶ resolución 1/${1 << st.level} · búfer ${sec(st.buffered)} s · perdidos ${st.lost} (${pct} %)`;
    },
    onLevels: (chans, labels) => {
      const now = performance.now();
      if (now - lastMeters > 900) { lastMeters = now; renderMeters(levels(chans), labels); }
    },
    onEnd: () => { S.play = null; $('bPlay').textContent = '▶ Reproducir'; show(S.frame); }
  });
  S.play = pb;
  $('bPlay').textContent = '■ Parar';
  try { await pb.start(S.frame); } catch (e) {
    console.error(e);
    stopPlay();
    $('audioNote').textContent = 'Error al reproducir: ' + e.message;
  }
}

function stopPlay(showAfter = true) {
  if (!S.play) return;
  const pb = S.play;
  S.play = null;
  pb.stop();
  $('bPlay').textContent = '▶ Reproducir';
  if (S.cpl && showAfter) show(S.frame);     // al parar, fotograma a resolución completa
}

function renderMeters(lv, labels) {
  const solo = S.audioMode;
  $('meters').innerHTML = lv.map((x, i) => {
    const db = x.rms;
    const pct = isFinite(db) ? Math.max(0, Math.min(100, (db + 60) / 60 * 100)) : 0;
    const silent = !isFinite(x.peak) || x.peak < -80;
    return `<div class="meter${String(i) === String(solo) ? ' on' : ''}${silent ? ' silent' : ''}" data-c="${i}" title="Canal ${i + 1} · ${esc(labels[i])} · pico ${isFinite(x.peak) ? x.peak.toFixed(1) : '−∞'} dBFS">
      <div class="bar"><i style="height:${pct}%"></i></div><div class="l">${esc(labels[i])}</div><div class="db">${isFinite(db) ? db.toFixed(0) : '−∞'}</div></div>`;
  }).join('');
  $('meters').querySelectorAll('.meter').forEach(m => m.onclick = () => {
    const c = m.dataset.c;
    S.audioMode = String(S.audioMode) === c ? 'stereo' : c;
    $('optAudio').value = S.audioMode;
    $('meters').querySelectorAll('.meter').forEach(x => x.classList.toggle('on', x.dataset.c === String(S.audioMode)));
  });
  const active = lv.filter(x => isFinite(x.peak) && x.peak > -80).length;
  $('audioNote').textContent = `${lv.length} canales · ${active} con señal en este trozo (nivel RMS en dBFS). Pulsa un canal para escucharlo solo; púlsalo otra vez para volver a la mezcla.`;
}

// ---------------------------------------------------------------- controles

const step = d => () => { if (S.cpl) seek(S.frame + d); };
$('bStart').onclick = () => S.cpl && seek(0);
$('bEnd').onclick = () => S.cpl && seek(S.cpl.duration - 1);
$('bBack').onclick = step(-1);
$('bFwd').onclick = step(1);
$('bSecBack').onclick = () => S.cpl && seek(S.frame - Math.round(S.fps));
$('bSecFwd').onclick = () => S.cpl && seek(S.frame + Math.round(S.fps));
$('bReelPrev').onclick = () => reelJump(-1);
$('bReelNext').onclick = () => reelJump(1);
$('bPlay').onclick = () => S.cpl && play();
$('seek').oninput = e => seek(+e.target.value, { fast: false });
$('optSubs').onchange = e => { S.showSubs = e.target.checked; renderSubtitlesNow(); };
$('optQuality').onchange = e => { S.quality = e.target.value; S.cpl && show(S.frame); };
$('optColor').onchange = e => { S.color = e.target.value; S.cpl && show(S.frame); };
$('optAudio').onchange = e => { S.audioMode = e.target.value; };
$('optPlayRes').onchange = e => { S.playRes = e.target.value; if (S.play) { stopPlay(false); play(); } };
$('optVol').oninput = e => audio.setVolume(+e.target.value);
$('bFull').onclick = toggleFullscreen;
$('bSave').onclick = () => {
  const cv = $('view');
  cv.toBlob(b => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `${(S.cpl.title || 'dcp').replace(/[^\w.-]+/g, '_')}_${fmtTC(S.frame, S.fps).replace(/:/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
};

function reelJump(d) {
  if (!S.cpl) return;
  const { i, offset } = locate(S.frame);
  let k = i + d;
  if (d < 0 && offset > 0) k = i;          // primero, al principio de la bobina actual
  k = Math.max(0, Math.min(S.cpl.reels.length - 1, k));
  seek(S.cpl.reels[k].start);
}

function toggleFullscreen() {
  const el = $('stageWrap');
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  if (fs) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
}

document.addEventListener('keydown', e => {
  if (!S.cpl) return;
  const t = e.target;
  if (t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') || t.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const sec = Math.round(S.fps);
  let handled = true;
  switch (e.key) {
    case 'ArrowLeft': seek(S.frame - (e.shiftKey ? sec : 1)); break;
    case 'ArrowRight': seek(S.frame + (e.shiftKey ? sec : 1)); break;
    case 'ArrowUp': seek(S.frame + 10 * sec); break;
    case 'ArrowDown': seek(S.frame - 10 * sec); break;
    case 'Home': seek(0); break;
    case 'End': seek(S.cpl.duration - 1); break;
    case 'PageUp': reelJump(-1); break;
    case 'PageDown': reelJump(1); break;
    case ' ': play(); break;
    case 's': case 'S': $('optSubs').checked = !$('optSubs').checked; S.showSubs = $('optSubs').checked; renderSubtitlesNow(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});
