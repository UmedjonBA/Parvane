#!/usr/bin/env python3
"""Минимальный RFB(VNC)-клиент: цепляется к Qt-VNC платформе, забирает один
кадр фреймбуфера и сохраняет в PNG. Нужен для АВТО-проверки GUI форка без
внешнего дисплея: форк запускается с QT_QPA_PLATFORM=vnc, этот скрипт снимает
скриншот, который агент читает глазами.

Использование: gui_grab.py <host> <port> <out.png> [timeout_sec]
Поддержка: RFB 3.3/3.8, security None, Raw-кодирование, форсированный 32bpp.
"""
import socket, struct, sys, time, zlib


def recvn(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise RuntimeError(f"соединение закрыто ({len(buf)}/{n} байт)")
        buf += chunk
    return buf


def write_png(path, w, h, rgb):
    """rgb: bytes длиной w*h*3."""
    raw = bytearray()
    stride = w * 3
    for y in range(h):
        raw.append(0)  # filter None
        raw += rgb[y * stride:(y + 1) * stride]

    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))  # 8bit RGB
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 6))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def _pointer(sock, x, y, mask):
    sock.sendall(struct.pack('>BBHH', 5, mask, x, y))


def click(sock, x, y):
    """ЛКМ по (x,y): move → down → up."""
    _pointer(sock, x, y, 0)
    time.sleep(0.05)
    _pointer(sock, x, y, 1)
    time.sleep(0.08)
    _pointer(sock, x, y, 0)
    time.sleep(0.05)


def grab(host, port, out, timeout=30, clicks=None):
    deadline = time.time() + timeout
    sock = None
    while time.time() < deadline:
        try:
            sock = socket.create_connection((host, port), timeout=5)
            break
        except OSError:
            time.sleep(0.5)
    if sock is None:
        raise RuntimeError(f"не удалось подключиться к {host}:{port} за {timeout}с")
    sock.settimeout(15)

    # 1. ProtocolVersion
    server_ver = recvn(sock, 12)
    is38 = (b'003.008' in server_ver) or (b'003.007' in server_ver)
    sock.sendall(b'RFB 003.008\n' if is38 else b'RFB 003.003\n')

    # 2. Security
    if is38:
        n = recvn(sock, 1)[0]
        if n == 0:
            reason = recvn(sock, struct.unpack('>I', recvn(sock, 4))[0])
            raise RuntimeError("сервер отверг: " + reason.decode('latin1'))
        types = recvn(sock, n)
        if 1 not in types:  # 1 = None
            raise RuntimeError(f"нет security None, есть: {list(types)}")
        sock.sendall(bytes([1]))
        res = struct.unpack('>I', recvn(sock, 4))[0]
        if res != 0:
            raise RuntimeError(f"SecurityResult={res}")
    else:
        sec = struct.unpack('>I', recvn(sock, 4))[0]
        if sec != 1:
            raise RuntimeError(f"RFB3.3 security={sec} (не None)")

    # 3. ClientInit (shared=1)
    sock.sendall(bytes([1]))

    # 4. ServerInit
    hdr = recvn(sock, 24)
    w, h = struct.unpack('>HH', hdr[:4])
    name_len = struct.unpack('>I', hdr[20:24])[0]
    recvn(sock, name_len)

    # 5. SetPixelFormat → 32bpp, true-color, R<<16 G<<8 B<<0, little-endian
    pf = struct.pack('>BBBBHHHBBB3x', 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
    sock.sendall(struct.pack('>Bxxx', 0) + pf)

    # 6. SetEncodings → только Raw(0)
    sock.sendall(struct.pack('>BxH', 2, 1) + struct.pack('>i', 0))

    # 6b. опциональные клики (например открыть диалог), затем даём UI отрисоваться
    if clicks:
        for (cx, cy) in clicks:
            click(sock, cx, cy)
        time.sleep(1.2)

    # 7. FramebufferUpdateRequest (полный, non-incremental)
    sock.sendall(struct.pack('>BBHHHH', 3, 0, 0, 0, w, h))

    # 8. читаем сообщения, пока не получим FramebufferUpdate с непустым кадром
    img = bytearray(w * h * 3)
    got = False
    end = time.time() + 20
    while time.time() < end:
        mtype = recvn(sock, 1)[0]
        if mtype == 0:  # FramebufferUpdate
            nrects = struct.unpack('>H', recvn(sock, 3)[1:3])[0]
            for _ in range(nrects):
                rx, ry, rw, rh, enc = struct.unpack('>HHHHi', recvn(sock, 12))
                if enc != 0:
                    raise RuntimeError(f"неожиданное кодирование {enc}")
                data = recvn(sock, rw * rh * 4)
                for yy in range(rh):
                    for xx in range(rw):
                        o = (yy * rw + xx) * 4
                        b, g, r = data[o], data[o + 1], data[o + 2]
                        po = ((ry + yy) * w + (rx + xx)) * 3
                        img[po] = r; img[po + 1] = g; img[po + 2] = b
                if rw > 4 and rh > 4:
                    got = True
            if got:
                break
            # пустой/куросор-апдейт — просим ещё раз
            sock.sendall(struct.pack('>BBHHHH', 3, 0, 0, 0, w, h))
            time.sleep(0.3)
        elif mtype == 1:  # SetColourMapEntries
            _first, ncol = struct.unpack('>HH', recvn(sock, 5)[1:5])
            recvn(sock, ncol * 6)
        elif mtype == 2:  # Bell
            pass
        elif mtype == 3:  # ServerCutText
            ln = struct.unpack('>I', recvn(sock, 7)[3:7])[0]
            recvn(sock, ln)
        else:
            raise RuntimeError(f"неизвестный тип сообщения {mtype}")

    sock.close()
    if not got:
        raise RuntimeError("кадр не получен")
    write_png(out, w, h, bytes(img))
    return w, h


if __name__ == '__main__':
    host = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 5900
    out = sys.argv[3] if len(sys.argv) > 3 else 'gui.png'
    timeout = float(sys.argv[4]) if len(sys.argv) > 4 else 30
    # клики через 5-й аргумент: "x1,y1;x2,y2"
    clicks = None
    if len(sys.argv) > 5 and sys.argv[5]:
        clicks = [tuple(int(v) for v in pair.split(','))
                  for pair in sys.argv[5].split(';') if pair]
    w, h = grab(host, port, out, timeout, clicks)
    print(f"снято {w}x{h} → {out}")
