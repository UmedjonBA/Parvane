import { describe, expect, it } from 'vitest';

import type { ApiChatFolder } from '../api/types';

import {
  ALL_FOLDER_COLOR, buildFolderColors, buildFolderColorsById, CHOSEN_FOLDER_COLORS, FALLBACK_FOLDER_COLORS,
  pickChatTagFolderIds,
} from './folderColors';

const folder = (id: number, color?: number) => ({ id, color, title: { text: `Папка ${id}` } }) as ApiChatFolder;

describe('цвета папок', () => {
  it('«Все» — акцент, выбранный цвет — из набора Telegram, остальные по порядку', () => {
    expect(buildFolderColors([folder(0), folder(5), folder(6, 3), folder(7)])).toEqual([
      ALL_FOLDER_COLOR, FALLBACK_FOLDER_COLORS[0], CHOSEN_FOLDER_COLORS[3], FALLBACK_FOLDER_COLORS[1],
    ]);
  });

  it('цвет 0 (красный) — выбранный, а не «без цвета»; -1 — без цвета', () => {
    expect(buildFolderColors([folder(5, 0), folder(6, -1)])).toEqual([
      CHOSEN_FOLDER_COLORS[0], FALLBACK_FOLDER_COLORS[0],
    ]);
  });

  it('метка чата и чип папки получают один цвет', () => {
    const byId = { 5: folder(5), 6: folder(6, 3), 7: folder(7) };
    const orderedIds = [0, 7, 6, 5];
    const chips = buildFolderColors(orderedIds.map((id) => (id ? byId[id as 5] : folder(0))));
    const tags = buildFolderColorsById(orderedIds, byId);
    orderedIds.forEach((id, index) => expect(tags[id]).toBe(chips[index]));
  });
});

describe('метки папок в строке чата', () => {
  const ORDERED = [0, 7, 6, 5];

  it('папки чата идут в порядке чипов, без «Всех»', () => {
    expect(pickChatTagFolderIds(ORDERED, [0, 5, 7])).toEqual([7, 5]);
  });

  it('внутри папки её собственной метки нет', () => {
    expect(pickChatTagFolderIds(ORDERED, [5, 7], 7)).toEqual([5]);
  });

  it('чат без папок — без меток', () => {
    expect(pickChatTagFolderIds(ORDERED, undefined)).toEqual([]);
    expect(pickChatTagFolderIds(ORDERED, [0])).toEqual([]);
    expect(pickChatTagFolderIds(undefined, [5])).toEqual([]);
  });
});
