/* eslint-disable no-null/no-null -- контракт JSON движка: null = «не задано» */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CloudNode } from '../../components/parvane/cloud/cloudModel';
import type { CanvasDoc, CanvasSide } from '../../components/parvane/notes/notesCanvas';
import type { FolderNode } from '../../components/parvane/notes/notesFolders';
import type { NoteProperties, NoteSource } from '../../components/parvane/notes/notesModel';
import type { PlannerState } from '../../components/parvane/planner/plannerModel';
import type { EngineState } from '../../components/parvane/planner/plannerSync';
import type { LinkManifestThumb, LinkPlan, LinkSourceNode } from './cloudLinks';

import {
  canMoveInto, childrenOf, expiredTrashOf, fileTypeLabel, folderStats, freeName, getExtension, kindOfFile,
  listedNodes, namesIn, pathOf, searchNodes, sizeOf, sortNodes, subtreeOf, trashDaysLeft, trashOf, usageOf,
  validateName,
} from '../../components/parvane/cloud/cloudModel';
import {
  addEdge, addNode, boundsOf, clampCanvasScale, edgeAnchors, firstGroupView, fitView, moveNode, newCanvasId,
  nodesInGroup, parseCanvas, removeEdge, removeNode, serializeCanvas, sidePoint, updateEdge, updateNode,
} from '../../components/parvane/notes/notesCanvas';
import {
  buildNoteGroups, checkFolderName, folderCaption, folderContents, isInFolder, listNoteFolders,
} from '../../components/parvane/notes/notesFolders';
import {
  buildNotesIndex, dailyNoteTemplate, dailyNoteTitle, dedupeTaskMarkers, ensureTaskMarker, findTaskLine,
  parseNote, removeTaskLine, renameLinks, serializeNote, setTaskDone,
} from '../../components/parvane/notes/notesModel';
import { createEmptyPlannerState } from '../../components/parvane/planner/plannerModel';
import {
  diffChanges, fromEngineState, hasEngineQuickLines, isLegacyPlannerRecord, legacyToChanges,
} from '../../components/parvane/planner/plannerSync';
import { coalesceChanges } from './v2/plannerCoalesce';
import { buildLinkPlan, buildLinkUrl, buildManifest, parseManifest } from './cloudLinks';

// Векторы разделов (spec 029, T037): записи «Плана» (planner.v1), «Облака» (cloud.v1), заметок и холста в том
// виде, в каком их пишут настоящие модели web. Файлы читает desktop (`parvane-core/tests/sections/
// webcompat_sections_tests.cpp`) и обязан получить те же значения. Вектор создаётся, если его нет (или
// PARVANE_REGEN_VECTORS=1); иначе тест сверяет файл с тем, что даёт текущий код web, — расхождение значит, что
// формат изменился и desktop нужно проверить заново. Все данные — выдуманные.

const DIR = path.resolve(process.cwd(), '../../proto/parvane/vectors/clients');
const REGEN = process.env.PARVANE_REGEN_VECTORS === '1';

function vectorPath(name: string) {
  return path.join(DIR, name);
}

