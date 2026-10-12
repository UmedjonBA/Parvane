import type { ApiChatFolder } from '../api/types';

import { ALL_FOLDER_ID } from '../config';

// Parvane: цвета папок — тона цветовой схемы. Первый набор отвечает семи цветам Telegram, которые выбирают в
// настройках папки (красный, оранжевый, фиолетовый, зелёный, бирюзовый, синий, розовый); второй — порядок
// для папок без выбранного цвета. Один расчёт на чипы папок над списком и на метки папок в строках чатов —
// метка обязана быть того же цвета, что чип
export const CHOSEN_FOLDER_COLORS = [
  'var(--pv-red)', 'var(--pv-orange)', 'var(--pv-purple)', 'var(--pv-green)', 'var(--pv-aqua)', 'var(--pv-blue)',
  'var(--pv-purple)',
];
export const FALLBACK_FOLDER_COLORS = [
  'var(--pv-blue)', 'var(--pv-orange)', 'var(--pv-purple)', 'var(--pv-aqua)', 'var(--pv-green)', 'var(--pv-red)',
];
export const ALL_FOLDER_COLOR = 'var(--pv-accent)';

// Цвета в порядке папок: выбранный в настройках папки, иначе по порядку из набора схемы; «Все» — яркий акцент
export function buildFolderColors(folders: Pick<ApiChatFolder, 'id' | 'color'>[]) {
  let fallbackIndex = 0;
  return folders.map((folder) => {
    if (folder.id === ALL_FOLDER_ID) return ALL_FOLDER_COLOR;
    const { color } = folder;
    if (color !== undefined && color >= 0) return CHOSEN_FOLDER_COLORS[color % CHOSEN_FOLDER_COLORS.length];
    return FALLBACK_FOLDER_COLORS[fallbackIndex++ % FALLBACK_FOLDER_COLORS.length];
  });
}

export function buildFolderColorsById(
  orderedFolderIds: number[] | undefined, chatFoldersById: Record<number, ApiChatFolder> | undefined,
) {
  const ids = orderedFolderIds || [];
  const colors = buildFolderColors(ids.map((id) => ({ id, color: chatFoldersById?.[id]?.color })));
  const byId: Record<number, string> = {};
  ids.forEach((id, index) => {
    byId[id] = colors[index];
  });
  return byId;
}

// Метки папок в строке чата: папки чата в порядке чипов, без «Всех» и без папки, список которой открыт
export function pickChatTagFolderIds(
  orderedFolderIds: number[] | undefined, chatFolderIds: number[] | undefined, activeFolderId?: number,
) {
  if (!orderedFolderIds || !chatFolderIds?.length) return [];
  const own = new Set(chatFolderIds);
  return orderedFolderIds.filter((id) => own.has(id) && id !== ALL_FOLDER_ID && id !== activeFolderId);
}
