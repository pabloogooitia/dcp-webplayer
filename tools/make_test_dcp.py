#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generador de DCPs de prueba para el DCP Web Player (solo para desarrollo).

No hace falta para usar el player: sirve para tener DCPs pequeños y conocidos
con los que comprobar el lector de ASSETMAP/PKL/CPL, el lector MXF, el color,
los subtítulos y el sonido.

Requisitos: Python 3, numpy, Pillow y opj_compress (paquete libopenjp2-tools).

Uso:
    python3 tools/make_test_dcp.py carpeta_de_salida

Crea varios DCPs:
  - PRUEBA-SMPTE-FLAT   SMPTE, 2K Flat (1998x1080), 2 bobinas, 5.1 en 16 canales,
                        subtítulos SMPTE Timed Text (MXF con fuente incrustada).
  - PRUEBA-INTEROP-SCOPE Interop, 2K Scope (2048x858), 1 bobina, 5.1 (6 canales),
                        subtítulos Interop (XML + fuente + PNG).
  - PRUEBA-SMPTE-4K     SMPTE, 4K Scope (4096x1716), 1 bobina, 5.1.
  - PRUEBA-ENCRIPTADO   SMPTE, con <KeyId> en la CPL y esencia en tripletes
                        encriptados (bytes aleatorios: no es AES real).

