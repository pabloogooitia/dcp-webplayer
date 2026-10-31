# DCP Web Player — Cines Babel

Reproductor de DCP (Digital Cinema Package) que funciona en el navegador, al estilo de DCP-o-matic Player. Se elige o se arrastra la carpeta de un DCP y se ve su ficha, la imagen fotograma a fotograma, los subtítulos encima y se puede escuchar el sonido. Está alojado en GitHub Pages y no necesita instalar nada ni paso de compilación: los archivos se sirven tal cual.

Los archivos se procesan en el navegador y no se suben a ningún sitio.

## Qué hace (fase 1 · visor de comprobación)
### Carga
- Acepta la carpeta de un DCP (botón o arrastrando la carpeta), varias a la vez o un disco entero. Si se cargan juntas una VF y su OV, la VF usa los archivos de la OV.
- Lee el ASSETMAP (SMPTE `ASSETMAP.xml` o Interop `ASSETMAP`), las PKL y las CPL. Si hay varias CPL, salen en una lista para elegir.
- Los MXF nunca se cargan enteros: se leen a trozos con `File.slice()` (partition packs, RIP, metadatos e índice) y de cada fotograma solo sus bytes. Funciona igual con un tráiler que con un largo de cientos de GB.

### Ficha de la CPL
- Veredicto bien visible: **Libre · no necesita KDM** o **Encriptado · necesita KDM: no se puede reproducir aquí** (cualquier pista con `<KeyId>`), qué pistas están encriptadas y cuántas claves.
- Título, tipo, SMPTE o Interop, duración (timecode y fotogramas), bobinas, resolución (2K/4K, Flat/Scope), perfil JPEG 2000, fps, 2D/3D, sonido (5.1/7.1, canales, kHz, Atmos), subtítulos e idioma, emisor, fecha, versión.
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

### Sonido
- Lee el MXF de audio (PCM 24 bits, 48 kHz) y reproduce unos segundos (3, 5, 10 o 20) desde la posición actual con Web Audio.
- Mezcla a estéreo (L, R, C a −3 dB, surrounds a su lado; sin LFE ni pistas de accesibilidad) o un canal suelto (L, R, C, LFE, Ls, Rs, HI, VI…). Vúmetros por canal para ver cuáles tienen señal; pulsando uno se escucha solo.
- Mientras suena, la posición, los subtítulos y la imagen (a resolución reducida, a los fotogramas por segundo que dé el ordenador) siguen al sonido.

## Atajos de teclado
| Tecla | Acción |
|---|---|
| ← → | fotograma anterior / siguiente |
| Mayús + ← → | ±1 segundo |
| ↑ ↓ | ±10 segundos |
| Inicio / Fin | principio / final |
| RePág / AvPág | bobina anterior / siguiente |
| Espacio | escuchar / parar |
| S | subtítulos sí / no |
| F | pantalla completa |

## Limitaciones
- **DCP encriptados**: no se pueden reproducir. La KDM solo la descifra la clave privada del servidor de cada sala. El player los detecta y lo avisa.
- **4K y tiempo real**: decodificar JPEG 2000 en el navegador, sin hilos WASM (GitHub Pages no permite las cabeceras COOP/COEP), no llega a 24 fps a resolución completa. Por eso la fase 1 es fotograma a fotograma y la reproducción continua irá en la fase 2, a resolución reducida.
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
- **Fase 2**: reproducción continua a resolución reducida, con un pool de workers, buffer de fotogramas por delante y sonido sincronizado.
- **Fase 3**: pulido (más atajos, comparar CPL, marcadores FFOC/LFOC, comprobación de hashes…).

## Licencia
[PolyForm Noncommercial 1.0.0](LICENSE.md). Uso comercial: pgoitiamartinez@gmail.com. El decodificador de `vendor/openjpeg` tiene su propia licencia (OpenJPEG, BSD de 2 cláusulas; empaquetado de Cornerstone, MIT): ver [vendor/openjpeg/LICENSE.md](vendor/openjpeg/LICENSE.md).

## Autor
Desarrollado por **Pablo Goitia Martinez** — [pgoitiamartinez@gmail.com](mailto:pgoitiamartinez@gmail.com)

## Changelog
- **v0.1** (31/10/2026): primera versión (fase 1). Carga de DCP SMPTE e Interop, ficha de la CPL con detección de encriptado, lector MXF con índice, decodificación JPEG 2000 en WebAssembly con conversión XYZ → sRGB, línea de tiempo por toda la CPL con atajos, subtítulos SMPTE e Interop, y escucha del sonido con mezcla estéreo o por canales.
