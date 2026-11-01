# DCP Web Player — Cines Babel

Reproductor de DCP (Digital Cinema Package) que funciona en el navegador, al estilo de DCP-o-matic Player. Se elige o se arrastra la carpeta de un DCP y se ve su ficha, la imagen fotograma a fotograma, los subtítulos encima y se puede escuchar el sonido. Está alojado en GitHub Pages y no necesita instalar nada ni paso de compilación: los archivos se sirven tal cual.

Los archivos se procesan en el navegador y no se suben a ningún sitio.

## Qué hace
### Carga
- Acepta la carpeta de un DCP (botón o arrastrando la carpeta), varias a la vez o un disco entero. Si se cargan juntas una VF y su OV, la VF usa los archivos de la OV.
- Lee el ASSETMAP (SMPTE `ASSETMAP.xml` o Interop `ASSETMAP`), las PKL y las CPL. Si hay varias CPL, salen en una lista para elegir.
- Los MXF nunca se cargan enteros: se leen a trozos con `File.slice()` (partition packs, RIP, metadatos e índice) y de cada fotograma solo sus bytes. Funciona igual con un tráiler que con un largo de cientos de GB.
- **Vaciar DCPs** (arriba a la derecha) quita todos los DCPs cargados, como recargar la página pero sin perder las opciones. Útil al ir revisando discos uno detrás de otro.

### Ficha de la CPL
- Veredicto bien visible: **Libre · no necesita KDM** o **Encriptado · necesita KDM: no se puede reproducir aquí** (cualquier pista con `<KeyId>`), qué pistas están encriptadas y cuántas claves.
- Título, tipo, SMPTE o Interop, duración (timecode y fotogramas), bobinas, resolución (2K/4K, Flat/Scope), perfil JPEG 2000, fps, 2D/3D, sonido (5.1/7.1, canales, kHz, Atmos), subtítulos e idioma, emisor, fecha, versión.
- Peso del DCP (la carpeta de esa OV o VF, como lo cuenta el Finder del Mac: 1 GB = 1000 MB). Si es una VF cargada junto a su OV, también el total contando los archivos de la OV que usa. El peso sale también en la lista de CPLs.
- Tabla de bobinas con duración, entry point y el estado de cada archivo (ok, falta o encriptado). Avisa si faltan archivos (típico de una VF sin su OV).