El escritor MXF es mínimo (OP-Atom, frame wrapping, índice en el footer y RIP)
y está pensado para parecerse a lo que escribe asdcplib, no para pasar un
validador. La prueba definitiva tiene que ser con un DCP real.
"""
import base64
import datetime
import hashlib
import io
import math
import os
import struct
import subprocess
import sys
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

# ---------------------------------------------------------------- KLV / MXF

def ul(h):
    return bytes.fromhex(h.replace('.', '').replace(' ', ''))

K_PART = '060e2b34.02050101.0d010201.01'          # + tipo(1) + estado(1) + 00
K_PRIMER = ul('060e2b34.02050101.0d010201.01050100')
K_PREFACE = ul('060e2b34.02530101.0d010101.01012f00')
K_RGBA = ul('060e2b34.02530101.0d010101.01012900')
K_J2KSUB = ul('060e2b34.02530101.0d010101.01015a00')
K_WAVE = ul('060e2b34.02530101.0d010101.01014800')
K_TTDESC = ul('060e2b34.02530101.0d010101.01016400')
K_INDEX = ul('060e2b34.02530101.0d010201.01100100')
K_RIP = ul('060e2b34.02050101.0d010201.01110100')
K_FILL = ul('060e2b34.01010102.03010210.01000000')
K_J2K = ul('060e2b34.01020101.0d010301.15010801')
K_PCM = ul('060e2b34.01020101.0d010301.16010101')
K_TT = ul('060e2b34.01020101.0d010301.17010b01')
K_GS = ul('060e2b34.0101010c.0d010509.01000000')
K_CRYPT = ul('060e2b34.02040107.0d010301.027e0100')
OP_ATOM = ul('060e2b34.04010102.0d010210.00000000')
EC_J2K = ul('060e2b34.04010107.0d010301.020c0100')
EC_WAV = ul('060e2b34.04010101.0d010301.02060100')
EC_TT = ul('060e2b34.0401010a.0d010301.02130101')
EC_CRYPT = ul('060e2b34.04010107.0d010301.020b0100')


def ber(n, size=4):
    """Longitud BER en forma larga con `size` bytes (0x83 + 3 bytes, etc.)."""
    return bytes([0x80 | size]) + n.to_bytes(size, 'big')


def klv(key, value, size=4):
    return key + ber(len(value), size) + value


def fill_to(pos, kag):
    """KLV de relleno para que lo siguiente empiece en múltiplo de kag."""
    if kag <= 1:
        return b''
    need = (-pos) % kag
    if need == 0:
        return b''
    if need < 20:
        need += kag
    return klv(K_FILL, b'\0' * (need - 20))


def local_set(key, items):
    v = b''.join(struct.pack('>HH', t, len(d)) + d for t, d in items)
    return klv(key, v)


def partition(kind, status, this, prev, footer, hbc, ibc, index_sid, body_offset, body_sid, ecs, kag):
    key = ul(K_PART + '%02x%02x00' % (kind, status))
    v = struct.pack('>HHI', 1, 3, kag)
    v += struct.pack('>QQQQQ', this, prev, footer, hbc, ibc)
    v += struct.pack('>IQI', index_sid, body_offset, body_sid)
    v += OP_ATOM
    v += struct.pack('>II', len(ecs), 16) + b''.join(ecs)
    return klv(key, v)


def rational(n, d):
    return struct.pack('>ii', n, d)


def index_segments(edit_rate, offsets=None, count=0, eubc=0, per_seg=30):
    """Segmentos de índice. VBR: offsets (StreamOffset de cada fotograma).
    CBR: eubc (EditUnitByteCount) y count."""
    out = b''
    if offsets is None:
        items = [(0x3c0a, uuid.uuid4().bytes), (0x3f0b, rational(*edit_rate)),
                 (0x3f0c, struct.pack('>q', 0)), (0x3f0d, struct.pack('>q', count)),
                 (0x3f05, struct.pack('>I', eubc)), (0x3f06, struct.pack('>I', 129)),
                 (0x3f07, struct.pack('>I', 1)), (0x3f08, b'\0'), (0x3f0e, b'\0')]
        return local_set(K_INDEX, items)
    for start in range(0, len(offsets), per_seg):
        chunk = offsets[start:start + per_seg]
        arr = struct.pack('>II', len(chunk), 11)
        for o in chunk:
            arr += struct.pack('>bbBQ', 0, 0, 0x80, o)
        items = [(0x3c0a, uuid.uuid4().bytes), (0x3f0b, rational(*edit_rate)),
                 (0x3f0c, struct.pack('>q', start)), (0x3f0d, struct.pack('>q', len(chunk))),
                 (0x3f05, struct.pack('>I', 0)), (0x3f06, struct.pack('>I', 129)),
                 (0x3f07, struct.pack('>I', 1)), (0x3f08, b'\0'), (0x3f0e, b'\0'),
                 (0x3f0a, arr)]
        out += local_set(K_INDEX, items)
    return out


def write_mxf(path, ec, descriptor_sets, frames, frame_key, edit_rate, cbr=False,
              generic=None, kag=512):
    """Escribe un MXF OP-Atom: header (metadatos) · body (esencia) · [generic stream] · footer (índice) · RIP."""
    # Metadatos de cabecera: primer + preface + descriptores
    primer_items = [(0x3c0a, ul('060e2b34.01010101.01011502.00000000')),
                    (0x3001, ul('060e2b34.01010101.04060101.00000000')),
                    (0x3002, ul('060e2b34.01010102.04060102.00000000')),
                    (0x3203, ul('060e2b34.01010101.04010502.02000000')),
                    (0x3202, ul('060e2b34.01010101.04010502.01000000')),
                    (0x3d03, ul('060e2b34.01010105.04020301.01010000')),
                    (0x3d07, ul('060e2b34.01010105.04020101.04000000')),
                    (0x3d01, ul('060e2b34.01010104.04020303.04000000'))]
    primer = klv(K_PRIMER, struct.pack('>II', len(primer_items), 18) +
                 b''.join(struct.pack('>H', t) + u for t, u in primer_items))
    meta = primer + local_set(K_PREFACE, [(0x3c0a, uuid.uuid4().bytes)])
    for key, items in descriptor_sets:
        meta += local_set(key, items)

    ecs = [ec]
    # Esencia: cuerpo
    body_data = bytearray()
    offsets = []
    for fr in frames:
        offsets.append(len(body_data))
        body_data += klv(frame_key, fr, 4)
    gs_data = b''
    if generic:
        for g in generic:
            gs_data += klv(K_GS, g, 4)

    # Dos pasadas: primero tamaños, luego offsets reales.
    def build(pos_body, pos_gs, pos_footer):
        hp = partition(2, 4, 0, 0, pos_footer, 0, 0, 0, 0, 0, ecs, kag)
        f1 = fill_to(len(hp), kag)
        hm = meta + fill_to(len(hp) + len(f1) + len(meta), kag)
        hp = partition(2, 4, 0, 0, pos_footer, len(hm), 0, 0, 0, 0, ecs, kag)
        head = hp + f1 + hm
        bp = partition(3, 4, pos_body, 0, pos_footer, 0, 0, 0, 0, 1, ecs, kag)
        bf = fill_to(pos_body + len(bp), kag)
        body = bp + bf + bytes(body_data)
        gs = b''
        if generic:
            gp = partition(3, 0x11 if False else 4, pos_gs, pos_body, pos_footer, 0, 0, 0, 0, 2, ecs, kag)
            gp = ul(K_PART + '0311' + '00') + gp[16:]   # clave de partición generic stream
            gs = gp + gs_data
        if cbr:
            idx = index_segments(edit_rate, count=len(frames), eubc=len(klv(frame_key, frames[0], 4)))
        else:
            idx = index_segments(edit_rate, offsets=offsets)
        prev = pos_gs if generic else pos_body
        fp = partition(4, 4, pos_footer, prev, pos_footer, 0, len(idx), 129, 0, 0, ecs, kag)
        footer = fp + idx
        parts = [(0, 0), (1, pos_body)] + ([(2, pos_gs)] if generic else []) + [(0, pos_footer)]
        ripv = b''.join(struct.pack('>IQ', s, o) for s, o in parts)
        riplen = 16 + 4 + len(ripv) + 4
        rip = klv(K_RIP, ripv + struct.pack('>I', riplen))
        return head, body, gs, footer, rip

    head, body, gs, footer, rip = build(0, 0, 0)
    pos_body = len(head)
    head, body, gs, footer, rip = build(pos_body, 0, 0)
    pos_gs = pos_body + len(body)
    pos_footer = pos_gs + len(gs)
    head, body, gs, footer, rip = build(pos_body, pos_gs, pos_footer)
    assert len(head) == pos_body
    with open(path, 'wb') as f:
        f.write(head); f.write(body); f.write(gs); f.write(footer); f.write(rip)


# ---------------------------------------------------------------- imagen

M_RGB2XYZ = np.array([[0.4124564, 0.3575761, 0.1804375],
                      [0.2126729, 0.7151522, 0.0721750],
                      [0.0193339, 0.1191920, 0.9503041]])


def srgb_to_xyz12(img):
    """RGB 8 bits sRGB -> X'Y'Z' 12 bits (gamma 2.6, normalización DCI 48/52.37)."""
    a = np.asarray(img, dtype=np.float64) / 255.0
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    xyz = lin @ M_RGB2XYZ.T
    xyz = np.clip(xyz * (48.0 / 52.37), 0, 1)
    cv = np.round(xyz ** (1 / 2.6) * 4095).astype('>u2')
    return np.ascontiguousarray(cv.transpose(2, 0, 1))   # planar