/** JSON как его записал бы `JSON.stringify`: без `undefined`, Map → объект. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (v instanceof Map ? Object.fromEntries(v) : v))) as T;
}

function ensureVector(name: string, build: () => unknown) {
  const file = vectorPath(name);
  if (REGEN || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, `${JSON.stringify(plain(build()), undefined, 2)}\n`);
  }
  const stored = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  expect(plain(build())).toEqual(stored);
  return stored;
}

// ── «План» ───────────────────────────────────────────────────────────────────

const PLANNER_ENGINE: EngineState = {
  tasks: [
    {
      id: 't-water',
      name: 'Полить рассаду',
      description: 'помидоры и перец',
      steps: [{ text: 'теплица', isDone: true }, { text: 'балкон', isDone: false }],
      status: 'active',
      listId: 'l-garden',
      rank: 2,
      day: '',
      start: '07:30',
      due: '',
      minutes: 20,
      repeat: {
        kind: 'daily', interval: 2, weekdays: [], monthDay: 0, startDay: '2026-11-01', endDay: '2026-11-30', count: 0,
      },
      occurrences: [{
        day: '2026-11-03', excluded: false, done: true, doneSteps: [0],
      }, {
        day: '2026-11-05', excluded: true, done: false, doneSteps: [],
      }],
      origin: null,
      source: { chat: 'note:Огород', opId: '0192f1a2-3333-7000-8000-000000000031' },
      remind: 10,
    },
    {
      id: 't-book',
      name: 'Дочитать главу',
      description: '',
      steps: [],
      status: 'queue',
      listId: 'l-read',
      rank: 0,
      day: '2026-11-04',
      start: '',
      due: '2026-11-10',
      minutes: null,
      repeat: null,
      occurrences: [],
      origin: null,
      source: null,
      remind: null,
    },
    {
      id: 't-tax',
      name: 'Отчёт в фонд',
      description: '',
      steps: [],
      status: 'done',
      listId: 'l-missing',
      rank: 1.5,
      day: '',
      start: '',
      due: '2026-11-20',
      minutes: 45,
    },
  ],
  events: [
    {
      id: 'e-choir', name: 'Хор', start: '19:00', end: '20:30', weekdays: [2, 4], day: '',
    },
    {
      id: 'e-rent',
      name: 'Платёж за гараж',
      start: '10:00',
      end: '10:15',
      weekdays: null,
      day: '',
      repeat: {
        kind: 'monthly', interval: 1, weekdays: [], monthDay: 5, startDay: '2026-09-05', endDay: '', count: 6,
      },
      occurrences: [{
        day: '2026-11-05', excluded: true, done: false, doneSteps: [],
      }],
      origin: null,
      description: 'через банк',
      remind: 60,
      listId: 'l-garden',
    },
    {
      id: 'e-day',
      name: 'Выходной',
      start: '00:00',
      end: '23:59',
      weekdays: null,
      day: '2026-11-04',
      allDay: true,
      isHoliday: true,
      color: 3,
      remind: null,
    },
    {
      id: 'e-split',
      name: 'Хор',
      start: '18:00',
      end: '19:30',
      weekdays: null,
      day: '2026-11-12',
      origin: { seriesId: 'e-choir', day: '2026-11-12' },
      color: 0,
    },
  ],
  lists: [
    {
      id: 'l-read', name: 'Чтение', order: 1, color: 4,
    },
    { id: 'l-garden', name: 'Огород', order: 0 },
    {
      id: 'l-garden-dup', name: 'Огород', order: 2, color: 1,
    },
  ],
  nutrition: [
    {
      day: '2026-11-02',
      entries: [
        {
          id: 'f-oat',
          name: 'Овсянка',
          meal: 'breakfast',
          kcal: 340,
          protein: 12,
          fat: 6,
          carbs: 58,
          fiber: 8,
          grams: 300,
          per100: true,
          time: '08:10',
        },
        {
          id: 'f-fish',
          name: 'Треска',
          meal: 'dinner',
          kcal: 180,
          protein: 40,
          fat: null,
          carbs: null,
          fiber: null,
          grams: null,
          per100: false,
          sugar: 0,
          salt: 1.5,
        },
      ],
      isComplete: true,
      fixedGoals: {
        kcal: { target: 1900, tolerance: 100 },
        protein: { target: 110, tolerance: 15 },
        fat: null,
        carbs: null,
        water: { target: 1800, tolerance: 200 },
      },
      waterMl: 1600,
    },
    {
      day: '2026-11-03', entries: [], isComplete: false, fixedGoals: null, waterMl: 400,
    },
    {
      day: '2026-11-04', entries: [], isComplete: false, fixedGoals: null, waterMl: null,
    },
  ],
  settings: {
    dayStart: 420, dayEnd: 1320, lunchStart: 0, lunchEnd: 0, margin: 5, budget: 540,
  },
  goals: {
    kcal: { target: 1900, tolerance: 100 },
    protein: { target: 110, tolerance: 15 },
    fat: null,
    carbs: null,
    fiber: { target: 25, tolerance: 5 },
    water: { target: 1800, tolerance: 200 },
  },
  goalPeriods: [{
    id: 'g-cut',
    startDay: '2026-11-10',
    endDay: '2026-11-24',
    kcal: { target: 1600, tolerance: 80 },
    protein: null,
    fat: null,
    carbs: null,
    fiber: null,
    water: null,
  }],
  health: [
    {
      id: 'h-sleep',
      day: '2026-11-02',
      kind: 'sleep',
      time: '23:10',
      endTime: '06:40',
      value: 450,
      value2: 0,
      name: '',
      details: '',
    },
    {
      id: 'h-weight',
      day: '2026-11-03',
      kind: 'weight',
      time: '',
      endTime: '',
      value: 73.4,
      value2: 0,
      name: '',
      details: '',
    },
    {
      id: 'h-run',
      day: '2026-11-03',
      kind: 'workout',
      time: '07:00',
      endTime: '07:40',
      value: 40,
      value2: 6.5,
      name: 'бег',
      details: '{"ex":[{"name":"разминка","reps":10},{"name":"бег","sets":1,"weight":0}]}',
    },
    {
      id: 'h-bad',
      day: '2026-11-01',
      kind: 'mood',
      time: '',
      endTime: '',
      value: 4,
      value2: 0,
      name: '',
      details: '{не json',
    },
    {
      id: 'health-goals',
      day: '2000-01-01',
      kind: 'goals',
      time: '',
      endTime: '',
      value: 0,
      value2: 0,
      name: '',
      details: '{"sugarMax":40,"saltMax":5,"sleepMinutes":480,"steps":9000,"activeMinutes":150,"workouts":3}',
    },
  ],
  learned: [
    {
      id: 'созвон', kind: 'event', kindCount: 3, minutes: 30, minutesCount: 2, touched: 12,
    },
    {
      id: 'прогулка', kind: '', kindCount: 0, minutes: null, minutesCount: 0, touched: 11,
    },
  ],
  quickLines: [
    {
      id: 'q-1', text: 'Купить семена', count: 2, touched: 5, hidden: false,
    },
    {
      id: 'q-2', text: 'созвон', count: 0, touched: 1, hidden: true,
    },
  ],
  reminded: ['t-water@2026-11-03@10', 'e-rent@2026-11-05@60'],
  headSeq: 42,
  sizeBytes: 5120,
};

// Запись устройства этапа 1 (до синхронизации): числовые id получат префикс устройства
const PLANNER_LEGACY: PlannerState = {
  ...createEmptyPlannerState(),
  tasks: [{
    id: '17',
    name: 'Сдать книги',
    description: '',
    steps: [],
    status: 'queue',
    project: 'Чтение',
    rank: 0,
    due: '2026-10-30',
  }],
  events: [{
    id: '3', name: 'Поликлиника', start: '09:00', end: '09:30', day: '2026-10-28', remind: 30,
  }],
  projects: ['', 'Чтение'],
  lists: [{
    id: '1', name: 'Чтение', order: 0,
  }],
  budget: 480,
};

function buildPlannerVector() {
  const state = fromEngineState(PLANNER_ENGINE);
  const edited = plain(state);
  edited.tasks[0].status = 'done';
  edited.tasks[0].occurrences = [...(edited.tasks[0].occurrences || []), { day: '2026-11-07', done: true }];
  edited.tasks = edited.tasks.filter((t) => t.id !== 't-book');
  edited.tasks.push({
    id: 't-new',
    name: 'Заказать плёнку',
    description: '',
    steps: [],
    status: 'queue',
    project: 'Чтение',
    rank: 3,
    minutes: 15,
  });
  edited.lists[0].color = 6;
  edited.lists.push({
    id: 'l-new', name: 'Дом', order: 3, color: 2,
  });
  edited.projects = ['', ...edited.lists.map((l) => l.name)];
  edited.events[0].start = '19:15';
  edited.events = edited.events.filter((e) => e.id !== 'e-day');
  edited.events.push({
    id: 'e-new', name: 'Врач', start: '11:00', end: '11:40', day: '2026-11-18', remind: 15, project: 'Дом',
  });
  edited.nutrition['2026-11-03'].waterMl = 900;
  delete edited.nutrition['2026-11-02'];
  edited.nutrition['2026-11-06'] = { entries: [], isComplete: false, waterMl: 250 };
  edited.budget = 600;
  edited.settings = { ...edited.settings, margin: 10 };
  edited.goals = { ...edited.goals, water: { target: 2000, tolerance: 200 } };
  edited.goalPeriods[0].endDay = '2026-11-30';
  edited.health = edited.health.filter((h) => h.id !== 'h-weight');
  edited.health.push({
    id: 'h-steps', day: '2026-11-04', kind: 'steps', value: 8200,
  });
  edited.healthGoals = { ...edited.healthGoals, steps: 10000 };
  edited.learned[0].minutes = 45;
  edited.learned = edited.learned.filter((w) => w.id !== 'прогулка');
  edited.quickLines[0].count = 3;
  edited.reminded = ['t-water@2026-11-03@10', 't-new@2026-11-08@0'];

  const coalesceInput = [
    { task: { id: 't-water', status: 'done' } },
    { nutritionDay: { day: '2026-11-03', entries: [{ id: 'f-a', name: 'Чай', meal: 'other', kcal: 5 }] } },
    { task: { id: 't-water', name: 'Полить всё', occurrences: [{ day: '2026-11-09', done: true }] } },
    {
      nutritionDay: {
        day: '2026-11-03',
        waterMl: 700,
        entries: [{ id: 'f-a', kcal: 7 }, {
          id: 'f-b', name: 'Хлеб', meal: 'other', kcal: 90,
        }],
      },
    },
    { settings: { budget: 500 } },
    { migration: { sourceDevice: 'desk', count: 1 } },
    { task: { id: 't-book', deleted: true } },
    { task: { id: 't-book', name: 'Снова' } },
    { settings: { margin: 20 } },
  ];

  return {
    engine: PLANNER_ENGINE,
    hasQuickLines: hasEngineQuickLines(PLANNER_ENGINE),
    state,
    fullChanges: diffChanges(createEmptyPlannerState(), state),
    edited,
    editChanges: diffChanges(state, edited),
    legacy: PLANNER_LEGACY,
    legacyChanges: legacyToChanges(PLANNER_LEGACY, 'desk-01:Linux'),
    legacyRecordCases: [
      { raw: PLANNER_LEGACY, isLegacy: isLegacyPlannerRecord(PLANNER_LEGACY) },
      { raw: { version: 1 }, isLegacy: isLegacyPlannerRecord({ version: 1 }) },
      { raw: { migrated: true }, isLegacy: isLegacyPlannerRecord({ migrated: true }) },
    ],
    coalesceInput,
    coalesced: coalesceChanges(coalesceInput),
  };
}

// ── «Облако» ─────────────────────────────────────────────────────────────────

const node = (fields: Partial<CloudNode> & Pick<CloudNode, 'id' | 'kind' | 'name'>): CloudNode => ({
  size: 0, mime: '', mtime: 0, trashed: false, trashTop: false, trashedAt: 0, ...fields,
});

const DAY = 24 * 60 * 60 * 1000;
const CLOUD_NOW = 1_762_000_000_000;
const UPLOADER = 'vera@parvane.example';
const blobOf = (id: string, size: number, chunks: number, mime: string) => ({
  fileId: `blob-${id}`,
  key: Buffer.from(`key-${id}`).toString('base64'),
  nonce: Buffer.from(`nonce-${id}`).toString('base64'),
  capability: Buffer.from(`cap-${id}`).toString('base64'),
  size,
  chunks,
  mime,
  uploader: UPLOADER,
});
const MANIFEST_FILE = {
  path: 'a.txt', size: 1, blobSize: 1, chunks: 1, fileId: 'f', key: 'k', nonce: 'n',
};
const CLOUD_NODES: CloudNode[] = [
  node({
    id: 'f-docs', kind: 'folder', name: 'Документы', mtime: CLOUD_NOW - 40 * DAY,
  }),
  node({
    id: 'f-photo', kind: 'folder', name: 'Фото', parent: 'f-docs', mtime: CLOUD_NOW - 3 * DAY,
  }),
  node({
    id: 'r2',
    kind: 'file',
    name: 'отчёт 2.pdf',
    parent: 'f-docs',
    size: 20480,
    mime: 'application/pdf',
    mtime: CLOUD_NOW - 2 * DAY,
    blob: blobOf('r2', 20480, 1, 'application/pdf'),
  }),
  node({
    id: 'r10',
    kind: 'file',
    name: 'отчёт 10.pdf',
    parent: 'f-docs',
    size: 10240,
    mime: 'application/pdf',
    mtime: CLOUD_NOW - DAY,
    blob: blobOf('r10', 10240, 1, 'application/pdf'),
  }),
  node({
    id: 'cat',
    kind: 'file',
    name: 'Кот.JPG',
    parent: 'f-photo',
    size: 350000,
    mime: 'image/jpeg',
    mtime: CLOUD_NOW - 5 * DAY,
    blob: blobOf('cat', 350000, 2, 'image/jpeg'),
    thumb: {
      fileId: 'thumb-cat', nonce: 'dG51bWItY2F0', capability: 'Y2FwLXRodW1i', width: 320, height: 240,
    },
  }),
  node({
    id: 'readme', kind: 'file', name: 'readme.txt', size: 120, mime: 'text/plain', mtime: CLOUD_NOW - 100 * DAY,
    blob: blobOf('readme', 120, 1, 'text/plain'),
  }),
  node({
    id: 'svc', kind: 'file', name: '.parvane-notes.json', size: 64, mime: 'application/json', mtime: CLOUD_NOW,
  }),
  node({
    id: 'f-old',
    kind: 'folder',
    name: 'Старое',
    trashed: true,
    trashTop: true,
    trashedAt: CLOUD_NOW - 2 * DAY,
    mtime: CLOUD_NOW - 60 * DAY,
  }),
  node({
    id: 'old-file',
    kind: 'file',
    name: 'черновик.txt',
    parent: 'f-old',
    size: 900,
    mime: 'text/plain',
    trashed: true,
    mtime: CLOUD_NOW - 61 * DAY,
  }),
  node({
    id: 'gone',
    kind: 'file',
    name: 'лишнее.bin',
    parent: 'f-docs',
    size: 5000,
    trashed: true,
    trashTop: true,
    trashedAt: CLOUD_NOW - 31 * DAY,
    mtime: CLOUD_NOW - 90 * DAY,
  }),
  node({
    id: 'nodate',
    kind: 'file',
    name: 'без даты.mov',
    size: 70,
    mime: 'video/quicktime',
    trashed: true,
    trashTop: true,
    trashedAt: 0,
  }),
];

const ids = (nodes: CloudNode[]) => nodes.map((n) => n.id);

function buildCloudVector() {
  const nodes = CLOUD_NODES;
  const sortCases = [
    { key: 'name', isDescending: false }, { key: 'name', isDescending: true },
    { key: 'date', isDescending: true }, { key: 'size', isDescending: false },
  ] as const;
  const kindCases: [string, string][] = [
    ['application/pdf', 'a.bin'], ['image/svg+xml', 'схема.svg'], ['image/png', 'x.png'], ['', 'фото.HEIC'],
    ['video/mp2t', 'код.ts'], ['video/mp4', 'клип.mp4'], ['', 'песня.flac'], ['text/markdown; charset=utf-8', 'z'],
    ['application/json', 'данные.json'], ['application/octet-stream', 'модель.3mf'], ['', 'архив.tar.gz'],
  ];
  const freeNameCases: [string[], string][] = [
    [['отчёт.pdf'], 'отчёт.pdf'], [['отчёт.pdf', 'отчёт (2).pdf'], 'отчёт.pdf'], [['Папка', 'Папка (2)'], 'папка'],
    [[], 'новый'], [['.env'], '.env'], [['архив.tar.gz'], 'архив.tar.gz'],
  ];
  const validateCases = [
    '', '   ', 'a'.repeat(256), 'ё'.repeat(200), 'плохое/имя', 'с\\слешем', '.', '..', 'CON', 'норм.txt', ' пробел ',
    'tab\tв',
  ];
  const linkNodes = nodes as unknown as LinkSourceNode[];
  const planFolder = buildLinkPlan(linkNodes, 'f-docs');
  const planFile = buildLinkPlan(linkNodes, 'cat');
  const planRoot = buildLinkPlan(linkNodes, undefined, 'Общая папка');
  const copies = new Map<string, { fileId: string; blobSize: number; chunks: number; thumb?: LinkManifestThumb }>([
    ['r2', { fileId: 'copy-r2', blobSize: 20520, chunks: 1 }],
    ['r10', { fileId: 'copy-r10', blobSize: 10280, chunks: 1 }],
    ['cat', {
      fileId: 'copy-cat',
      blobSize: 350056,
      chunks: 2,
      thumb: { fileId: 'copy-thumb-cat', nonce: 'bm9uY2UtdGh1bWI=', blobSize: 9000 },
    }],
  ]);
  const manifest = buildManifest(planFolder as LinkPlan, copies, 1_762_000_123);
  const manifestText = JSON.stringify(manifest);
  const badManifests = [
    '{', JSON.stringify({ ...manifest, v: 2 }), JSON.stringify({ ...manifest, name: '' }),
    JSON.stringify({ ...manifest, kind: 'dir' }),
    JSON.stringify({ ...manifest, items: [{ path: '../x', dir: true }] }),
    JSON.stringify({ ...manifest, items: [{ path: 'a', dir: true }, { path: 'a', dir: true }] }),
    JSON.stringify({ ...manifest, items: [{ ...MANIFEST_FILE, chunks: 0 }] }),
    JSON.stringify({ ...manifest, items: [{ ...MANIFEST_FILE, size: -1 }] }),
  ];
  const tolerantManifest = JSON.stringify({
    v: 1,
    name: 'x',
    kind: 'file',
    created: 'вчера',
    items: [{
      ...MANIFEST_FILE, thumb: { fileId: '', nonce: 'n', blobSize: 1 },
    }, {
      path: 'b.txt', size: 2, blobSize: 3, chunks: 1, fileId: 'g', key: 'k', nonce: 'n', mime: 7,
    }],
  });
  return {
    nodes,
    now: CLOUD_NOW,
    listed: ids(listedNodes(nodes)),
    children: {
      root: ids(childrenOf(nodes)),
      docs: ids(childrenOf(nodes, 'f-docs')),
      listedRoot: ids(childrenOf(listedNodes(nodes))),
    },
    names: { root: namesIn(nodes), docs: namesIn(nodes, 'f-docs', 'r2') },
    path: ids(pathOf(nodes, 'cat')),
    pathRoot: ids(pathOf(nodes)),
    subtree: ids(subtreeOf(nodes, 'f-docs')),
    canMove: [
      { moved: ['r2'], target: 'f-photo', ok: canMoveInto(nodes, ['r2'], 'f-photo') },
      { moved: ['f-docs'], target: 'f-photo', ok: canMoveInto(nodes, ['f-docs'], 'f-photo') },
      { moved: ['f-photo'], target: 'f-photo', ok: canMoveInto(nodes, ['f-photo'], 'f-photo') },
      { moved: ['cat', 'r10'], target: undefined, ok: canMoveInto(nodes, ['cat', 'r10']) },
    ],
    sorted: sortCases.map((sort) => ({ sort, ids: ids(sortNodes(childrenOf(listedNodes(nodes), 'f-docs'), sort)) })),
    sortedAll: sortCases.map((sort) => ({ sort, ids: ids(sortNodes(nodes, sort)) })),
    search: ['отч', '  КОТ ', '', 'txt', '.parvane'].map((query) => ({ query, ids: ids(searchNodes(nodes, query)) })),
    trash: ids(trashOf(nodes)),
    expiredTrash: ids(expiredTrashOf(nodes, CLOUD_NOW)),
    expiredTrashWeek: ids(expiredTrashOf(nodes, CLOUD_NOW, 7 * DAY)),
    trashDaysLeft: Object.fromEntries(trashOf(nodes).map((n) => [n.id, trashDaysLeft(n, CLOUD_NOW)])),
    usage: usageOf(nodes),
    sizeOf: { docs: sizeOf(nodes, 'f-docs'), photo: sizeOf(nodes, 'f-photo'), old: sizeOf(nodes, 'f-old') },
    folderStats: folderStats(nodes),
    kinds: kindCases.map(([mime, name]) => ({ mime, name, kind: kindOfFile(mime, name) })),
    typeLabels: ['модель.3mf', 'отчёт.pdf', 'архив.tar.gz', 'без', 'x.verylongextension', 'файл.ЁЛКА']
      .map((name) => ({ name, label: fileTypeLabel(name) })),
    extensions: ['a.TXT', '.env', 'архив.tar.gz', 'без', 'точка.']
      .map((name) => ({ name, extension: getExtension(name) })),
    freeNames: freeNameCases.map(([taken, name]) => ({ taken, name, free: freeName(taken, name) })),
    validation: validateCases.map((name) => ({ name, error: validateName(name) ?? null })),
    linkPlan: {
      folder: planFolder,
      file: planFile,
      root: planRoot,
      trashed: buildLinkPlan(linkNodes, 'f-old'),
      missing: buildLinkPlan(linkNodes, 'nope'),
      noBlob: buildLinkPlan(linkNodes, 'svc'),
    },
    manifest,
    manifestText,
    parsedManifest: parseManifest(manifestText),
    badManifests: badManifests.map((text) => ({ text, parsed: parseManifest(text) ?? null })),
    tolerantManifest: { text: tolerantManifest, parsed: parseManifest(tolerantManifest) },
    urls: [
      ['https://parvane.example:20443', 'abc123', 'AAAA_-8'],
      ['https://parvane.example/', 'z', 'k'],
    ].map(([origin, id, key]) => ({
      origin, id, key, url: buildLinkUrl(origin, id, key),
    })),
  };
}

// ── Заметки ──────────────────────────────────────────────────────────────────

const NOTE_TEXTS = [
  [
    '---',
    'tags: [огород, "план 2027"]',
    'автор: Вера',
    'список:',
    '  - один',
    '  - два',
    'пусто:',
    '---',
    '# Огород',
    '',
    'Связано с [[Теплица]] и [[Рассада|помидорами]], ещё раз [[теплица]].',
    '',
    '- [ ] купить плёнку #покупки ^t7f3a1',
    '- [x] заказать семена #покупки/семена',
    '* [ ] без метки',
    '',
    '```',
    '- [ ] в коде не пункт [[НеСсылка]] #нетег',
    '```',
    'Код `[[тоже не ссылка]]` и #тег_в_конце',
  ].join('\n'),
  'Без свойств\n\nПросто текст с [[Огород]] и повтором [[огород]].\n- [ ] пункт\r\n- [X] готово ^tzz9k',
  '',
  '---\nнезакрытые свойства\nтекст',
  '--- \nkey: value\n---\n',
];

const NOTE_SOURCES: NoteSource[] = [
  {
    id: 'n-garden', title: 'Огород', folder: 'Дом', text: NOTE_TEXTS[0], updatedAt: 1_762_000_000_000,
  },
  {
    id: 'n-green',
    title: 'Теплица',
    folder: 'Дом/Участок',
    text: 'Поликарбонат. См. [[Огород]] и [[Рассада]]. #огород',
    updatedAt: 1_761_900_000_000,
  },
  {
    id: 'n-seed', title: 'рассада', folder: '', text: 'Перец и томаты. #огород #покупки', updatedAt: 1_761_800_000_000,
  },
  {
    id: 'n-day',
    title: '2026-11-03',
    folder: 'Дневник',
    text: '# 2026-11-03\n\n- [ ] утро [[Огород]]\n',
    updatedAt: 1_762_100_000_000,
  },
];

const FOLDER_NAME_CASES: [string, string[]][] = [
  ['Идеи', ['Дом', 'идеи']], ['Новая', ['Дом']], ['', []], ['a'.repeat(81), []], ['Плохо/имя', []], ['  Дом ', ['Дом']],
];
const folderNode = (id: string, name: string, parent?: string, trashed = false): FolderNode => ({
  id, kind: 'folder', name, parent, trashed,
});
const fileNode = (id: string, name: string, parent?: string, trashed = false): FolderNode => ({
  id, kind: 'file', name, parent, trashed,
});
const VAULT_TREE: FolderNode[] = [
  folderNode('v', 'Знания'),
  folderNode('home', 'Дом', 'v'),
  folderNode('plot', 'Участок', 'home'),
  folderNode('diary', 'Дневник', 'v'),
  folderNode('ideas', 'Идеи', 'v'),
  folderNode('gone', 'Старое', 'v', true),
  folderNode('outside', 'Фото'),
  fileNode('m1', 'Огород.md', 'home'),
  fileNode('m2', 'Теплица.md', 'plot'),
  fileNode('m3', 'Удалено.md', 'home', true),
  fileNode('c1', 'Схема.canvas', 'plot'),
  fileNode('p1', 'грядки.png', 'plot'),
  fileNode('m4', 'рассада.md', 'v'),
  fileNode('m5', '2026-11-03.md', 'diary'),
];

function buildNotesVector() {
  const idSequence = ['aaaaa', '7f3a1', 'bbbbb', 'ccccc', 'ddddd', 'eeeee'];
  const makeIds = () => {
    let i = 0;
    return () => idSequence[i++ % idSequence.length];
  };
  const index = buildNotesIndex(NOTE_SOURCES);
  const serializeCases: { properties: NoteProperties; body: string }[] = [
    { properties: {}, body: 'только тело' },
    {
      properties: {
        tags: ['а', 'б: в', 'с "кавычкой"'], автор: 'Вера', число: '42', пусто: '', дата: '2026-11-03',
      },
      body: 'тело\nвторая',
    },
    { properties: { странное: '#начало', список: ['[скобка', 'кав\'ычка'] }, body: '' },
  ];
  const marked = [
    'Список', '- [ ] первый ^t7f3a1', '- [ ] второй ^t7f3a1', '- [ ] третий', '```', '- [ ] в коде ^t7f3a1', '```',
    '- [x] четвёртый ^t7f3a1\r',
  ].join('\n');
  return {
    notes: NOTE_TEXTS.map((text) => ({ text, parsed: parseNote(text) })),
    serialize: serializeCases.map((c) => ({
      ...c, text: serializeNote(c), reparsed: parseNote(serializeNote(c)).properties,
    })),
    sources: NOTE_SOURCES,
    index: {
      notes: index.notes.map((n) => ({
        id: n.id, linkedIds: n.linkedIds, unresolved: n.unresolved, links: n.parsed.links,
      })),
      byTitle: ['огород', ' ТЕПЛИЦА ', 'Рассада', 'нет']
        .map((title) => ({ title, id: index.byTitle(title)?.id ?? null })),
      backlinks: NOTE_SOURCES.map((s) => ({ id: s.id, ids: index.backlinks(s.id).map((n) => n.id) })),
      unresolved: index.unresolved,
      tags: index.tags,
      search: ['огород', 'ПОЛИКАРБОНАТ', 'покупки/семена', '', 'нет такого', 'перец томаты']
        .map((query) => ({ query, ids: index.search(query).map((n) => n.id) })),
    },
    edits: {
      setTaskDone: [
        { text: NOTE_TEXTS[0], line: 12, isDone: true, result: setTaskDone(NOTE_TEXTS[0], 12, true) },
        { text: NOTE_TEXTS[0], line: 13, isDone: false, result: setTaskDone(NOTE_TEXTS[0], 13, false) },
        { text: NOTE_TEXTS[0], line: 8, isDone: true, result: setTaskDone(NOTE_TEXTS[0], 8, true) },
        { text: NOTE_TEXTS[1], line: 3, isDone: true, result: setTaskDone(NOTE_TEXTS[1], 3, true) },
      ],
      ensureTaskMarker: [14, 12, 2, 99].map((line) => ({
        text: NOTE_TEXTS[0], line, result: ensureTaskMarker(NOTE_TEXTS[0], line, makeIds()),
      })),
      findTaskLine: ['t7f3a1', '^t7f3a1', 'tzz9k', 'нет'].map((marker) => ({
        text: NOTE_TEXTS[0], marker, line: findTaskLine(NOTE_TEXTS[0], marker) ?? null,
      })),
      findInSecond: { text: NOTE_TEXTS[1], marker: 'tzz9k', line: findTaskLine(NOTE_TEXTS[1], 'tzz9k') ?? null },
      removeTaskLine: ['t7f3a1', 'нет'].map((marker) => ({
        text: NOTE_TEXTS[0], marker, result: removeTaskLine(NOTE_TEXTS[0], marker),
      })),
      dedupe: { text: marked, result: dedupeTaskMarkers(marked, makeIds()) },
      dedupeClean: { text: NOTE_TEXTS[0], result: dedupeTaskMarkers(NOTE_TEXTS[0], makeIds()) },
      rename: [
        { text: NOTE_TEXTS[0], from: 'Теплица', to: 'Парник', result: renameLinks(NOTE_TEXTS[0], 'Теплица', 'Парник') },
        {
          text: NOTE_TEXTS[0], from: 'рассада', to: 'Саженцы', result: renameLinks(NOTE_TEXTS[0], 'рассада', 'Саженцы'),
        },
        { text: NOTE_TEXTS[1], from: 'огород', to: 'Сад', result: renameLinks(NOTE_TEXTS[1], 'огород', 'Сад') },
      ],
      daily: { day: '2026-11-03', title: dailyNoteTitle('2026-11-03'), template: dailyNoteTemplate('2026-11-03') },
    },
    folders: {
      tree: VAULT_TREE,
      vaultId: 'v',
      list: listNoteFolders(VAULT_TREE, 'v'),
      listOther: listNoteFolders(VAULT_TREE, 'outside'),
      captions: ['', 'Дом', 'Дом/Участок', 'А/Б/В'].map((p) => ({ path: p, caption: folderCaption(p) })),
      isIn: [['Дом/Участок', 'Дом'], ['Дом', 'Дом/Участок'], ['Домик', 'Дом'], ['Дом', ''], ['', ''], ['Дом', 'Дом']]
        .map(([noteFolder, p]) => ({ noteFolder, path: p, result: isInFolder(noteFolder, p) })),
      names: FOLDER_NAME_CASES.map(([name, siblings]) => ({
        name, siblings, error: checkFolderName(name, siblings) ?? null,
      })),
      contents: ['home', 'plot', 'diary', 'gone', 'nope'].map((id) => {
        const c = folderContents(VAULT_TREE, id);
        return { id, notes: c.notes.map((n) => n.id), others: c.others.map((n) => n.id) };
      }),
      groups: [
        { isSearch: false, dailyShown: 1 }, { isSearch: true }, { isSearch: false },
      ].map((opts) => ({
        ...opts,
        result: buildNoteGroups({
          notes: [
            { title: 'Огород', folder: 'Дом', isDaily: false },
            { title: 'Теплица', folder: 'Дом/Участок', isDaily: false },
            { title: 'рассада', folder: '', isDaily: false },
            { title: '2026-11-03', folder: 'Дневник', isDaily: true },
            { title: '2026-11-01', folder: 'Дневник', isDaily: true },
            { title: 'не день', folder: 'Дневник', isDaily: true },
            { title: 'Потерянная', folder: 'Старое', isDaily: false },
          ],
          folders: listNoteFolders(VAULT_TREE, 'v'),
          dailyFolders: ['Дневник'],
          ...opts,
        }),
      })),
    },
  };
}

// ── Холст ────────────────────────────────────────────────────────────────────

const CANVAS_FILES = [
  JSON.stringify({
    nodes: [
      {
        id: 'grp',
        type: 'group',
        x: 0,
        y: 0,
        width: 600,
        height: 400,
        label: 'Участок',
        color: '4',
        background: 'фон.png',
        backgroundStyle: 'cover',
      },
      {
        id: 'txt', type: 'text', x: 20, y: 40, width: 250, height: 60, text: 'Грядки **весной**', color: '#ff8800',
      },
      {
        id: 'note',
        type: 'file',
        x: 300,
        y: 40,
        width: 250,
        height: 120,
        file: 'Теплица.md',
        subpath: '#Полив',
        pvNote: 'n-green',
      },
      {
        id: 'img',
        type: 'file',
        x: 20,
        y: 200,
        width: 320,
        height: 180,
        file: 'грядки.png',
        pvImage: { fileId: 'blob-img', width: 1280, height: 720 },
      },
      {
        id: 'web', type: 'link', x: 700, y: 50, width: 250, height: 60, url: 'https://example.org/seeds',
      },
      {
        id: 'odd', type: 'sticker', x: '15.5', y: null, width: 0, height: '', emoji: '🌱',
      },
      { id: 42, type: 'text', text: 'числовой id' },
      { type: 'text', x: 1, y: 1 },
      { id: 'txt', type: 'text', x: 9, y: 9 },
      'мусор',
    ],
    edges: [
      {
        id: 'e1',
        fromNode: 'txt',
        toNode: 'note',
        fromSide: 'right',
        toSide: 'left',
        toEnd: 'arrow',
        label: 'см.',
        color: '2',
      },
      {
        id: 'e2', fromNode: 'img', toNode: 'web', fromEnd: 'none', zzz: 1, aaa: [1, 2],
      },
      { id: 'e3', fromNode: 'nope', toNode: 'txt' },
      { id: 'e1', fromNode: 'txt', toNode: 'web' },
      { fromNode: 'txt', toNode: 'web' },
      { id: 'e4', fromNode: 7, toNode: 'txt' },
    ],
    metadata: { version: '1.0', frontmatter: { title: 'Схема' } },
    pvGraphScope: 'Дом',
  }),
  '',
  '   \n',
  '{}',
  '{"nodes": {}, "edges": []}',
  '[1, 2]',
  '{"nodes": [',
  '{"edges": [{"id": "e", "fromNode": "a", "toNode": "b"}], "x": 1}',
];

function buildCanvasVector() {
  const base = parseCanvas(CANVAS_FILES[0]).doc;
  const seq = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
  };
  const makeId = () => 'edge-new-0001';
  const steps: { name: string; doc: CanvasDoc }[] = [];
  let doc = base;
  const step = (name: string, next: CanvasDoc) => {
    doc = next;
    steps.push({ name, doc });
  };
  step('addNode', addNode(doc, {
    id: 'new', type: 'text', x: 10.4, y: -3, width: 100, height: 50, text: 'новый',
  }));
  step('addNode-duplicate', addNode(doc, {
    id: 'txt', type: 'text', x: 0, y: 0, width: 1, height: 1,
  }));
  step('updateNode', updateNode(doc, 'txt', { text: 'Грядки осенью', color: undefined, x: 25, pvExtra: 'да' }));
  step('updateNode-missing', updateNode(doc, 'nope', { text: 'x' }));
  step('addEdge', addEdge(doc, 'new', 'txt', 'связь', makeId));
  step('addEdge-loop', addEdge(doc, 'new', 'new', undefined, makeId));
  step('addEdge-duplicate', addEdge(doc, 'txt', 'note', undefined, makeId));
  step('updateEdge', updateEdge(doc, 'e1', { label: '', toEnd: undefined, color: '5' }));
  step('removeEdge', removeEdge(doc, 'e2'));
  step('moveNode-group', moveNode(doc, 'grp', 10.6, -20.5));
  step('moveNode-single', moveNode(doc, 'web', -0.4, 0.5));
  step('removeNode', removeNode(doc, 'note'));
  const sides: CanvasSide[] = ['top', 'right', 'bottom', 'left'];
  const rectA = {
    x: 0, y: 0, width: 100, height: 50,
  };
  const rectB = {
    x: 300, y: 200, width: 80, height: 80,
  };
  const rectC = {
    x: -50, y: 10, width: 40, height: 40,
  };
  return {
    files: CANVAS_FILES.map((text) => {
      const parsed = parseCanvas(text);
      return {
        text,
        doc: parsed.doc,
        error: parsed.error ?? null,
        dropped: parsed.dropped,
        serialized: serializeCanvas(parsed.doc),
      };
    }),
    roundTrip: serializeCanvas(parseCanvas(serializeCanvas(base)).doc) === serializeCanvas(base),
    ops: steps.map(({ name, doc: d }) => ({ name, serialized: serializeCanvas(d) })),
    inGroup: {
      group: 'grp',
      ids: nodesInGroup(base, 'grp').map((n) => n.id),
      notGroup: nodesInGroup(base, 'txt').map((n) => n.id),
    },
    geometry: {
      bounds: boundsOf(base) ?? null,
      boundsEmpty: boundsOf({ nodes: [], edges: [] }) ?? null,
      fit: [
        { bounds: boundsOf(base), viewport: { width: 800, height: 600 }, padding: undefined },
        { bounds: rectA, viewport: { width: 800, height: 600 }, padding: 0 },
        { bounds: undefined, viewport: { width: 300, height: 200 }, padding: undefined },
        { bounds: rectC, viewport: { width: 100, height: 100 }, padding: 10 },
      ].map((c) => ({ ...c, view: fitView(c.bounds, c.viewport, c.padding) })),
      firstGroup: [
        { doc: base, viewport: { width: 390, height: 700 } },
        { doc: removeNode(base, 'grp'), viewport: { width: 390, height: 700 } },
      ].map((c) => ({
        serialized: serializeCanvas(c.doc), viewport: c.viewport, view: firstGroupView(c.doc, c.viewport),
      })),
      clamp: [0, 0.1, 1, 2.5, 9].map((scale) => ({ scale, clamped: clampCanvasScale(scale) })),
      sidePoints: sides.map((side) => ({ side, point: sidePoint(rectA, side) })),
      anchors: [
        { from: rectA, to: rectB, sides: undefined },
        { from: rectB, to: rectA, sides: undefined },
        { from: rectA, to: rectC, sides: undefined },
        { from: rectA, to: rectB, sides: { fromSide: 'top' as CanvasSide } },
        { from: rectA, to: rectB, sides: { fromSide: 'left' as CanvasSide, toSide: 'bottom' as CanvasSide } },
      ].map((c) => ({ ...c, anchors: edgeAnchors(c.from, c.to, c.sides) })),
      ids: [
        [0, 0.999, 0.5, 0.0625, 1, -1, 0.25, 0.75],
        [0.999],
      ].map((values) => ({ values, id: newCanvasId(seq(values)) })),
    },
  };
}

type PlannerVector = ReturnType<typeof buildPlannerVector>;

describe('Векторы разделов web → desktop (spec 029, T037)', () => {
  it('«План»: состояние движка, изменения, перенос этапа 1, склейка правок', () => {
    const stored = ensureVector('sections-planner-web.json', buildPlannerVector) as PlannerVector;
    expect(stored.state.tasks).toHaveLength(3);
    expect(stored.editChanges.length).toBeGreaterThan(10);
  });

  it('«Облако»: дерево узлов, сортировка, корзина, ссылка и её список', () => {
    const stored = ensureVector('sections-cloud-web.json', buildCloudVector) as ReturnType<typeof buildCloudVector>;
    expect(stored.parsedManifest).toEqual(stored.manifest);
    expect(stored.nodes).toHaveLength(CLOUD_NODES.length);
  });

  it('Заметки: разбор и запись, указатель, правки пунктов, папки', () => {
    const stored = ensureVector('sections-notes-web.json', buildNotesVector) as ReturnType<typeof buildNotesVector>;
    expect(stored.notes[0].parsed.links).toEqual(['Теплица', 'Рассада']);
    expect(stored.folders.list.map((f) => f.path)).toContain('Дом/Участок');
  });

  it('Холст: разбор и запись файла, правки, геометрия', () => {
    const stored = ensureVector('sections-canvas-web.json', buildCanvasVector) as ReturnType<typeof buildCanvasVector>;
    expect(stored.roundTrip).toBe(true);
    expect(stored.files[0].dropped).toEqual({ nodes: 3, edges: 2 });
  });
});
