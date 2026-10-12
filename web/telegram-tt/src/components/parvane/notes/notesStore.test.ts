import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { CloudDriveState, CloudNodeJson } from '../../../api/parvane/cloudDrive';

// Хранилище заметок поверх облака-заглушки: дерево личного диска в памяти, запись текста создаёт либо
// заменяет узел. Проверяется запись с карточки холста, когда заметку за время правки удалили

type WriteArgs = { parent?: string; node?: string; name: string; text: string };

const DRIVE = 'drive';
const VAULT = 'Знания';

type CloudStub = {
  data: unknown; set: (data: unknown) => void; texts: Map<string, string>; writes: unknown[]; count: number;
};

const cloud = vi.hoisted<CloudStub>(() => ({
  data: undefined,
  set: () => undefined,
  texts: new Map<string, string>(),
  writes: [],
  count: 0,
}));

vi.mock('../cloud/cloudStore', async () => {
  const { createSignal } = await import('../../../util/signals');
  const [getCloudData, setCloudData] = createSignal<unknown>(undefined);
  cloud.set = (data) => {
    cloud.data = data;
    setCloudData(data);
  };
  const stateOf = (data: unknown) => data as { trees: Record<string, { nodes: unknown[] }> } | undefined;
  return {
    getCloudData,
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
    if (method !== 'parvaneCloudWriteText') return Promise.resolve(undefined);
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
