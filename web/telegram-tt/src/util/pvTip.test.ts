import { describe, expect, it } from 'vitest';

import { findTip, formatShortcut, readTip } from './pvTip';

describe('подсказка при наведении', () => {
  it('кнопка-значок — имя; своя строка важнее; кнопке с текстом — только с клавишей', () => {
    expect(readTip({ label: 'Поиск', text: '' })).toEqual({ text: 'Поиск', kbd: undefined });
    expect(readTip({ tip: 'Переименовать', keys: 'F2', text: '' })).toEqual({ text: 'Переименовать', kbd: 'F2' });
    expect(readTip({ label: 'Скачать', text: 'Скачать' })).toBeUndefined();
    expect(readTip({ keys: 'Control+S', text: 'Скачать' })).toEqual({ text: 'Скачать', kbd: 'Ctrl+S' });
    expect(readTip({ text: '' })).toBeUndefined();
  });

  it('клавиши: первая из нескольких, Ctrl и Del по-человечески, на Mac — ⌘', () => {
    expect(formatShortcut('Control+k Meta+k')).toBe('Ctrl+K');
    expect(formatShortcut('Delete')).toBe('Del');
    expect(formatShortcut('Control+S', true)).toBe('⌘S');
    expect(formatShortcut(' ')).toBeUndefined();
  });

  it('элемент: ближайший с подсказкой; с `title` и выключенный — без неё', () => {
    document.body.innerHTML = '<button aria-label="Поиск"><svg><path id="p"/></svg></button>'
      + '<button id="t" aria-label="Меню" title="Меню"></button><button id="d" aria-label="Стереть" disabled></button>';
    expect(findTip(document.getElementById('p'))?.tip).toEqual({ text: 'Поиск', kbd: undefined });
    expect(findTip(document.getElementById('t'))).toBeUndefined();
    expect(findTip(document.getElementById('d'))).toBeUndefined();
  });
});
