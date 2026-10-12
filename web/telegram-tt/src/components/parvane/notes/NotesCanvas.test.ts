import {
  afterEach, beforeAll, describe, expect, it, vi,
} from 'vitest';
import type { FC } from '../../../lib/teact/teact';
import Teact from '../../../lib/teact/teact';
import TeactDOM from '../../../lib/teact/teact-dom';

// Холст целиком в jsdom, без облака и без раскладки страницы: поле стоит в начале окна, поэтому точка экрана
// получается из точки холста одним видом поля. Проверяется то, что чистые функции не видят: нажатия мыши
// доходят до жеста, а отрисовка переживает смену выделения

const NO_COMPONENT = { default: () => undefined };

vi.mock('./notesStore', async () => {
  const { createSignal } = await import('../../../util/signals');
  return {
    getNotesStatus: createSignal('ready')[0],
    getNotes: createSignal([])[0],
    saveCanvas: vi.fn(() => Promise.resolve('canvas')),
    deleteCanvas: vi.fn(),
    renameCanvas: vi.fn(),
    renameNote: vi.fn(),
    saveNote: vi.fn(),
    freeNoteTitle: (noteId: string, title: string) => title,
  };
});
vi.mock('../cloud/cloudStore', async () => {
  const { createSignal } = await import('../../../util/signals');
  return { getCloudData: createSignal(undefined)[0], getNodes: () => [], downloadCloudNode: vi.fn() };
});
vi.mock('../../../global', () => ({ getActions: () => ({ showNotification: vi.fn() }) }));
vi.mock('../../../hooks/useLang', () => ({ default: () => (key: string) => key }));
vi.mock('../cloud/CloudPreview', () => NO_COMPONENT);
vi.mock('../../ui/ConfirmDialog', () => NO_COMPONENT);
vi.mock('./CanvasFilePicker', () => NO_COMPONENT);
vi.mock('./CanvasFileBody', () => NO_COMPONENT);
vi.mock('./CanvasLinkBody', () => NO_COMPONENT);
vi.mock('./PvSheet', () => NO_COMPONENT);

// Группа 610×100 с двумя карточками, занимающими её почти целиком, и стрелкой между ними (от правой стороны
// первой к верху второй, середина кривой — около точки (-308, 110)); свободны только поля группы
const DOC = {
  nodes: [
    {
      id: 'pair', type: 'group', x: -700, y: 100, width: 610, height: 100, label: 'Пара',
    },
    {
      id: 'alpha', type: 'text', x: -680, y: 120, width: 250, height: 60, text: 'Альфа',
    },
    {
      id: 'beta', type: 'text', x: -360, y: 120, width: 250, height: 60, text: 'Бета',
    },
  ],
  edges: [{
    id: 'edge', fromNode: 'alpha', toNode: 'beta', fromSide: 'right', toSide: 'top',
  }],
};
const ON_EDGE = { x: -308, y: 110 };
// 10 px от левого верхнего угла рамки группы — узкое поле между рамкой и карточкой
const IN_CORNER = { x: -690, y: 110 };
const OUTSIDE = { x: 200, y: 400 };
const FRAME_MS = 80;

type Point = { x: number; y: number };

let NotesCanvas: FC;
let root: HTMLElement;

const frame = () => new Promise((resolve) => {
  setTimeout(resolve, FRAME_MS);
});

const find = (selector: string) => root.querySelector<HTMLElement>(selector)!;
const viewOf = () => find('[data-canvas-world]').style.transform.match(/-?\d+(\.\d+)?/g)!.map(Number);
const placeOf = (id: string) => {
  const { left, top } = find(`[data-canvas-node="${id}"]`).style;
  return [parseFloat(left), parseFloat(top)];
};
const barActions = () => Array.from(root.querySelectorAll<HTMLElement>('[data-canvas-action]'))
  .map((button) => button.dataset.canvasAction);

function fire(type: string, at: Point, keys: { shiftKey?: boolean } = {}) {
  const [x, y, scale] = viewOf();
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: at.x * scale + x, clientY: at.y * scale + y, button: 0, ...keys,
  });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse' });
  find('[data-canvas-board]').dispatchEvent(event);
}

async function press(at: Point) {
  fire('pointerdown', at);
  fire('pointerup', at);
  await frame();
}

async function drag(from: Point, dx: number, dy: number, keys?: { shiftKey?: boolean }) {
  fire('pointermove', from);
  fire('pointerdown', from, keys);
  fire('pointermove', { x: from.x + dx / 2, y: from.y + dy / 2 }, keys);
  fire('pointermove', { x: from.x + dx, y: from.y + dy }, keys);
  await frame();
}