BARS = [(191, 191, 191), (191, 191, 0), (0, 191, 191), (0, 191, 0),
        (191, 0, 191), (191, 0, 0), (0, 0, 191)]


def draw_frame(w, h, label, reel, n, total, fps, flash, eye=None):
    im = Image.new('RGB', (w, h), (24, 26, 32))
    d = ImageDraw.Draw(im)
    # degradado gris abajo (para ver la curva de gamma)
    gy = int(h * 0.78)
    for x in range(w):
        v = int(255 * x / (w - 1))
        d.line([(x, gy), (x, h - 1)], fill=(v, v, v))
    # barras de color
    bw = w / len(BARS)
    for i, c in enumerate(BARS):
        d.rectangle([int(i * bw), 0, int((i + 1) * bw) - 1, int(h * 0.30)], fill=c)
    # marco del área activa
    d.rectangle([0, 0, w - 1, h - 1], outline=(255, 255, 255), width=4)
    s = h / 1080
    big = ImageFont.truetype(FONT, int(72 * s))
    mid = ImageFont.truetype(FONT_REG, int(44 * s))
    d.text((int(60 * s), int(h * 0.34)), label, font=big, fill=(255, 255, 255))
    secs = n / fps
    tc = '%02d:%02d:%02d:%02d' % (secs // 3600, (secs // 60) % 60, int(secs) % 60, n % fps)
    d.text((int(60 * s), int(h * 0.34 + 100 * s)),
           'Bobina %d · fotograma %d de %d · %s' % (reel, n, total, tc), font=mid, fill=(230, 230, 230))
    if eye:
        d.text((int(60 * s), int(h * 0.34 + 160 * s)), 'Ojo ' + eye, font=mid, fill=(255, 200, 0))
    # cuadro que se mueve un paso por fotograma
    bx = int((w - 120 * s) * (n % fps) / max(1, fps - 1))
    d.rectangle([bx, int(h * 0.62), bx + int(120 * s), int(h * 0.74)], fill=(255, 128, 0))
    if flash:
        d.rectangle([w - int(260 * s), int(h * 0.34), w - int(60 * s), int(h * 0.34 + 200 * s)], fill=(255, 255, 255))
    return im


def encode_j2k(img, cinema, tmp):
    w, h = img.size
    raw = os.path.join(tmp, '%s.raw' % uuid.uuid4().hex)
    out = raw[:-4] + '.j2c'
    srgb_to_xyz12(img).tofile(raw)
    args = ['opj_compress', '-i', raw, '-o', out, '-F', '%d,%d,3,12,u' % (w, h)]
    args += ['-cinema4K'] if cinema == '4K' else ['-cinema2K', '24']
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    data = open(out, 'rb').read()
    os.remove(raw); os.remove(out)
    return data


# ---------------------------------------------------------------- audio

def audio_frames(nframes, fps, channels, reel):
    """PCM 24 bits LE, 48 kHz. Cada canal con un tono distinto (L 440, R 550,
    C 660, LFE 55, Ls 770, Rs 880 Hz) y un pitido de 1 kHz en el primer
    fotograma de cada segundo, igual que el destello blanco de la imagen."""
    spf = 48000 // fps
    tones = [440, 550, 660, 55, 770, 880]
    t = np.arange(nframes * spf) / 48000.0
    data = np.zeros((len(t), channels))
    for c in range(min(6, channels)):
        # cada canal suena solo en su "turno" de 1/6 de segundo para identificarlo
        gate = ((np.floor(t * 6) % 6) == c).astype(float)
        data[:, c] = 0.2 * np.sin(2 * np.pi * tones[c] * t) * (0.25 + 0.75 * gate)
    beep = ((t * fps) % fps) < 1
    for c in range(min(6, channels)):
        data[beep, c] = 0.3 * np.sin(2 * np.pi * 1000 * t[beep])
    ints = np.round(data * 8388607).astype('<i4')
    b = ints.astype('<i4').view(np.uint8).reshape(-1, channels, 4)[:, :, :3]
    b = b.reshape(nframes, spf * channels * 3)
    return [bytes(r) for r in b]


# ---------------------------------------------------------------- XML

def now():
    return datetime.datetime(2026, 10, 31, 12, 0, 0).strftime('%Y-%m-%dT%H:%M:%S+01:00')


def sha1b64(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return base64.b64encode(h.digest()).decode()


def tc_smpte(frames, fps):
    s = frames // fps
    return '%02d:%02d:%02d:%02d' % (s // 3600, (s // 60) % 60, s % 60, frames % fps)


def tc_interop(seconds):
    ticks = int(round(seconds * 250))
    s = ticks // 250
    return '%02d:%02d:%02d:%03d' % (s // 3600, (s // 60) % 60, s % 60, ticks % 250)


def subs_lines(reel):
    """(entrada_s, salida_s, [líneas]) para cada bobina."""
    return [
        (0.5, 1.6, ['Bobina %d · primer subtítulo' % reel, 'con dos líneas: ¿se ven las tildes? ñ á é í ó ú']),
        (1.75, 2.9, ['<i>Texto en cursiva</i> abajo']),
    ]


def smpte_subtitle_xml(sid, reel, fps, title, font_id_urn, png_id=None):
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<SubtitleReel xmlns="http://www.smpte-ra.org/schemas/428-7/2010/DCST" xmlns:xs="http://www.w3.org/2001/XMLSchema">',
           '  <Id>urn:uuid:%s</Id>' % sid,
           '  <ContentTitleText>%s</ContentTitleText>' % title,
           '  <IssueDate>%s</IssueDate>' % now(),
           '  <ReelNumber>%d</ReelNumber>' % reel,
           '  <Language>es</Language>',
           '  <EditRate>%d 1</EditRate>' % fps,
           '  <TimeCodeRate>%d</TimeCodeRate>' % fps,
           '  <StartTime>00:00:00:00</StartTime>',
           '  <LoadFont ID="Fuente1">urn:uuid:%s</LoadFont>' % font_id_urn,
           '  <SubtitleList>',
           '    <Font ID="Fuente1" Size="42" Weight="normal" Color="FFFFFFFF" Effect="border" EffectColor="FF000000">']
    n = 1
    for tin, tout, lines in subs_lines(reel):
        out.append('      <Subtitle SpotNumber="%d" TimeIn="%s" TimeOut="%s" FadeUpTime="00:00:00:00" FadeDownTime="00:00:00:00">'
                   % (n, tc_smpte(int(tin * fps), fps), tc_smpte(int(tout * fps), fps)))
        for i, line in enumerate(lines):
            vpos = 8 + 6 * (len(lines) - 1 - i)
            line = line.replace('<i>', '<Font Italic="yes">').replace('</i>', '</Font>')
            out.append('        <Text Valign="bottom" Vposition="%d" Halign="center" Hposition="0" Direction="ltr">%s</Text>' % (vpos, line))
        out.append('      </Subtitle>')
        n += 1
    out.append('      <Subtitle SpotNumber="%d" TimeIn="%s" TimeOut="%s" FadeUpTime="00:00:00:00" FadeDownTime="00:00:00:00">'
               % (n, tc_smpte(int(0.5 * fps), fps), tc_smpte(int(2.9 * fps), fps)))
    out.append('        <Text Valign="top" Vposition="10" Halign="left" Hposition="5" Direction="ltr"><Font Color="FFFFFF00">Rótulo arriba a la izquierda (amarillo)</Font></Text>')
    out.append('      </Subtitle>')
    if png_id:
        n += 1
        out.append('      <Subtitle SpotNumber="%d" TimeIn="%s" TimeOut="%s" FadeUpTime="00:00:00:00" FadeDownTime="00:00:00:00">'
                   % (n, tc_smpte(int(3.2 * fps), fps), tc_smpte(int(6.5 * fps), fps)))
        out.append('        <Image Valign="bottom" Vposition="10" Halign="center">urn:uuid:%s</Image>' % png_id)
        out.append('      </Subtitle>')
    out += ['    </Font>', '  </SubtitleList>', '</SubtitleReel>']
    return '\n'.join(out).encode('utf-8')


def interop_subtitle_xml(sid, reel, title, png_name):
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<DCSubtitle Version="1.0">',
           '  <SubtitleID>%s</SubtitleID>' % sid,
           '  <MovieTitle>%s</MovieTitle>' % title,
           '  <ReelNumber>%d</ReelNumber>' % reel,
           '  <Language>es</Language>',
           '  <LoadFont Id="Fuente1" URI="fuente.ttf"/>',
           '  <Font Id="Fuente1" Color="FFFFFFFF" Effect="border" EffectColor="FF000000" Italic="no" Size="42">']
    n = 1
    for tin, tout, lines in subs_lines(reel):
        out.append('    <Subtitle SpotNumber="%d" TimeIn="%s" TimeOut="%s" FadeUpTime="20" FadeDownTime="20">'
                   % (n, tc_interop(tin), tc_interop(tout)))
        for i, line in enumerate(lines):
            vpos = 8 + 6 * (len(lines) - 1 - i)
            line = line.replace('<i>', '<Font Italic="yes">').replace('</i>', '</Font>')
            out.append('      <Text VAlign="bottom" VPosition="%d" HAlign="center">%s</Text>' % (vpos, line))
        out.append('    </Subtitle>')
        n += 1
    out.append('    <Subtitle SpotNumber="%d" TimeIn="%s" TimeOut="%s" FadeUpTime="0" FadeDownTime="0">'
               % (n, tc_interop(0.5), tc_interop(2.9)))
    out.append('      <Image VAlign="top" VPosition="8" HAlign="center">%s</Image>' % png_name)
    out.append('    </Subtitle>')
    out += ['  </Font>', '</DCSubtitle>']
    return '\n'.join(out).encode('utf-8')


def make_png_sub(path, text='Subtítulo PNG (Interop)'):
    im = Image.new('RGBA', (900, 110), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, 899, 109], 18, fill=(0, 0, 0, 170))
    d.text((30, 22), text, font=ImageFont.truetype(FONT, 54), fill=(120, 220, 255, 255))
    im.save(path)


# ---------------------------------------------------------------- DCP

class DCP:
    def __init__(self, root, name, smpte=True):
        self.root = os.path.join(root, name)
        os.makedirs(self.root, exist_ok=True)
        self.smpte = smpte
        self.assets = []   # (uuid, filename, type, annotation)
        self.name = name

    def add(self, aid, fname, kind):
        self.assets.append((aid, fname, kind))

    def finish(self, cpls, title):
        """cpls: [(cpl_uuid, xml_bytes)]"""
        for cid, xml in cpls:
            fn = 'CPL_%s.xml' % cid
            open(os.path.join(self.root, fn), 'wb').write(xml)
            self.add(cid, fn, 'CPL')
        pkl_id = str(uuid.uuid4())
        if self.smpte:
            ns = 'http://www.smpte-ra.org/schemas/429-8/2007/PKL'
        else:
            ns = 'http://www.digicine.com/PROTO-ASDCP-PKL-20040311#'
        lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<PackingList xmlns="%s">' % ns,
                 '  <Id>urn:uuid:%s</Id>' % pkl_id, '  <AnnotationText>%s</AnnotationText>' % title,
                 '  <IssueDate>%s</IssueDate>' % now(), '  <Issuer>DCP Web Player (prueba)</Issuer>',
                 '  <Creator>make_test_dcp.py</Creator>', '  <AssetList>']
        for aid, fn, kind in self.assets:
            p = os.path.join(self.root, fn)
            if kind == 'CPL':
                t = 'text/xml' if self.smpte else 'text/xml;asdcpKind=CPL'
            elif kind == 'XML':
                t = 'text/xml' if self.smpte else 'text/xml;asdcpKind=Subtitle'
            elif kind == 'TTF':
                t = 'application/x-font-ttf'
            elif kind == 'PNG':
                t = 'image/png'
            else:
                t = 'application/mxf'
            lines += ['    <Asset>', '      <Id>urn:uuid:%s</Id>' % aid,
                      '      <Hash>%s</Hash>' % sha1b64(p), '      <Size>%d</Size>' % os.path.getsize(p),
                      '      <Type>%s</Type>' % t, '      <OriginalFileName>%s</OriginalFileName>' % os.path.basename(fn),
                      '    </Asset>']
        lines += ['  </AssetList>', '</PackingList>']
        pkl_fn = 'PKL_%s.xml' % pkl_id
        open(os.path.join(self.root, pkl_fn), 'w', encoding='utf-8').write('\n'.join(lines))

        # ASSETMAP + VOLINDEX
        if self.smpte:
            ns = 'http://www.smpte-ra.org/schemas/429-9/2007/AM'
            am_fn, vi_fn = 'ASSETMAP.xml', 'VOLINDEX.xml'
        else:
            ns = 'http://www.digicine.com/PROTO-ASDCP-AM-20040311#'
            am_fn, vi_fn = 'ASSETMAP', 'VOLINDEX'
        lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<AssetMap xmlns="%s">' % ns,
                 '  <Id>urn:uuid:%s</Id>' % uuid.uuid4(), '  <Creator>make_test_dcp.py</Creator>',
                 '  <VolumeCount>1</VolumeCount>', '  <IssueDate>%s</IssueDate>' % now(),
                 '  <Issuer>DCP Web Player (prueba)</Issuer>', '  <AssetList>']
        for aid, fn, kind in [(pkl_id, pkl_fn, 'PKL')] + self.assets:
            lines += ['    <Asset>', '      <Id>urn:uuid:%s</Id>' % aid]
            if kind == 'PKL':
                lines.append('      <PackingList>true</PackingList>')
            lines += ['      <ChunkList>', '        <Chunk>', '          <Path>%s</Path>' % fn]
            if not self.smpte:
                lines += ['          <VolumeIndex>1</VolumeIndex>', '          <Offset>0</Offset>',
                          '          <Length>%d</Length>' % os.path.getsize(os.path.join(self.root, fn))]
            lines += ['        </Chunk>', '      </ChunkList>', '    </Asset>']
        lines += ['  </AssetList>', '</AssetMap>']
        open(os.path.join(self.root, am_fn), 'w', encoding='utf-8').write('\n'.join(lines))
        if self.smpte:
            vi = '<?xml version="1.0" encoding="UTF-8"?>\n<VolumeIndex xmlns="%s">\n  <Index>1</Index>\n</VolumeIndex>\n' % ns
        else:
            vi = '<?xml version="1.0" encoding="UTF-8"?>\n<VolumeIndex xmlns="%s">\n  <Index>1</Index>\n</VolumeIndex>\n' % ns
        open(os.path.join(self.root, vi_fn), 'w').write(vi)


