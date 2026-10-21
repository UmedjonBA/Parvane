#!/usr/bin/env python3
"""Пульт GUI форка под Qt-VNC (поверх gui_grab.py): gui_ctl.py <port> <out.png|-> "<действия>"
Действия через ';': c X,Y (ЛКМ) | r X,Y (ПКМ) | dc X,Y (двойной) | d X1,Y1>X2,Y2 (перетаскивание)
| m X,Y (навести) | t текст | k Name (Escape/Return/Tab/BackSpace/ctrl+k …) | w сек | s X,Y,N колесо (Qt-VNC его не передаёт —
прокрутка перетаскиванием полосы)"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gui_grab as g
KS = {'Escape':0xff1b,'Return':0xff0d,'Tab':0xff09,'BackSpace':0xff08,'Delete':0xffff,'Down':0xff54,'Up':0xff52,
      'Left':0xff51,'Right':0xff53,'ctrl':0xffe3,'shift':0xffe1,'alt':0xffe9,'End':0xff57,'Home':0xff50}
def key(sock, spec):
    parts = spec.split('+')
    syms = [KS.get(p, ord(p) if len(p) == 1 else None) for p in parts]
    for s in syms: g._key(sock, s, True); time.sleep(0.04)
    for s in reversed(syms): g._key(sock, s, False); time.sleep(0.04)
def xy(s): return tuple(int(v) for v in s.split(','))
def run(sock, acts):
    for a in [x.strip() for x in acts.split(';') if x.strip()]:
        op, _, arg = a.partition(' ')
        if op == 'c': g.click(sock, *xy(arg))
        elif op == 'r': g.rclick(sock, *xy(arg))
        elif op == 'dc': g.click(sock, *xy(arg)); time.sleep(0.05); g.click(sock, *xy(arg))
        elif op == 'm': g._pointer(sock, *xy(arg), 0)
        elif op == 'd':
            a1, a2 = arg.split('>'); (x1, y1), (x2, y2) = xy(a1), xy(a2)
            g._pointer(sock, x1, y1, 0); time.sleep(0.1); g._pointer(sock, x1, y1, 1); time.sleep(0.15)
            for i in range(1, 11):
                g._pointer(sock, x1 + (x2-x1)*i//10, y1 + (y2-y1)*i//10, 1); time.sleep(0.05)
            time.sleep(0.1); g._pointer(sock, x2, y2, 0)
        elif op == 's':
            x, y, n = xy(arg); m = 16 if n > 0 else 8
            for _ in range(abs(n)): g._pointer(sock, x, y, m); time.sleep(0.03); g._pointer(sock, x, y, 0); time.sleep(0.05)
        elif op == 't': g.type_text(sock, arg)
        elif op == 'k': key(sock, arg)
        elif op == 'w': time.sleep(float(arg)); continue
        time.sleep(0.5)
    time.sleep(1.2)
port, out, acts = int(sys.argv[1]), sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ''
# grab() выполняет «клики» до снимка — подсовываем одно действие-обёртку (-1, -1) со всем списком
click_real = g.click
def patched_click(sock, x, y):
    if x == -1:
        run(sock, acts)
    else:
        click_real(sock, x, y)
g.click = patched_click
o = out if out != '-' else '/dev/null'
g.grab('127.0.0.1', port, o, 20, [(-1, -1)] if acts else None)
print('снято', out)
