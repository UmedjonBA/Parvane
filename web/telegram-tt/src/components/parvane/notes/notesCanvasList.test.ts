import { describe, expect, it } from 'vitest';

import { isCanvasFound, summarizeCanvasDoc } from './notesCanvasList';

const DOC = {
  nodes: [
    {
      id: 'a', type: 'file' as const, x: 0, y: 0, width: 200, height: 100, file: 'Заметки/Маяк у мыса.md',
    },
    {
      id: 'b', type: 'text' as const, x: 300, y: 0, width: 200, height: 100, text: 'Сети сушатся на причале',
    },
    {
      id: 'g', type: 'group' as const, x: -20, y: -40, width: 600, height: 200, label: 'Ёлки у берега',
    },
  ],
  edges: [],
};

describe('isCanvasFound', () => {
  const summary = summarizeCanvasDoc(DOC);

  it('collects card names, texts and group labels', () => {
    expect(summary.names).toEqual(['Маяк у мыса', 'Сети сушатся на причале', 'Ёлки у берега']);
  });

  it('finds a canvas by its title and by its cards', () => {
    expect(isCanvasFound('Порт', summary, 'пор')).toBe(true);
    expect(isCanvasFound('Порт', summary, 'маяк')).toBe(true);
    expect(isCanvasFound('Порт', summary, 'ПРИЧАЛ')).toBe(true);
    expect(isCanvasFound('Порт', summary, 'елки')).toBe(true);
    expect(isCanvasFound('Порт', summary, 'буй')).toBe(false);
  });

  it('matches every canvas on an empty query', () => {
    expect(isCanvasFound('Порт', { names: [] }, '  ')).toBe(true);
  });
});