def picture_descriptor(w, h, fps, n, ratio):
    return [(K_RGBA, [(0x3c0a, uuid.uuid4().bytes), (0x3001, rational(fps, 1)),
                      (0x3002, struct.pack('>q', n)), (0x3203, struct.pack('>I', w)),
                      (0x3202, struct.pack('>I', h)), (0x320e, rational(*ratio))]),
            (K_J2KSUB, [(0x3c0a, uuid.uuid4().bytes)])]


def sound_descriptor(fps, n, ch):
    return [(K_WAVE, [(0x3c0a, uuid.uuid4().bytes), (0x3001, rational(fps, 1)),
                      (0x3002, struct.pack('>q', n)), (0x3d03, rational(48000, 1)),
                      (0x3d07, struct.pack('>I', ch)), (0x3d01, struct.pack('>I', 24)),
                      (0x3d0a, struct.pack('>H', 3 * ch)), (0x3d09, struct.pack('>I', 3 * ch * 48000))])]


def build(out, cfg, pool, tmp):
    smpte = cfg['smpte']
    w, h, fps = cfg['w'], cfg['h'], 24
    dcp = DCP(out, cfg['name'], smpte)
    title = cfg['title']
    reels = []
    for r, nfr in enumerate(cfg['reels'], 1):
        reel = {'id': str(uuid.uuid4()), 'n': nfr}
        label = cfg['label']
        imgs = [draw_frame(w, h, label, r, i, nfr, fps, i % fps == 0) for i in range(nfr)]
        if cfg.get('encrypted'):
            rnd = np.random.default_rng(r)
            frames = []
            for i in range(nfr):
                src = rnd.bytes(20000)
                # triplete encriptado (SMPTE 429-6): ContextID, PlaintextOffset, SourceKey, SourceLength, ESV
                v = ber(16) + uuid.uuid4().bytes + ber(8) + struct.pack('>Q', 0) + ber(16) + K_J2K
                v += ber(8) + struct.pack('>Q', len(src)) + ber(len(src) + 32) + rnd.bytes(len(src) + 32)
                frames.append(v)
            key, ec = K_CRYPT, EC_CRYPT
        else:
            frames = list(pool.map(lambda im: encode_j2k(im, cfg['cinema'], tmp), imgs))
            key, ec = K_J2K, EC_J2K
        pid = str(uuid.uuid4())
        pfn = 'j2c_%s.mxf' % pid
        write_mxf(os.path.join(dcp.root, pfn), ec, picture_descriptor(w, h, fps, nfr, cfg['ratio']),
                  frames, key, (fps, 1))
        dcp.add(pid, pfn, 'MXF')
        reel['pic'] = pid
        reel['key'] = str(uuid.uuid4()) if cfg.get('encrypted') else None
        # sonido
        if cfg.get('channels'):
            sid = str(uuid.uuid4())
            sfn = 'pcm_%s.mxf' % sid
            af = audio_frames(nfr, fps, cfg['channels'], r)
            if cfg.get('encrypted'):
                af = [ber(16) + uuid.uuid4().bytes + ber(8) + struct.pack('>Q', 0) + ber(16) + K_PCM +
                      ber(8) + struct.pack('>Q', len(a)) + ber(len(a) + 32) + os.urandom(len(a) + 32) for a in af]
                write_mxf(os.path.join(dcp.root, sfn), EC_CRYPT, sound_descriptor(fps, nfr, cfg['channels']),
                          af, K_CRYPT, (fps, 1), cbr=False)
                reel['skey'] = str(uuid.uuid4())
            else:
                write_mxf(os.path.join(dcp.root, sfn), EC_WAV, sound_descriptor(fps, nfr, cfg['channels']),
                          af, K_PCM, (fps, 1), cbr=True)
            dcp.add(sid, sfn, 'MXF')
            reel['snd'] = sid
        # subtítulos
        if cfg.get('subs') == 'smpte':
            tid = str(uuid.uuid4())
            font_id = str(uuid.uuid4())
            png_id = str(uuid.uuid4())
            png_path = os.path.join(tmp, 'sub_%s.png' % png_id)
            make_png_sub(png_path, 'Subtítulo PNG (SMPTE)')
            xml = smpte_subtitle_xml(tid, r, fps, title, font_id, png_id)
            tfn = 'sub_%s.mxf' % tid
            write_mxf(os.path.join(dcp.root, tfn), EC_TT,
                      [(K_TTDESC, [(0x3c0a, uuid.uuid4().bytes), (0x3001, rational(fps, 1)),
                                   (0x3002, struct.pack('>q', nfr))])],
                      [xml], K_TT, (fps, 1), cbr=False, generic=[open(FONT_REG, 'rb').read(), open(png_path, 'rb').read()])
            dcp.add(tid, tfn, 'MXF')
            reel['sub'] = tid
        elif cfg.get('subs') == 'interop':
            tid = str(uuid.uuid4())
            png = 'sub_%d.png' % r
            make_png_sub(os.path.join(dcp.root, png))
            xml = interop_subtitle_xml(tid, r, title, png)
            tfn = 'sub_%s.xml' % tid
            open(os.path.join(dcp.root, tfn), 'wb').write(xml)
            dcp.add(tid, tfn, 'XML')
            if r == 1:
                import shutil
                shutil.copy(FONT_REG, os.path.join(dcp.root, 'fuente.ttf'))
                dcp.add(str(uuid.uuid4()), 'fuente.ttf', 'TTF')
            dcp.add(str(uuid.uuid4()), png, 'PNG')
            reel['sub'] = tid
        reels.append(reel)

    cpl_id = str(uuid.uuid4())
    if smpte:
        cpl = smpte_cpl(cpl_id, cfg, reels, fps)
    else:
        cpl = interop_cpl(cpl_id, cfg, reels, fps)
    dcp.finish([(cpl_id, cpl.encode('utf-8'))], title)
    print('  ->', dcp.root)


