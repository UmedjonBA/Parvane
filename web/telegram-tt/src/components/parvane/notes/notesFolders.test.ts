import { describe, expect, it } from 'vitest';

import type { FolderNode } from './notesFolders';

import {
  buildNoteGroups, checkFolderName, DAILY_GROUP_KEY, folderCaption, folderContents, isInFolder, listNoteFolders,
} from './notesFolders';

const folder = (id: string, name: string, parent?: string, trashed = false): FolderNode => ({
  id, kind: 'folder', name, parent, trashed,
});
const file = (id: string, name: string, parent?: string, trashed = false): FolderNode => ({
  id, kind: 'file', name, parent, trashed,
});
const note = (title: string, folderPath = '', isDaily = false) => ({ title, folder: folderPath, isDaily });

const TREE = [
  folder('v', 'Знания'),
  folder('work', 'Работа', 'v'),
  folder('deep', 'Сервер', 'work'),
  folder('empty', 'Идеи', 'v'),
  folder('gone', 'Старое', 'v', true),
  folder('out', 'Фото'),
  file('n1', 'План.md', 'work'),
  file('n2', 'Железо.md', 'deep'),
  file('n3', 'Удалено.md', 'work', true),
  file('img', 'схема.png', 'deep'),
  file('n4', 'Свободная.md', 'v'),
];

describe('папки заметок', () => {
  it('перечень: папки хранилища с путями, вложенные тоже, без корзины и без чужих', () => {
    expect(listNoteFolders(TREE, 'v')).toEqual([
      { id: 'empty', path: 'Идеи', name: 'Идеи' },
      { id: 'work', path: 'Работа', name: 'Работа' },
      { id: 'deep', path: 'Работа/Сервер', name: 'Сервер' },
    ]);
    expect(listNoteFolders(TREE, 'missing')).toEqual([]);
  });

  it('подпись вложенной папки и принадлежность заметки папке', () => {
    expect(folderCaption('Работа/Сервер')).toBe('Работа / Сервер');
    expect(folderCaption('Идеи')).toBe('Идеи');
    expect(isInFolder('Работа/Сервер', 'Работа')).toBe(true);
    expect(isInFolder('Работа', 'Работа')).toBe(true);
    expect(isInFolder('Работа 2', 'Работа')).toBe(false);
  });

  it('название папки: не пустое, без запрещённых знаков, не занято', () => {
    expect(checkFolderName('Проекты', ['Работа'])).toBeUndefined();
    expect(checkFolderName('', [])).toBe('bad-name');
    expect(checkFolderName('  ', [])).toBe('bad-name');
    expect(checkFolderName(' Проекты', [])).toBe('bad-name');
    expect(checkFolderName('а/б', [])).toBe('bad-name');
    expect(checkFolderName('..', [])).toBe('bad-name');
    expect(checkFolderName('работа', ['Работа'])).toBe('taken');
  });

  it('содержимое папки: живые заметки и прочие файлы на любой глубине', () => {
    const work = folderContents(TREE, 'work');
    expect(work.notes.map(({ id }) => id)).toEqual(['n1', 'n2']);
    expect(work.others.map(({ id }) => id)).toEqual(['img']);
    expect(folderContents(TREE, 'empty')).toEqual({ notes: [], others: [] });
    // Вложенная папка, стоящая в дереве раньше родителя, тоже находится
    const reversed = [...TREE].reverse();
    expect(folderContents(reversed, 'work').notes.map(({ id }) => id).sort()).toEqual(['n1', 'n2']);
  });

  it('группы списка: «Без папки», папки по алфавиту с пустыми, заметки дня в конце', () => {
    const folders = [...listNoteFolders(TREE, 'v'), { id: 'd', path: 'Ежедневные', name: 'Ежедневные' }];
    const notes = [
      note('План', 'Работа'), note('Железо', 'Работа/Сервер'), note('Свободная'),
      note('2026-10-11', 'Ежедневные', true), note('2026-10-12', 'Ежедневные', true),
    ];
    const groups = buildNoteGroups({
      notes, folders, dailyFolders: ['Ежедневные', 'Daily'], dailyShown: 1,
    });
    expect(groups.map(({ key, folderId, items }) => [key, folderId, items.length])).toEqual([
      ['', undefined, 1], ['Идеи', 'empty', 0], ['Работа', 'work', 1], ['Работа/Сервер', 'deep', 1],
      [DAILY_GROUP_KEY, 'd', 1],
    ]);
    const daily = groups[groups.length - 1];
    expect(daily).toMatchObject({ isDaily: true, folder: 'Ежедневные', hidden: 1 });
    expect(daily.items[0].title).toBe('2026-10-12');
  });

  it('группы списка: «Без папки» видна пустой, пока есть папки; без папок и заметок групп нет', () => {
    const folders = listNoteFolders(TREE, 'v');
    expect(buildNoteGroups({ notes: [], folders, dailyFolders: [] }).map(({ key }) => key))
      .toEqual(['', 'Идеи', 'Работа', 'Работа/Сервер']);
    expect(buildNoteGroups({ notes: [], folders: [], dailyFolders: [] })).toEqual([]);
    // Пустая папка заметок дня отдельной строкой не показывается
    const daily = [{ id: 'd', path: 'Daily', name: 'Daily' }];
    expect(buildNoteGroups({ notes: [], folders: daily, dailyFolders: ['Daily'] }).map(({ key }) => key)).toEqual(['']);
  });

  it('группы списка при поиске: только найденное, заметки дня все', () => {
    const groups = buildNoteGroups({
      notes: [note('Железо', 'Работа/Сервер'), note('2026-10-11', 'Daily', true), note('2026-10-12', 'Daily', true)],
      folders: listNoteFolders(TREE, 'v'),
      dailyFolders: ['Daily'],
      isSearch: true,
      dailyShown: 1,
    });
    expect(groups.map(({ key, items, hidden }) => [key, items.length, hidden])).toEqual([
      ['Работа/Сервер', 1, 0], [DAILY_GROUP_KEY, 2, 0],
    ]);
  });

  it('заметка с названием-датой вне заметок дня остаётся в своей папке', () => {
    const groups = buildNoteGroups({ notes: [note('2026-10-12', 'Работа')], folders: [], dailyFolders: [] });
    expect(groups.map(({ key, isDaily }) => [key, isDaily])).toEqual([['Работа', false]]);
  });
});
