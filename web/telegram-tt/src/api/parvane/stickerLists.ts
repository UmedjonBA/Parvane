// «Избранные» и «Недавние» стикеры (A6 ревью 7 ноя 2026): замена серверных `messages.faveSticker`,
// `getRecentStickers`, `clearRecentStickers` Telegram. Хранятся на устройстве ссылками «набор + стикер»; сам стикер
// берётся из набора при показе (у своих наборов картинки — в архиве набора, не в ссылке)

import type { ApiSticker } from '../types';

export type StickerRef = { setId: string; stickerId: string };

// Как у Telegram: недавних — 20, избранных — 5 без Premium и 10 с ним (в Parvane свой пользователь — «premium»)
export const RECENT_STICKERS_LIMIT = 20;
export const FAVORITE_STICKERS_LIMIT = 10;

export function stickerRefOf(sticker: ApiSticker): StickerRef | undefined {
  const info = sticker.stickerSetInfo;
  const setId = info && 'id' in info ? info.id : undefined;
  return setId && sticker.id ? { setId, stickerId: sticker.id } : undefined;
}

const isSame = (a: StickerRef, b: StickerRef) => a.setId === b.setId && a.stickerId === b.stickerId;

/** Стикер — первым; повтор поднимается наверх; сверх предела уходят самые старые. */
export function pushStickerRef(list: StickerRef[], ref: StickerRef, limit: number) {
  return [ref, ...list.filter((item) => !isSame(item, ref))].slice(0, limit);
}

export function dropStickerRef(list: StickerRef[], ref: StickerRef) {
  return list.filter((item) => !isSame(item, ref));
}

export function parseStickerRefs(raw: unknown): StickerRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is StickerRef => (
    typeof item?.setId === 'string' && typeof item?.stickerId === 'string'
  ));
}

/**
 * «Динамический порядок наборов» (B12 ревью 7 ноя 2026, `messages.reorderStickerSets` Telegram на устройстве):
 * набор отправленного стикера поднимается первым.
 */
export function moveSetToTop(order: string[], setId: string) {
  return [setId, ...order.filter((id) => id !== setId)];
}

/** Наборы в сохранённом порядке; наборы вне порядка — после, в прежнем порядке. */
export function sortSetsByOrder<T extends { id: string }>(sets: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return sets
    .map((set, index) => ({ set, key: rank.has(set.id) ? rank.get(set.id)! : order.length + index }))
    .sort((a, b) => a.key - b.key)
    .map(({ set }) => set);
}

const VARIATION_SELECTOR = /\uFE0F/g;

function splitEmoji(value: string): string[] {
  const text = value.replace(VARIATION_SELECTOR, '');
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * «Предлагать стикеры» по эмодзи (B13, замена `messages.getStickers` Telegram): стикеры установленных наборов,
 * у которых среди эмодзи есть любой из запрошенных; без повторов, в порядке наборов.
 */
export function matchStickersForEmoji(stickers: ApiSticker[], emoji: string): ApiSticker[] {
  const wanted = new Set(splitEmoji(emoji));
  if (!wanted.size) return [];
  const seen = new Set<string>();
  return stickers.filter((sticker) => {
    if (!sticker.emoji || seen.has(sticker.id)) return false;
    if (!splitEmoji(sticker.emoji).some((item) => wanted.has(item))) return false;
    seen.add(sticker.id);
    return true;
  });
}

/** Ссылки → стикеры наборов (`loadSet` — содержимое набора по id; набора нет — его стикеры пропускаются). */
export async function resolveStickerRefs(
  refs: StickerRef[],
  loadSet: (setId: string) => Promise<ApiSticker[] | undefined>,
) {
  const sets = new Map<string, Promise<ApiSticker[] | undefined>>();
  const out: ApiSticker[] = [];
  for (const ref of refs) {
    if (!sets.has(ref.setId)) sets.set(ref.setId, loadSet(ref.setId).catch(() => undefined));
    const sticker = (await sets.get(ref.setId))?.find((candidate) => candidate.id === ref.stickerId);
    if (sticker) out.push(sticker);
  }
  return out;
}