def smpte_cpl(cid, cfg, reels, fps):
    w, h = cfg['w'], cfg['h']
    sar = '%d %d' % (w, h)
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/429-7/2006/CPL">',
         '  <Id>urn:uuid:%s</Id>' % cid,
         '  <AnnotationText>%s</AnnotationText>' % cfg['title'],
         '  <IssueDate>%s</IssueDate>' % now(),
         '  <Issuer>DCP Web Player (prueba)</Issuer>',
         '  <Creator>make_test_dcp.py</Creator>',
         '  <ContentTitleText>%s</ContentTitleText>' % cfg['title'],
         '  <ContentKind scope="http://www.smpte-ra.org/schemas/429-7/2006/CPL#standard-content">%s</ContentKind>' % cfg['kind'],
         '  <ContentVersion>', '    <Id>urn:uuid:%s_v1</Id>' % cid, '    <LabelText>v1</LabelText>', '  </ContentVersion>',
         '  <RatingList/>', '  <ReelList>']
    for i, r in enumerate(reels):
        n = r['n']
        ep = cfg.get('entry', 0)
        L += ['    <Reel>', '      <Id>urn:uuid:%s</Id>' % r['id'], '      <AssetList>']
        if i == 0:
            L += ['        <meta:CompositionMetadataAsset xmlns:meta="http://www.smpte-ra.org/schemas/429-16/2014/CPL-Metadata">',
                  '          <Id>urn:uuid:%s</Id>' % uuid.uuid4(), '          <EditRate>%d 1</EditRate>' % fps,
                  '          <IntrinsicDuration>%d</IntrinsicDuration>' % sum(x['n'] for x in reels),
                  '          <meta:FullContentTitleText>%s</meta:FullContentTitleText>' % cfg['title'],
                  '          <meta:MainSoundConfiguration>51/L,R,C,LFE,Ls,Rs%s</meta:MainSoundConfiguration>' % (',-' * (cfg.get('channels', 6) - 6)),
                  '          <meta:MainSoundSampleRate>48000 1</meta:MainSoundSampleRate>',
                  '          <meta:MainPictureStoredArea><meta:Width>%d</meta:Width><meta:Height>%d</meta:Height></meta:MainPictureStoredArea>' % (w, h),
                  '          <meta:MainPictureActiveArea><meta:Width>%d</meta:Width><meta:Height>%d</meta:Height></meta:MainPictureActiveArea>' % (w, h),
                  '        </meta:CompositionMetadataAsset>']

        def asset(tag, aid, extra, key=None):
            out = ['        <%s>' % tag, '          <Id>urn:uuid:%s</Id>' % aid,
                   '          <EditRate>%d 1</EditRate>' % fps,
                   '          <IntrinsicDuration>%d</IntrinsicDuration>' % n,
                   '          <EntryPoint>%d</EntryPoint>' % ep, '          <Duration>%d</Duration>' % (n - ep)]
            if key:
                out.append('          <KeyId>urn:uuid:%s</KeyId>' % key)
            return out + extra + ['        </%s>' % tag]
        L += asset('MainPicture', r['pic'], ['          <FrameRate>%d 1</FrameRate>' % fps,
                                             '          <ScreenAspectRatio>%s</ScreenAspectRatio>' % sar], r.get('key'))
        if r.get('snd'):
            L += asset('MainSound', r['snd'], [], r.get('skey'))
        if r.get('sub'):
            L += asset('MainSubtitle', r['sub'], ['          <Language>es</Language>'])
        L += ['      </AssetList>', '    </Reel>']
    L += ['  </ReelList>', '</CompositionPlaylist>']
    return '\n'.join(L)


