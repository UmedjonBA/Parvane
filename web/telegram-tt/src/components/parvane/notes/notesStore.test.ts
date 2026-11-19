import {
  beforeAll, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { CloudDriveState, CloudNodeJson } from '../../../api/parvane/cloudDrive';

import { loadProtocol } from '../../../api/parvane/v2/engine';

// Хранилище заметок поверх облака-заглушки: дерево личного диска в памяти, запись текста создаёт либо
// заменяет узел. Проверяется запись с карточки холста, когда заметку за время правки удалили

type WriteArgs = { parent?: string; node?: string; name: string; text: string; expectedFileId?: string };

const DRIVE = 'drive';
const VAULT = 'Знания';

type CloudStub = {
  data: unknown; set: (data: unknown) => void; texts: Map<string, string>; writes: unknown[]; count: number;
  // Нет связи: запись текста отказывает, как облако без сервера
  isOffline: boolean;
};

const cloud = vi.hoisted<CloudStub>(() => ({
  data: undefined,
  set: () => undefined,
  texts: new Map<string, string>(),
  writes: [],
  count: 0,
  isOffline: false,
}));

vi.mock('../cloud/cloudStore', async () => {
  const { createSignal } = await import('../../../util/signals');
  const [getCloudData, setCloudData] = createSignal<unknown>(undefined);
  cloud.set = (data) => {
    cloud.data = data;
    setCloudData(data);
  };
  const stateOf = (data: unknown) => data as { trees: Record<string, { nodes: unknown[] }> } | undefined;
  const [getCloudStatus] = createSignal('ready');
  return {
    getCloudData,
    getCloudStatus,
    getNodes: (id?: string, data: unknown = getCloudData()) => (id && stateOf(data)?.trees[id]?.nodes) || [],
    loadCloud: () => Promise.resolve(),
    refreshCloud: () => {
      setCloudData(cloud.data);
      return Promise.resolve(cloud.data);
    },
    moveCloudNodes: vi.fn(),
    renameCloudNode: vi.fn(),
    trashCloudNodes: vi.fn(),
  };
});
vi.mock('../planner/plannerStore', () => ({
  getPlannerState: () => ({
    settings: { dayStart: 480, dayEnd: 1320 }, tasks: [], events: [], lists: [],
  }),
  updatePlanner: vi.fn(),
}));
vi.mock('../../../api/gramjs', () => ({
  callApi: (method: string, args: WriteArgs) => {
    if (method === 'parvaneCloudReadText') {
      const text = cloud.texts.get(args.node!);
      return Promise.resolve(text === undefined ? undefined : { text, fileId: blobOf(args.node!) });
    }
    if (method === 'parvaneCloudSync') return Promise.resolve(!cloud.isOffline);
    if (method !== 'parvaneCloudWriteText') return Promise.resolve(undefined);
    if (cloud.isOffline) return Promise.resolve({ ok: false, error: 'offline' });
    // Заметку тем временем изменило другое устройство: запись не делается, возвращается текущий текст
    if (args.node && args.expectedFileId && args.expectedFileId !== blobOf(args.node)) {
      return Promise.resolve({
        ok: true, node: args.node, fileId: blobOf(args.node), conflict: cloud.texts.get(args.node),
      });
    }
    cloud.writes.push(args);
    const id = args.node || `new${++cloud.count}`;
    cloud.texts.set(id, args.text);
    const nodes = treeNodes().filter((node) => node.id !== id);
    const previous = treeNodes().find((node) => node.id === id);
    const fileId = `${id}-v${cloud.writes.length}`;
    nodes.push({
      ...file(id, args.name, previous?.parent || args.parent), ...previous, blob: { fileId } as CloudNodeJson['blob'],
    });
    cloud.data = stateWith(nodes);
    return Promise.resolve({ ok: true, node: id, fileId });
  },
}));

function blobOf(id: string) {
  return treeNodes().find((node) => node.id === id)?.blob?.fileId || '';
}

function treeNodes() {
  return (cloud.data as CloudDriveState).trees[DRIVE].nodes;
}

function folder(id: string, name: string, parent?: string): CloudNodeJson {
  return {
    id, kind: 'folder', parent, name, size: 0, mime: '', mtime: 1, trashed: false, trashTop: false, trashedAt: 0,
  };
}

function file(id: string, name: string, parent?: string, extra: Partial<CloudNodeJson> = {}): CloudNodeJson {
  return {
    ...folder(id, name, parent),
    kind: 'file',
    size: 10,
    blob: { fileId: `${id}-v0` } as CloudNodeJson['blob'],
    ...extra,
  };
}

function stateWith(nodes: CloudNodeJson[]): CloudDriveState {
  return {
    status: 'ready',
    rootId: DRIVE,
    containers: [],
    trees: { [DRIVE]: { name: '', count: nodes.length, nodes } },
  } as unknown as CloudDriveState;
}

const TRASHED = { trashed: true, trashTop: true, trashedAt: 5 };
const lastWrite = () => cloud.writes[cloud.writes.length - 1] as WriteArgs;

async function open(nodes: CloudNodeJson[], texts: Record<string, string>) {
  cloud.texts.clear();
  Object.entries(texts).forEach(([id, text]) => cloud.texts.set(id, text));
  cloud.writes.length = 0;
  // Заглушка облака появляется с первой загрузкой хранилища
  const store = await import('./notesStore');
  cloud.set(stateWith(nodes));
  await store.loadNotes('user');
  return store;
}

// Заметку удалили: узел в корзине, хранилище это уже увидело
async function trash(store: Awaited<ReturnType<typeof open>>, id: string) {
  cloud.set(stateWith(treeNodes().map((node) => (node.id === id ? { ...node, ...TRASHED } : node))));
  await store.loadNotes('user');
}

const TREE = () => [
  folder('v', VAULT),
  folder('f', 'Проекты', 'v'),
  file('n1', 'Идея.md', 'f'),
  file('n2', 'План.md', 'v'),
];
const TEXTS = { n1: '# Идея\n\nстарое\n', n2: '# План\n' };
const DRAFT = '# Идея\n\nстарое\nнабрано на карточке\n';

// Сведение заметок считает движок (NOTES-2)
beforeAll(async () => {
  await loadProtocol();
});

// Другое устройство записало заметку: новая версия файла
function writeElsewhere(id: string, text: string) {
  cloud.texts.set(id, text);
  cloud.set(stateWith(treeNodes().map((node) => (
    node.id === id ? { ...node, mtime: 7, blob: { fileId: `${id}-other` } as CloudNodeJson['blob'] } : node
  ))));
}

describe('хранилище заметок: очередь без связи и расхождение правок', () => {
  beforeEach(() => {
    cloud.count = 0;
    cloud.isOffline = false;
  });

  it('без связи текст ждёт в очереди с пометкой и уходит при появлении связи', async () => {
    const outbox = await import('./notesOutbox');
    const store = await open(TREE(), TEXTS);
    cloud.isOffline = true;
    expect(await store.saveNote('n1', DRAFT, VAULT, TEXTS.n1)).toBe(true);
    expect(cloud.writes).toEqual([]);
    expect(outbox.getNotesUnsent().has('n1')).toBe(true);
    expect(store.getNotes().find(({ id }) => id === 'n1')?.text).toBe(DRAFT);
    // Повторная правка без связи заменяет текст в очереди, основа остаётся прежней
    const second = `${DRAFT}ещё\n`;
    expect(await store.saveNote('n1', second, VAULT, DRAFT)).toBe(true);
    expect(outbox.getQueuedText('n1')).toMatchObject({ text: second, base: TEXTS.n1, baseFileId: 'n1-v0' });
    cloud.isOffline = false;
    await store.flushNoteOutbox(VAULT);
    expect(lastWrite()).toMatchObject({ node: 'n1', text: second });
    expect(outbox.getNotesUnsent().size).toBe(0);
  });

  it('текст из очереди уходит поверх чужой правки другого места — сводится сам', async () => {
    const outbox = await import('./notesOutbox');
    const store = await open(TREE(), TEXTS);
    cloud.isOffline = true;
    await store.saveNote('n1', DRAFT, VAULT, TEXTS.n1);
    cloud.isOffline = false;
    writeElsewhere('n1', '# Идея другая\n\nстарое\n');
    await store.flushNoteOutbox(VAULT);
    expect(lastWrite()).toMatchObject({ node: 'n1', text: '# Идея другая\n\nстарое\nнабрано на карточке\n' });
    expect(outbox.getNoteConflict('n1')).toBeUndefined();
  });

  it('одно место изменено на двух устройствах — ждёт решения; выбор пишет заметку и убирает копию', async () => {
    const outbox = await import('./notesOutbox');
    const store = await open(TREE(), TEXTS);
    cloud.isOffline = true;
    await store.saveNote('n1', '# Идея\n\nмоё\n', VAULT, TEXTS.n1);
    cloud.isOffline = false;
    writeElsewhere('n1', '# Идея\n\nчужое\n');
    await store.flushNoteOutbox(VAULT);
    const conflict = outbox.getNoteConflict('n1');
    expect(conflict).toMatchObject({ mine: '# Идея\n\nмоё\n', theirs: '# Идея\n\nчужое\n', base: TEXTS.n1 });
    expect(conflict?.copyId).toBeTruthy();
    expect(cloud.texts.get('n1')).toBe('# Идея\n\nмоё\n');
    expect(await store.resolveNoteConflict('n1', ['both'], undefined, VAULT)).toBe(true);
    expect(cloud.texts.get('n1')).toBe('# Идея\n\nмоё\nчужое\n');
    expect(outbox.getNoteConflict('n1')).toBeUndefined();
  });
});

describe('хранилище заметок: запись с карточки холста', () => {
  beforeEach(() => {
    cloud.count = 0;
  });

  it('живая заметка сохраняется как обычно', async () => {
    const store = await open(TREE(), TEXTS);
    const result = await store.saveNoteOrRestore('n1', 'Идея', DRAFT, VAULT, TEXTS.n1);
    expect(result).toEqual({ status: 'saved' });
    expect(lastWrite()).toMatchObject({ node: 'n1', text: DRAFT });
    expect(store.getNotes().find(({ id }) => id === 'n1')?.text).toBe(DRAFT);
  });

  it('заметку удалили за время правки: текст ложится в новую заметку с тем же названием и в той же папке', async () => {
    const store = await open(TREE(), TEXTS);
    await trash(store, 'n1');
    expect(store.getNotes().some(({ id }) => id === 'n1')).toBe(false);
    // Прежний путь терял набранное: заметки нет — запись молча не делалась
    expect(await store.saveNote('n1', DRAFT, VAULT, TEXTS.n1)).toBe(false);
    expect(cloud.writes).toEqual([]);

    const result = await store.saveNoteOrRestore('n1', 'Идея', DRAFT, VAULT, TEXTS.n1);
    expect(result).toEqual({ status: 'restored', id: 'new1', title: 'Идея' });
    expect(lastWrite()).toMatchObject({ parent: 'f', name: 'Идея.md', text: DRAFT });
    expect(lastWrite().node).toBeUndefined();
    const restored = store.getNotes().find(({ id }) => id === 'new1');
    expect(restored).toMatchObject({ title: 'Идея', folder: 'Проекты', text: DRAFT });
    // Удалённая заметка осталась в корзине нетронутой
    expect(treeNodes().find(({ id }) => id === 'n1')).toMatchObject({ trashed: true, blob: { fileId: 'n1-v0' } });
  });

  it('название успела занять другая заметка — восстановленная получает номер', async () => {
    const store = await open([...TREE(), file('n3', 'Идея.md', 'v')], { ...TEXTS, n3: '# Идея\n\nдругая\n' });
    await trash(store, 'n1');
    const result = await store.saveNoteOrRestore('n1', 'Идея', DRAFT, VAULT, TEXTS.n1);
    expect(result).toMatchObject({ status: 'restored', title: 'Идея 2' });
    expect(lastWrite()).toMatchObject({ name: 'Идея 2.md', text: DRAFT });
    expect(store.getNotes().find(({ id }) => id === 'n3')?.text).toBe('# Идея\n\nдругая\n');
  });

  it('то же дерево заново и дерево с одной правкой: прежние объекты заметок, setNotes лишний раз нет', async () => {
    const store = await open(TREE(), TEXTS);
    const before = store.getNotes();
    expect(before.map(({ id }) => id)).toEqual(['n1', 'n2']);
    let changes = 0;
    const unsubscribe = store.getNotes.subscribe(() => {
      changes++;
    });
    // Новый объект дерева с тем же содержимым (эхо облака): проход не меняет список
    cloud.set(stateWith(treeNodes().map((node) => ({ ...node }))));
    await store.loadNotes('user');
    expect(store.getNotes()).toBe(before);
    expect(changes).toBe(0);
    // Та же ссылка на дерево — проход пропускается вовсе (тексты не перечитываются)
    await store.loadNotes('user');
    expect(store.getNotes()).toBe(before);
    // Изменилась одна заметка: её объект новый, остальные прежние; тексты читаются только для неё
    cloud.texts.set('n2', '# План\n\nновое\n');
    cloud.set(stateWith(treeNodes().map((node) => (
      node.id === 'n2' ? { ...node, mtime: 9, blob: { fileId: 'n2-v1' } as CloudNodeJson['blob'] } : node
    ))));
    await store.loadNotes('user');
    const after = store.getNotes();
    expect(changes).toBe(1);
    expect(after.find(({ id }) => id === 'n1')).toBe(before.find(({ id }) => id === 'n1'));
    expect(after.find(({ id }) => id === 'n2')).toMatchObject({ text: '# План\n\nновое\n', fileId: 'n2-v1' });
    expect(store.getNoteFolders()).toBe(store.getNoteFolders());
    unsubscribe();
  });

  it('без потребителей изменение облака лишь помечает хранилище; удержание применяет его', async () => {
    const store = await open(TREE(), TEXTS);
    const before = store.getNotes();
    cloud.texts.set('n1', '# Идея\n\nправка с другого устройства\n');
    cloud.set(stateWith(treeNodes().map((node) => (
      node.id === 'n1' ? { ...node, blob: { fileId: 'n1-v1' } as CloudNodeJson['blob'] } : node
    ))));
    await Promise.resolve();
    expect(store.getNotes()).toBe(before);
    const release = store.retainNotes();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(store.getNotes().find(({ id }) => id === 'n1')?.text).toBe('# Идея\n\nправка с другого устройства\n');
    release();
  });

  it('папки заметки тоже нет — восстановленная заметка ложится в корень хранилища', async () => {
    const store = await open(TREE(), TEXTS);
    cloud.set(stateWith(treeNodes().map((node) => (
      node.id === 'f' ? { ...node, ...TRASHED } : node.id === 'n1' ? { ...node, trashed: true } : node
    ))));
    await store.loadNotes('user');
    const result = await store.saveNoteOrRestore('n1', 'Идея', DRAFT, VAULT, TEXTS.n1);
    expect(result).toMatchObject({ status: 'restored', title: 'Идея' });
    expect(lastWrite()).toMatchObject({ parent: 'v', name: 'Идея.md' });
  });
});