async function drop(at: Point) {
  fire('pointerup', at);
  await frame();
}

async function mount() {
  root = document.createElement('div');
  document.body.appendChild(root);
  TeactDOM.render(Teact.createElement(NotesCanvas, {
    canvases: [{
      id: 'canvas', title: 'Холст', text: JSON.stringify(DOC), fileId: 'file',
    }],
    notes: [],
    isNarrow: false,
    onOpenTitle: () => undefined,
  }) as Parameters<typeof TeactDOM.render>[0], root);
  await frame();
}

beforeAll(async () => {
  Object.assign(HTMLElement.prototype, { setPointerCapture: () => undefined });
  Object.assign(window, {
    matchMedia: () => ({
      matches: false, addEventListener: () => undefined, removeEventListener: () => undefined,
    }),
  });
  NotesCanvas = (await import('./NotesCanvas')).default as FC;
});

afterEach(() => {
  TeactDOM.render(undefined, root);
  root.remove();
});

describe('холст: нажатия мыши', () => {
  it('пустое место внутри группы двигает её вместе с карточками, поле стоит', async () => {
    await mount();
    const view = viewOf();
    await drag(IN_CORNER, 120, -80);
    await drop({ x: IN_CORNER.x + 120, y: IN_CORNER.y - 80 });
    expect(placeOf('pair')).toEqual([-580, 20]);
    expect(placeOf('alpha')).toEqual([-560, 40]);
    expect(placeOf('beta')).toEqual([-240, 40]);
    expect(viewOf()).toEqual(view);
    // Группа выделена: в панели есть «По содержимому»
    expect(barActions()).toContain('fit');
  });

  it('снятое со стрелки выделение не роняет отрисовку: следующий жест работает', async () => {
    const onError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mount();
    await press(ON_EDGE);
    expect(barActions()).toContain('direction');
    // Нажатие в стороне от линии, внутри группы: выделение переходит со стрелки на группу
    await drag(IN_CORNER, 120, -80);
    await drop({ x: IN_CORNER.x + 120, y: IN_CORNER.y - 80 });
    expect(onError).not.toHaveBeenCalled();
    expect(placeOf('pair')).toEqual([-580, 20]);
    expect(barActions()).not.toContain('direction');
    expect(find('[data-canvas-edge="edge"]').getAttribute('class')).toBe('');
    onError.mockRestore();
  });

  it('Escape снимает выделение со стрелки', async () => {
    await mount();
    await press(ON_EDGE);
    expect(barActions()).toContain('direction');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await frame();
    expect(root.querySelector('[data-canvas-selection-bar]')).toBeNull();
    await drag(IN_CORNER, 120, -80);
    await drop({ x: IN_CORNER.x + 120, y: IN_CORNER.y - 80 });
    expect(placeOf('pair')).toEqual([-580, 20]);
  });

  it('нажатие без сдвига внутри группы её выделяет', async () => {
    await mount();
    await press(IN_CORNER);
    expect(barActions()).toContain('fit');
    expect(placeOf('pair')).toEqual([-700, 100]);
  });

  it('нажатие на самой линии стрелки внутри группы выбирает стрелку, группа стоит', async () => {
    await mount();
    await drag(ON_EDGE, 120, -80);
    await drop({ x: ON_EDGE.x + 120, y: ON_EDGE.y - 80 });
    expect(placeOf('pair')).toEqual([-700, 100]);
    expect(barActions()).toContain('direction');
  });

  it('с Shift внутри группы рисуется рамка выделения, группа стоит', async () => {
    await mount();
    await drag(IN_CORNER, 300, 80, { shiftKey: true });
    expect(root.querySelector('[data-canvas-marquee]')).not.toBeNull();
    await drop({ x: IN_CORNER.x + 300, y: IN_CORNER.y + 80 });
    expect(placeOf('pair')).toEqual([-700, 100]);
    expect(root.querySelector('[data-canvas-marquee]')).toBeNull();
  });

  it('пустое место вне групп двигает поле, узлы стоят', async () => {
    await mount();
    const view = viewOf();
    await drag(OUTSIDE, 70, 50);
    await drop({ x: OUTSIDE.x + 70, y: OUTSIDE.y + 50 });
    expect(viewOf()[0]).not.toBe(view[0]);
    expect(viewOf()[1]).not.toBe(view[1]);
    expect(placeOf('pair')).toEqual([-700, 100]);
    expect(placeOf('alpha')).toEqual([-680, 120]);
  });
});