def interop_cpl(cid, cfg, reels, fps):
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<CompositionPlaylist xmlns="http://www.digicine.com/PROTO-ASDCP-CPL-20040511#">',
         '  <Id>urn:uuid:%s</Id>' % cid,
         '  <AnnotationText>%s</AnnotationText>' % cfg['title'],
         '  <IssueDate>%s</IssueDate>' % now(),
         '  <Issuer>DCP Web Player (prueba)</Issuer>',
         '  <Creator>make_test_dcp.py</Creator>',
         '  <ContentTitleText>%s</ContentTitleText>' % cfg['title'],
         '  <ContentKind>%s</ContentKind>' % cfg['kind'],
         '  <ContentVersion>', '    <Id>urn:uri:%s_v1</Id>' % cid, '    <LabelText>v1</LabelText>', '  </ContentVersion>',
         '  <RatingList/>', '  <ReelList>']
    for r in reels:
        n = r['n']
        L += ['    <Reel>', '      <Id>urn:uuid:%s</Id>' % r['id'], '      <AssetList>']

        def asset(tag, aid, extra):
            return ['        <%s>' % tag, '          <Id>urn:uuid:%s</Id>' % aid,
                    '          <EditRate>%d 1</EditRate>' % fps,
                    '          <IntrinsicDuration>%d</IntrinsicDuration>' % n,
                    '          <EntryPoint>0</EntryPoint>', '          <Duration>%d</Duration>' % n] + extra + ['        </%s>' % tag]
        L += asset('MainPicture', r['pic'], ['          <FrameRate>%d 1</FrameRate>' % fps,
                                             '          <ScreenAspectRatio>%s</ScreenAspectRatio>' % cfg['sar']])
        if r.get('snd'):
            L += asset('MainSound', r['snd'], [])
        if r.get('sub'):
            L += asset('MainSubtitle', r['sub'], [])
        L += ['      </AssetList>', '    </Reel>']
    L += ['  </ReelList>', '</CompositionPlaylist>']
    return '\n'.join(L)


