import { describe, expect, it } from 'vitest';

import type {
  GuideKey, GuideLang, GuideNode, GuidePlanInput,
} from './notesGuide';

import { parseQuickInput } from '../planner/plannerQuick';
import {
  buildGuide, buildGuideMarker, findGuideOverview, getGuideLang, GUIDE_FOLDER_NODE_ID, GUIDE_MARKER_NAME,
  GUIDE_MARKER_NODE_ID, GUIDE_VERSION, guideNoteNodeId, hasGuideMarker, planGuide, VAULT_NODE_ID,
} from './notesGuide';
import { buildNotesIndex, parseNote } from './notesModel';
import { planNoteTasks } from './notesTasks';

// Понедельник, 12 октября 2026
const CTX = {
  today: '2026-10-12', nowMinutes: 9 * 60, dayStart: 8 * 60, dayEnd: 22 * 60,
};
const LANGS: GuideLang[] = ['ru', 'en'];
const VAULT_NAMES = ['Знания', 'Knowledge'];
const BODY_MAX_CHARS = 4200;
const BODY_MAX_LINES = 48;
// Заметки, которые обязаны ссылаться на все остальные
const HUBS: GuideKey[] = ['overview', 'connections'];

const folder = (id: string, name: string, parent?: string, trashed = false): GuideNode => ({
  id, kind: 'folder', name, parent, trashed,
});
const file = (id: string, name: string, parent?: string, trashed = false): GuideNode => ({
  id, kind: 'file', name, parent, trashed,
});

function plan(nodes: GuideNode[], patch: Partial<GuidePlanInput> = {}) {
  let seq = 0;
  return planGuide({
    drive: 'synced',
    nodes,
    lang: 'ru',
    vaultName: 'Знания',
    vaultNames: VAULT_NAMES,
    mode: 'auto',
    makeId: () => `random-${++seq}`,
    ...patch,
  });
}

function written(nodes: GuideNode[], patch: Partial<GuidePlanInput> = {}) {
  const result = plan(nodes, patch);
  if (result.action !== 'write') throw new Error(`ожидалась запись, получено: ${result.reason}`);
  return result;
}

