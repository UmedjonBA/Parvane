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
const NOTE = {
  id: 'n1', title: 'Идея', folder: '', text: '# Идея\n\nстарое\n', updatedAt: 1, fileId: 'f1', isDaily: false,
};

const store = vi.hoisted(() => ({
  notes: [] as unknown[],
  createNote: undefined as unknown as ReturnType<typeof vi.fn>,
  saveNoteOrRestore: undefined as unknown as ReturnType<typeof vi.fn>,
  showNotification: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('./notesStore', async () => {
  const { createSignal } = await import('../../../util/signals');
  return {
    getNotesStatus: createSignal('ready')[0],
    getNotes: () => store.notes,
    createNote: (store.createNote = vi.fn()),
    saveNoteOrRestore: (store.saveNoteOrRestore = vi.fn()),
    saveCanvas: vi.fn(() => Promise.resolve('canvas')),
    deleteCanvas: vi.fn(),
    renameCanvas: vi.fn(),
    renameNote: vi.fn(),
    freeNoteTitle: (noteId: string, title: string) => title,
  };
});
vi.mock('../cloud/cloudStore', async () => {
  const { createSignal } = await import('../../../util/signals');
  return { getCloudData: createSignal(undefined)[0], getNodes: () => [], downloadCloudNode: vi.fn() };
});
vi.mock('../../../global', () => ({
  getActions: () => ({ showNotification: (store.showNotification ||= vi.fn()) }),
}));
vi.mock('../../../hooks/useLang', () => ({ default: () => (key: string) => key }));
// Раздел «Знания» показан: слушатели клавиш холста работают (в скрытом разделе они молчат)
vi.mock('../../../util/parvaneSection', () => ({ getIsParvaneScreenShown: () => true }));
vi.mock('../cloud/CloudPreview', () => NO_COMPONENT);
vi.mock('../../ui/ConfirmDialog', () => NO_COMPONENT);
vi.mock('./CanvasFilePicker', () => NO_COMPONENT);
vi.mock('./CanvasFileBody', () => NO_COMPONENT);
vi.mock('./CanvasLinkBody', () => NO_COMPONENT);
// Шторка — её содержимое, пока она открыта
vi.mock('./PvSheet', async () => {
  const teact = (await import('../../../lib/teact/teact')).default;
  return {
    default: ({ isOpen, children }: { isOpen: boolean; children: never }) => (
      isOpen ? teact.createElement('div', { 'data-sheet': true }, children) : undefined
    ),
  };
});

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

// Нажатие на самом элементе (точка на стороне карточки)
function fireOn(element: Element, type: string, at: Point) {
  const [x, y, scale] = viewOf();
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: at.x * scale + x, clientY: at.y * scale + y, button: 0,
  });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse' });
  element.dispatchEvent(event);
}

// Стрелка от правой стороны карточки «Альфа», брошенная в точке холста
async function dragArrow(to: Point) {
  const start = { x: -430, y: 150 };
  fireOn(find('[data-canvas-node="alpha"] [data-canvas-port="right"]'), 'pointerdown', start);
  fire('pointermove', { x: (to.x + start.x) / 2, y: to.y });
  fire('pointermove', to);
  await frame();
  fire('pointerup', to);
  await frame();
}

const command = (name: string) => find(`[data-canvas-command="${name}"]`);
const edgeCount = () => root.querySelectorAll('[data-canvas-edge]').length;
const nodeIds = () => Array.from(root.querySelectorAll<HTMLElement>('[data-canvas-node]'))
  .map((node) => node.dataset.canvasNode!);

async function mount(doc: unknown = DOC, notes: unknown[] = []) {
  root = document.createElement('div');
  document.body.appendChild(root);
  store.notes = notes;
  TeactDOM.render(Teact.createElement(NotesCanvas, {
    canvases: [{
      id: 'canvas', title: 'Холст', text: JSON.stringify(doc), fileId: 'file',
    }],
    notes,
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

describe('холст: перерисовки во время жеста', () => {
  // Карточка далеко от группы: жест группы её не касается
  const FAR = {
    id: 'far', type: 'text', x: 900, y: 900, width: 200, height: 60, text: 'Далеко',
  };

  it('перетаскивание группы не перерисовывает несдвинутые карточки и не перерисовывает поле', async () => {
    const { getCanvasCardRenders } = await import('./CanvasCard');
    await mount({ ...DOC, nodes: [...DOC.nodes, FAR] });
    const farBefore = getCanvasCardRenders('far');
    const alphaBefore = getCanvasCardRenders('alpha');
    fire('pointermove', IN_CORNER);
    fire('pointerdown', IN_CORNER);
    for (let step = 1; step <= 8; step++) {
      fire('pointermove', { x: IN_CORNER.x + step * 15, y: IN_CORNER.y - step * 10 });
      await frame();
    }
    // Сдвинутые карточки отрисовались по шагам, несдвинутая — ни разу
    expect(getCanvasCardRenders('alpha')).toBeGreaterThan(alphaBefore);
    expect(getCanvasCardRenders('far')).toBe(farBefore);
    await drop({ x: IN_CORNER.x + 120, y: IN_CORNER.y - 80 });
    expect(placeOf('pair')).toEqual([-580, 20]);
    expect(placeOf('far')).toEqual([900, 900]);
    expect(getCanvasCardRenders('far')).toBe(farBefore);
  });

  it('сдвиг поля не перерисовывает ни одной карточки, вид закрепляется по отпусканию', async () => {
    const { getCanvasCardRenders } = await import('./CanvasCard');
    await mount({ ...DOC, nodes: [...DOC.nodes, FAR] });
    const before = ['pair', 'alpha', 'beta', 'far'].map(getCanvasCardRenders);
    const [x0, y0, scale] = viewOf();
    // Точки экрана считаются по виду до жеста: поле едет уже на первом движении
    const fireAt = (type: string, dx: number, dy: number) => {
      const event = new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: OUTSIDE.x * scale + x0 + dx, clientY: OUTSIDE.y * scale + y0 + dy,
        button: 0,
      });
      Object.assign(event, { pointerId: 1, pointerType: 'mouse' });
      find('[data-canvas-board]').dispatchEvent(event);
    };
    fireAt('pointermove', 0, 0);
    fireAt('pointerdown', 0, 0);
    for (let step = 1; step <= 6; step++) {
      fireAt('pointermove', step * 10, step * 5);
      await frame();
    }
    fireAt('pointerup', 60, 30);
    await frame();
    const [x1, y1] = viewOf();
    expect([x1 - x0, y1 - y0].map(Math.round)).toEqual([60, 30]);
    expect(['pair', 'alpha', 'beta', 'far'].map(getCanvasCardRenders)).toEqual(before);
  });
});

describe('холст: стрелка, брошенная на пустом месте', () => {
  it('спрашивает, что поставить на конце; стрелка остаётся на экране, пока открыто меню', async () => {
    await mount();
    await dragArrow(OUTSIDE);
    expect(Array.from(root.querySelectorAll<HTMLElement>('[data-canvas-command]'))
      .map((item) => item.dataset.canvasCommand)).toEqual(['dropNewNote', 'dropNote', 'dropText']);
    expect(root.querySelector('[data-canvas-draft]')).not.toBeNull();
    expect(nodeIds()).toHaveLength(3);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await frame();
    expect(root.querySelector('[data-canvas-context]')).toBeNull();
    expect(root.querySelector('[data-canvas-draft]')).toBeNull();
    expect(nodeIds()).toHaveLength(3);
    expect(edgeCount()).toBe(1);
  });

  it('«Текстовая карточка» ставит связанную карточку с открытым полем текста', async () => {
    await mount();
    await dragArrow(OUTSIDE);
    command('dropText').click();
    await frame();
    expect(nodeIds()).toHaveLength(4);
    expect(edgeCount()).toBe(2);
    expect(root.querySelector('textarea[data-canvas-inline]')).not.toBeNull();
  });

  it('«Новая заметка» создаёт заметку в хранилище, ставит её карточку и стрелку к ней', async () => {
    store.createNote.mockReset();
    store.createNote.mockImplementation((title: string) => {
      // Название занято: хранилище даёт заметке номер
      store.notes = [{ ...NOTE, id: 'n7', title: `${title} 2` }];
      return Promise.resolve('n7');
    });
    await mount();
    await dragArrow(OUTSIDE);
    command('dropNewNote').click();
    await frame();
    const field = find('#knowledge-canvas-note-name') as HTMLInputElement;
    field.value = '  Замысел ';
    find('[data-canvas-note-create]').click();
    await frame();
    expect(store.createNote).toHaveBeenCalledWith('Замысел', 'KnowledgeVaultName');
    const card = find('[data-canvas-type="file"]');
    expect(card.querySelector('[data-canvas-note-title]')!.textContent).toBe('Замысел 2');
    // Карточка стоит за точкой, где брошена стрелка: левым краем к ней, на сетке
    expect(placeOf(card.dataset.canvasNode!)).toEqual([200, 330]);
    expect(edgeCount()).toBe(2);
    expect(root.querySelector('#knowledge-canvas-note-name')).toBeNull();
  });

  it('пустое название заметку не создаёт', async () => {
    store.createNote.mockReset();
    await mount();
    await dragArrow(OUTSIDE);
    command('dropNewNote').click();
    await frame();
    find('[data-canvas-note-create]').click();
    await frame();
    expect(store.createNote).not.toHaveBeenCalled();
    expect(root.querySelector('#knowledge-canvas-note-name')).not.toBeNull();
    expect(nodeIds()).toHaveLength(3);
  });
});

describe('холст: новая заметка кнопкой панели', () => {
  it('создаёт заметку и ставит её карточку без стрелки', async () => {
    store.createNote.mockReset();
    store.createNote.mockImplementation((title: string) => {
      store.notes = [{ ...NOTE, id: 'n8', title }];
      return Promise.resolve('n8');
    });
    await mount();
    find('[data-canvas-tool="new-note"]').click();
    await frame();
    (find('#knowledge-canvas-note-name') as HTMLInputElement).value = 'Черновик';
    find('[data-canvas-note-create]').click();
    await frame();
    expect(find('[data-canvas-type="file"] [data-canvas-note-title]').textContent).toBe('Черновик');
    expect(edgeCount()).toBe(1);
  });

  it('заметка не создалась — карточки нет', async () => {
    store.createNote.mockReset();
    store.createNote.mockResolvedValue(undefined);
    await mount();
    find('[data-canvas-tool="new-note"]').click();
    await frame();
    (find('#knowledge-canvas-note-name') as HTMLInputElement).value = 'Черновик';
    find('[data-canvas-note-create]').click();
    await frame();
    expect(root.querySelector('[data-canvas-type="file"]')).toBeNull();
  });
});

describe('холст: правка заметки на карточке', () => {
  const NOTE_DOC = {
    nodes: [{
      id: 'card', type: 'file', x: 0, y: 300, width: 250, height: 140, file: 'Идея.md', pvNote: 'n1',
    }],
    edges: [],
  };
  const DRAFT = '# Идея\n\nстарое\nнабрано на карточке\n';

  // Двойной щелчок по тексту карточки и набранный текст, сохранённый Ctrl+Enter
  async function editNote(text: string) {
    const body = find('[data-canvas-note-body]');
    Object.assign(document, { elementFromPoint: () => body });
    fire('dblclick', { x: 100, y: 380 });
    await frame();
    const editor = find('[data-canvas-note-editor]') as HTMLTextAreaElement;
    editor.value = text;
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await frame();
  }

  it('заметку удалили за время правки: текст уходит в хранилище, карточка указывает на новую заметку', async () => {
    store.saveNoteOrRestore.mockReset();
    store.saveNoteOrRestore.mockResolvedValue({ status: 'restored', id: 'n9', title: 'Идея 2' });
    await mount(NOTE_DOC, [NOTE]);
    store.showNotification.mockClear();
    await editNote(DRAFT);
    expect(store.saveNoteOrRestore).toHaveBeenCalledWith('n1', 'Идея', DRAFT, 'KnowledgeVaultName', NOTE.text);
    expect(find('[data-canvas-node="card"] [data-canvas-note-title]').textContent).toBe('Идея 2');
    expect(store.showNotification).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[data-canvas-note-editor]')).toBeNull();
  });

  it('запись не удалась: поле открыто снова с набранным текстом', async () => {
    store.saveNoteOrRestore.mockReset();
    store.saveNoteOrRestore.mockResolvedValue({ status: 'failed' });
    await mount(NOTE_DOC, [NOTE]);
    await editNote(DRAFT);
    expect((find('[data-canvas-note-editor]') as HTMLTextAreaElement).value).toBe(DRAFT);
  });

  it('сохранённая заметка поле закрывает, карточка остаётся при своей заметке', async () => {
    store.saveNoteOrRestore.mockReset();
    store.saveNoteOrRestore.mockResolvedValue({ status: 'saved' });
    await mount(NOTE_DOC, [NOTE]);
    await editNote(DRAFT);
    expect(root.querySelector('[data-canvas-note-editor]')).toBeNull();
    expect(find('[data-canvas-node="card"] [data-canvas-note-title]').textContent).toBe('Идея');
  });
});