CONFIGS = [
    dict(name='PRUEBA-SMPTE-FLAT', title='Prueba_TST_F_ES-XX_51_2K_DWP_20261031_SMPTE_OV',
         label='SMPTE · 2K FLAT', smpte=True, w=1998, h=1080, ratio=(1998, 1080), cinema='2K',
         reels=[168, 96], channels=16, subs='smpte', kind='test'),
    dict(name='PRUEBA-INTEROP-SCOPE', title='Prueba_TST_S_ES-XX_51_2K_DWP_20261031_IOP_OV',
         label='INTEROP · 2K SCOPE', smpte=False, w=2048, h=858, ratio=(2048, 858), sar='2.39', cinema='2K',
         reels=[72], channels=6, subs='interop', kind='trailer'),
    dict(name='PRUEBA-SMPTE-4K', title='Prueba_TST_S_ES-XX_51_4K_DWP_20261031_SMPTE_OV',
         label='SMPTE · 4K SCOPE', smpte=True, w=4096, h=1716, ratio=(4096, 1716), cinema='4K',
         reels=[28], channels=6, kind='test', entry=4),
    dict(name='PRUEBA-ENCRIPTADO', title='Prueba_FTR_F_ES-XX_51_2K_DWP_20261031_SMPTE_OV',
         label='ENCRIPTADO', smpte=True, w=1998, h=1080, ratio=(1998, 1080), cinema='2K',
         reels=[24], channels=6, encrypted=True, kind='feature'),
]

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'dcps'
    only = sys.argv[2:]
    os.makedirs(out, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp, ThreadPoolExecutor(os.cpu_count() or 2) as pool:
        for cfg in CONFIGS:
            if only and cfg['name'] not in only:
                continue
            print(cfg['name'])
            build(out, cfg, pool, tmp)