describe('справка: тексты', () => {
  it('язык справки — по языку интерфейса', () => {
    expect(getGuideLang('ru')).toBe('ru');
    expect(getGuideLang('ru-RU')).toBe('ru');
    expect(getGuideLang('en')).toBe('en');
    expect(getGuideLang('de')).toBe('en');
    expect(getGuideLang(undefined)).toBe('en');
  });

  it('идентификаторы узлов — по 16 байт шестнадцатеричными цифрами и разные', () => {
    const ids = [
      VAULT_NODE_ID, GUIDE_FOLDER_NODE_ID, GUIDE_MARKER_NODE_ID, ...buildGuide('ru').notes.map(({ nodeId }) => nodeId),
    ];
    ids.forEach((id) => expect(id).toMatch(/^[0-9a-f]{32}$/));
    expect(new Set(ids).size).toBe(ids.length);
    expect(guideNoteNodeId(1)).toBe(buildGuide('en').notes[0].nodeId);
  });

  it('наборы на двух языках совпадают по составу, порядку и узлам', () => {
    const [ru, en] = LANGS.map(buildGuide);
    expect(ru.notes.length).toBe(en.notes.length);
    expect(ru.notes.length).toBeGreaterThanOrEqual(9);
    expect(ru.notes.map(({ key, nodeId }) => [key, nodeId])).toEqual(en.notes.map(({ key, nodeId }) => [key, nodeId]));
    expect(ru.folderName).not.toBe(en.folderName);
  });

  LANGS.forEach((lang) => {
    describe(lang, () => {
      const guide = buildGuide(lang);
      const titles = guide.notes.map(({ title }) => title);
      const index = buildNotesIndex(guide.notes.map((note) => ({
        id: note.nodeId, title: note.title, folder: guide.folderName, text: note.text, updatedAt: 0,
      })));
      const titleOf = (key: GuideKey) => guide.notes.find((note) => note.key === key)!.title;

      it('названия разные и годятся в имена файлов', () => {
        expect(new Set(titles.map((title) => title.toLowerCase())).size).toBe(titles.length);
        titles.forEach((title) => {
          expect(/[\\/:*?"<>|]/.test(title), title).toBe(false);
          expect(title.trim(), title).toBe(title);
        });
        expect(guide.overviewTitle).toBe(titleOf('overview'));
      });

      it('каждая заметка начинается заголовком с названием и умещается на экран-два', () => {
        guide.notes.forEach((note) => {
          const lines = note.text.split('\n');
          expect(lines[0], note.title).toBe(`# ${note.title}`);
          expect(lines.length, note.title).toBeLessThanOrEqual(BODY_MAX_LINES);
          expect(note.text.length, note.title).toBeLessThanOrEqual(BODY_MAX_CHARS);
          expect(note.text.endsWith('\n'), note.title).toBe(true);
        });
      });

      it('каждая ссылка ведёт на заметку справки того же языка', () => {
        expect(index.unresolved).toEqual([]);
        guide.notes.forEach((note) => {
          parseNote(note.text).links.forEach((link) => expect(titles, `${note.title} → ${link}`).toContain(link));
        });
      });

      it('каждая заметка ссылается на «Обзор», а «Обзор» и «Связи» — на все остальные', () => {
        const overview = titleOf('overview');
        guide.notes.filter(({ key }) => key !== 'overview').forEach((note) => {
          expect(parseNote(note.text).links, note.title).toContain(overview);
        });
        HUBS.forEach((hub) => {
          const links = parseNote(guide.notes.find(({ key }) => key === hub)!.text).links;
          titles.filter((title) => title !== titleOf(hub)).forEach((title) => {
            expect(links, `${titleOf(hub)} → ${title}`).toContain(title);
          });
        });
        // На графе справка связна: у каждой заметки есть и исходящие, и входящие ссылки
        index.notes.forEach((note) => {
          expect(note.linkedIds.length, note.title).toBeGreaterThan(0);
          expect(index.backlinks(note.id).length, note.title).toBeGreaterThan(0);
        });
      });

      it('у каждой заметки один тег; пункты с галочками — без меток', () => {
        guide.notes.forEach((note) => {
          const parsed = parseNote(note.text);
          expect(parsed.tags.length, note.title).toBe(1);
          expect(parsed.tasks.every((task) => !task.isDone && !task.marker), note.title).toBe(true);
        });
        expect(guide.notes.some((note) => parseNote(note.text).tasks.length > 0)).toBe(true);
      });

      it('не заводит задач в «Плане»: сохранение текста ничего не планирует и не меняет', () => {
        guide.notes.forEach((note) => {
          const planned = planNoteTasks(note.text, CTX);
          expect(planned.tasks, note.title).toEqual([]);
          expect(planned.text, note.title).toBe(note.text);
        });
      });

      it('примеры пунктов с датой стоят в тексте кодом и разбираются как задачи', () => {
        const all = guide.notes.map(({ text }) => text).join('\n');
        guide.datedSamples.forEach((sample) => {
          expect(all).toContain(`\`- [ ] ${sample}\``);
          const planned = planNoteTasks(`- [ ] ${sample}`, CTX, () => 'abcde');
          expect(planned.tasks.length).toBe(1);
          expect(planned.tasks[0].day || planned.tasks[0].due).toBeTruthy();
        });
      });

      it('примеры строк ввода стоят в тексте кодом и разбираются так, как обещано', () => {
        const all = guide.notes.map(({ text }) => text).join('\n');
        guide.quickSamples.forEach(({ text, kind }) => {
          expect(all, text).toContain(`\`${text}\``);
          const draft = parseQuickInput(text, { ...CTX, lang });
          expect(draft.kind, text).toBe(kind);
          expect(draft.error, text).toBeUndefined();
        });
      });
    });
  });
});

describe('справка: решение о создании', () => {
  const guide = buildGuide('ru');
  const keys = guide.notes.map(({ key }) => key);

  it('диск не сверен с сервером — ничего не создаётся', () => {
    expect(plan([], { drive: 'unknown' })).toEqual({ action: 'skip', reason: 'drive-unknown' });
    expect(plan([folder('v', 'Знания')], { drive: 'unknown', mode: 'restore' }))
      .toEqual({ action: 'skip', reason: 'drive-unknown' });
  });

  it('новое хранилище: папка хранилища, папка справки, все заметки и отметка — с постоянными узлами', () => {
    [plan([], { drive: 'none' }), plan([file('other', 'отчёт.pdf')])].forEach((result) => {
      expect(result).toMatchObject({
        action: 'write',
        isFreshVault: true,
        vaultId: VAULT_NODE_ID,
        folderId: GUIDE_FOLDER_NODE_ID,
        skipped: [],
        hasMarkerWrite: true,
      });
      if (result.action !== 'write') return;
      expect(result.folders).toEqual([
        { id: VAULT_NODE_ID, name: 'Знания' },
        { id: GUIDE_FOLDER_NODE_ID, name: guide.folderName, parent: VAULT_NODE_ID },
      ]);
      expect(result.notes.map(({ key, nodeId }) => [key, nodeId])).toEqual(guide.notes.map((n) => [n.key, n.nodeId]));
    });
  });

  it('два устройства в один момент планируют одни и те же узлы', () => {
    const first = written([], { drive: 'none', makeId: () => 'a' });
    const second = written([], {
      drive: 'none', makeId: () => 'b', lang: 'en', vaultName: 'Knowledge',
    });
    const places = (result: typeof first) => result.folders.map(({ id, parent }) => [id, parent]);
    expect(places(second)).toEqual(places(first));
    expect(second.notes.map(({ nodeId }) => nodeId)).toEqual(first.notes.map(({ nodeId }) => nodeId));
  });

  it('хранилище с заметками и без отметки: справка создаётся в нём один раз', () => {
    const result = written([folder('v', 'Knowledge'), file('n1', 'Сервер.md', 'v'), folder('d', 'Daily', 'v')]);
    expect(result).toMatchObject({
      isFreshVault: false, vaultId: 'v', folderId: GUIDE_FOLDER_NODE_ID, skipped: [], hasMarkerWrite: true,
    });
    expect(result.folders).toEqual([{ id: GUIDE_FOLDER_NODE_ID, name: guide.folderName, parent: 'v' }]);
    expect(result.notes.length).toBe(guide.notes.length);
  });

  it('отметка есть — сама справка больше не создаётся, даже если её удалили', () => {
    const marked = [folder('v', 'Знания'), file(GUIDE_MARKER_NODE_ID, GUIDE_MARKER_NAME, 'v')];
    expect(plan(marked)).toEqual({ action: 'skip', reason: 'has-marker' });
    // Папка справки в корзине, отметка на месте
    expect(plan([...marked, folder(GUIDE_FOLDER_NODE_ID, guide.folderName, 'v', true)]))
      .toEqual({ action: 'skip', reason: 'has-marker' });
    // Отметка в корзине либо записана под другим узлом — тоже «уже была»
    expect(plan([folder('v', 'Знания'), file(GUIDE_MARKER_NODE_ID, GUIDE_MARKER_NAME, 'v', true)]).action).toBe('skip');
    expect(plan([folder('v', 'Знания'), file('m2', GUIDE_MARKER_NAME, 'v')]).action).toBe('skip');
    expect(hasGuideMarker([folder('x', 'Прочее'), file('m2', GUIDE_MARKER_NAME, 'x')], VAULT_NAMES)).toBe(false);
  });

  it('хранилище убрано в корзину — справка сама не создаёт новое', () => {
    expect(plan([folder('v', 'Знания', undefined, true)])).toEqual({ action: 'skip', reason: 'vault-trashed' });
    expect(plan([folder(VAULT_NODE_ID, 'Архив', undefined, true)]))
      .toEqual({ action: 'skip', reason: 'vault-trashed' });
  });

  it('заметка пользователя с названием из справки не перезаписывается', () => {
    const result = written([folder('v', 'Знания'), folder('f', 'Работа', 'v'), file('mine', 'обзор.md', 'f')]);
    expect(result.skipped).toEqual(['overview']);
    expect(result.notes.map(({ key }) => key)).toEqual(keys.filter((key) => key !== 'overview'));
    // Заметка с тем же названием в корзине либо вне хранилища не мешает
    const free = written([folder('v', 'Знания'), file('gone', 'Обзор.md', 'v', true), file('out', 'Чаты.md')]);
    expect(free.skipped).toEqual([]);
  });

  it('папка пользователя с названием справки не сливается с ней', () => {
    const result = written([folder('v', 'Знания'), folder('mine', guide.folderName, 'v')]);
    expect(result.folders).toEqual([{ id: GUIDE_FOLDER_NODE_ID, name: `${guide.folderName} (2)`, parent: 'v' }]);
  });

  it('прерванное создание продолжается: дописывается только недостающее', () => {
    const [first, second] = guide.notes;
    const result = written([
      folder('v', 'Знания'), folder(GUIDE_FOLDER_NODE_ID, guide.folderName, 'v'),
      file(first.nodeId, `${first.title}.md`, GUIDE_FOLDER_NODE_ID),
      // Заметку справки успели удалить — заново она не создаётся
      file(second.nodeId, `${second.title}.md`, GUIDE_FOLDER_NODE_ID, true),
    ]);
    expect(result.folders).toEqual([]);
    expect(result.skipped).toEqual([first.key, second.key]);
    expect(result.notes.length).toBe(guide.notes.length - 2);
    expect(result.hasMarkerWrite).toBe(true);
  });

  it('папку справки удалили до отметки — ставится только отметка', () => {
    const result = written([folder('v', 'Знания'), folder(GUIDE_FOLDER_NODE_ID, guide.folderName, 'v', true)]);
    expect(result).toMatchObject({ folders: [], notes: [], hasMarkerWrite: true });
  });

  it('восстановление по кнопке: новая папка и недостающие заметки, существующие не трогаются', () => {
    const marker = file(GUIDE_MARKER_NODE_ID, GUIDE_MARKER_NAME, 'v');
    const [overview] = guide.notes;
    const deleted = written([
      folder('v', 'Знания'), marker, folder(GUIDE_FOLDER_NODE_ID, guide.folderName, 'v', true),
      file(overview.nodeId, `${overview.title}.md`, GUIDE_FOLDER_NODE_ID, true), file('mine', 'Чаты.md', 'v'),
    ], { mode: 'restore' });
    expect(deleted).toMatchObject({
      isFreshVault: false, folderId: 'random-1', hasMarkerWrite: false, skipped: ['chats'],
    });
    expect(deleted.folders).toEqual([{ id: 'random-1', name: guide.folderName, parent: 'v' }]);
    // Узлы новые: стёртый узел с постоянным идентификатором заново не появился бы
    expect(deleted.notes.every(({ nodeId }) => nodeId === undefined)).toBe(true);
    expect(deleted.notes.length).toBe(guide.notes.length - 1);

    // Папка на месте, удалена одна заметка — дописывается она одна, в ту же папку
    const partial = written([
      folder('v', 'Знания'), marker, folder(GUIDE_FOLDER_NODE_ID, 'Моя справка', 'v'),
      ...guide.notes.slice(1).map((note) => file(note.nodeId, `${note.title}.md`, GUIDE_FOLDER_NODE_ID)),
    ], { mode: 'restore' });
    expect(partial).toMatchObject({ folderId: GUIDE_FOLDER_NODE_ID, folders: [], hasMarkerWrite: false });
    expect(partial.notes.map(({ key }) => key)).toEqual(['overview']);

    // Всё на месте — делать нечего
    expect(plan([
      folder('v', 'Знания'), marker, folder(GUIDE_FOLDER_NODE_ID, guide.folderName, 'v'),
      ...guide.notes.map((note) => file(note.nodeId, `${note.title}.md`, GUIDE_FOLDER_NODE_ID)),
    ], { mode: 'restore' })).toEqual({ action: 'skip', reason: 'complete' });
  });

  it('восстановление без хранилища заводит его заново', () => {
    const result = written([folder('old', 'Знания', undefined, true)], { mode: 'restore' });
    expect(result.folders).toEqual([
      { id: 'random-1', name: 'Знания' }, { id: 'random-2', name: guide.folderName, parent: 'random-1' },
    ]);
    expect(result).toMatchObject({ isFreshVault: false, hasMarkerWrite: true });
    expect(result.notes.length).toBe(guide.notes.length);
  });

  it('отметка — JSON с версией, временем и языком', () => {
    expect(JSON.parse(buildGuideMarker('ru', 1760000000000))).toEqual({
      version: GUIDE_VERSION, createdAt: 1760000000000, lang: 'ru',
    });
    expect(GUIDE_MARKER_NAME.endsWith('.md')).toBe(false);
  });

  it('«Обзор» находится по постоянному узлу и по названию на любом языке', () => {
    const [overview] = guide.notes;
    expect(findGuideOverview([{ id: 'x', title: 'Сервер' }, { id: overview.nodeId, title: 'Переименовано' }])?.id)
      .toBe(overview.nodeId);
    expect(findGuideOverview([{ id: 'x', title: 'overview' }])?.id).toBe('x');
    expect(findGuideOverview([{ id: 'x', title: 'Сервер' }])).toBeUndefined();
  });
});