### Imagen
- Decodifica el JPEG 2000 con OpenJPEG compilado a WebAssembly (`vendor/openjpeg`), en varios Web Workers, cada uno con su decodificador.
- Convierte el color del DCP (X'Y'Z', gamma 2.6) a sRGB. Hay una opción para verlo sin convertir.
- Calidad automática: mientras te mueves por la línea de tiempo decodifica a resolución reducida (1/2 en 2K, 1/4 en 4K) y al pararte, a resolución completa.
- Guardar el fotograma como PNG y pantalla completa.
- Si la imagen está encriptada no intenta decodificarla: lo dice en pantalla y la ficha sigue siendo correcta.

### Línea de tiempo
- Toda la CPL seguida (todas las bobinas), respetando `EntryPoint` y `Duration` de cada pista. Marcas de bobina.
- Avance y retroceso por fotograma, por segundo, por 10 segundos y por bobina, con botones y atajos de teclado.

### Subtítulos
- SMPTE Timed Text (dentro del MXF, con la fuente que lleve incrustada) e Interop (XML con sus fuentes y PNG de la carpeta).
- Texto con su posición (`Valign`/`Vposition`, `Halign`/`Hposition`), cursiva, negrita, color, borde o sombra y fundidos. Los PNG de Interop se muestran; los de SMPTE se asignan por orden (ver limitaciones).

### Reproducción continua
- **Reproducir** sigue hasta el final o hasta pulsar Parar (antes solo eran unos segundos).
- Precarga lo que viene: lee del disco 8 fotogramas de una vez y los decodifica en varios workers a la vez (hasta 6, según los núcleos del ordenador), con hasta 12 s por delante. Antes de arrancar precarga 10 s (o lo que quepa en memoria a esa resolución): tarda más en empezar, pero luego aguanta mejor los tirones. El indicador muestra cuántos segundos lleva precargados.
- Resolución al reproducir: **Automática** (empieza en 1/4, o 1/8 en 4K, baja si se pierden fotogramas o si el búfer se va vaciando, y sube si va sobrado; si un nivel no ha aguantado, ya no vuelve a él en esa reproducción) o fija en 1/2, 1/4 o 1/8. En pausa, el fotograma se ve a resolución completa.
- La imagen va sincronizada con el reloj del sonido. Si un fotograma no llega a tiempo, se salta (el indicador de arriba a la derecha dice cuántos se pierden y cuánto búfer hay).

### Sonido
- Lee el MXF de audio (PCM 24 bits, 48 kHz) y lo va programando en trozos de 1 s con Web Audio.
- Mezcla a estéreo (L, R, C a −3 dB, surrounds a su lado; sin LFE ni pistas de accesibilidad; con limitador para que no sature) o un canal suelto (L, R, C, LFE, Ls, Rs, HI, VI…). Vúmetros por canal para ver cuáles tienen señal; pulsando uno se escucha solo.

## Atajos de teclado
| Tecla | Acción |
|---|---|
| ← → | fotograma anterior / siguiente |
| Mayús + ← → | ±1 segundo |
| ↑ ↓ | ±10 segundos |
| Inicio / Fin | principio / final |
| RePág / AvPág | bobina anterior / siguiente |
| Espacio | reproducir / parar |
| S | subtítulos sí / no |
| F | pantalla completa |

## Limitaciones
- **DCP encriptados**: no se pueden reproducir. La KDM solo la descifra la clave privada del servidor de cada sala. El player los detecta y lo avisa.
- **Sin aceleración por hardware**: los navegadores no decodifican JPEG 2000 por GPU (WebCodecs no lo soporta), y en GitHub Pages no hay hilos WASM (no permite las cabeceras COOP/COEP). Por eso se reproduce a resolución reducida con varios workers; a resolución completa y 24 fps no llega.
- **Discos ext2/ext3**: el navegador solo ve lo que el sistema operativo monte. Desde Mac o Windows hace falta un programa que monte ese formato.
- Subtítulos SMPTE con imágenes (PNG dentro del MXF): se emparejan por orden de aparición, no por su identificador. Ruby, `HGroup` y texto vertical se muestran de forma aproximada.
- 3D: se muestra el ojo izquierdo.
- No comprueba los hashes de la PKL (habría que leer los archivos enteros).

## Navegadores
Chrome, Edge, Safari y Firefox actuales. Para arrastrar carpetas hace falta un navegador con `webkitGetAsEntry` (todos los actuales lo tienen).

## Estructura
```
index.html               interfaz y estilos
js/app.js                lógica del visor: ficha, línea de tiempo, teclado, sonido
js/playback.js           reproducción continua: precarga, workers, sincronía con el sonido
js/dcp.js                carga de carpetas, ASSETMAP, PKL y CPL
js/mxf.js                lector MXF (KLV, partition packs, RIP, index table segments) y cabecera J2K
js/decoder-pool.js       pool de workers
js/decoder-worker.js     decodificación J2K (OpenJPEG WASM) y color XYZ → sRGB
js/subs.js               subtítulos SMPTE e Interop
js/audio.js              lectura del PCM y Web Audio
vendor/openjpeg/         OpenJPEG en WebAssembly (@cornerstonejs/codec-openjpeg 1.3.6) y su licencia
tools/                   herramientas de desarrollo (no hacen falta para usar el player)
```

### Herramientas de desarrollo
- `tools/make_test_dcp.py carpeta`: genera DCPs de prueba (SMPTE 2K Flat con 2 bobinas, 16 canales y subtítulos Timed Text; Interop 2K Scope con subtítulos XML + PNG; SMPTE 4K Scope con entry point; y uno encriptado). Necesita Python 3, numpy, Pillow y `opj_compress` (paquete `libopenjp2-tools`).
- `tools/test-mxf.mjs archivo.mxf`: prueba el lector MXF en Node.
- `tools/test-browser.mjs URL carpeta capturas`: prueba el player en Chromium con Playwright y hace capturas.
- `tools/test-decoder.js archivo.j2c`: prueba el decodificador WASM en Node.

Para probarlo en local hace falta servirlo por HTTP (los workers y el WASM no cargan desde `file://`), por ejemplo `python3 -m http.server` en la carpeta del repo y abrir `http://localhost:8000`.

## Próximas fases
- **Fase 3**: pulido (más atajos, comparar CPL, marcadores FFOC/LFOC, comprobación de hashes…).

## Licencia
[PolyForm Noncommercial 1.0.0](LICENSE.md). Uso comercial: pgoitiamartinez@gmail.com. El decodificador de `vendor/openjpeg` tiene su propia licencia (OpenJPEG, BSD de 2 cláusulas; empaquetado de Cornerstone, MIT): ver [vendor/openjpeg/LICENSE.md](vendor/openjpeg/LICENSE.md).

## Autor
Desarrollado por **Pablo Goitia Martinez** — [pgoitiamartinez@gmail.com](mailto:pgoitiamartinez@gmail.com)

## Changelog
- **v0.4** (01/11/2026): botón **Vaciar DCPs** para quitar todo lo cargado sin recargar la página. Peso del DCP (OV o VF) en la ficha y en la lista de CPLs; en una VF, también el total con los archivos de la OV. Quitado «Cines Babel» del pie de página.
- **v0.3** (01/11/2026): antes de reproducir se precargan 10 s (antes ~1 s) y el búfer llega hasta 12 s por delante (antes 4 s, tope de memoria de 512 MB). La resolución automática baja también cuando ve que el búfer se va vaciando, sin esperar a perder fotogramas, y no vuelve a subir a un nivel que no ha aguantado (así no cambia de resolución cada pocos segundos). El indicador muestra el búfer en segundos.
- **v0.2** (01/11/2026): reproducción continua (ya no se para a los pocos segundos) con precarga de fotogramas por delante, lectura del disco por bloques, hasta 6 workers y sonido sincronizado por trozos; resolución al reproducir automática o fija en 1/2, 1/4 y 1/8. Arreglado el parpadeo de los subtítulos PNG (se veían alternando gigantes y descentrados con los buenos): ahora se pintan ya escalados a la resolución del DCP y no se rehacen en cada fotograma. Los recursos de los subtítulos SMPTE se leen aunque vayan varios en la misma partición.
- **v0.1** (31/10/2026): primera versión (fase 1). Carga de DCP SMPTE e Interop, ficha de la CPL con detección de encriptado, lector MXF con índice, decodificación JPEG 2000 en WebAssembly con conversión XYZ → sRGB, línea de tiempo por toda la CPL con atajos, subtítulos SMPTE e Interop, y escucha del sonido con mezcla estéreo o por canales.
