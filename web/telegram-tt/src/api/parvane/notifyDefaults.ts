// Умолчания уведомлений по типам чатов (A1 ревью 7 ноя 2026). Сервер Telegram отдаёт по умолчанию «со звуком и с
// текстом сообщения»; Parvane хранит умолчания у себя (localState + журнал состояния, вид `notify`) и при первом
// запуске там пусто — без этих значений tt считал чат беззвучным (`!hasSound`) и прятал текст (`!shouldShowPreviews`)

import type { ApiPeerNotifySettings } from '../types';

export const NOTIFY_PEER_TYPES = ['users', 'groups', 'channels'] as const;

const BASE_DEFAULTS: ApiPeerNotifySettings = { hasSound: true, shouldShowPreviews: true };

type StoredDefaults = Record<string, Record<string, unknown> | undefined>;

/** Ответ `fetchNotifyDefaultSettings`: сохранённое поверх умолчаний Telegram. */
export function withNotifyDefaults(stored: StoredDefaults) {
  return Object.fromEntries(NOTIFY_PEER_TYPES.map((type) => [
    type, { ...BASE_DEFAULTS, ...dropUndefined(stored[type]) },
  ])) as Record<typeof NOTIFY_PEER_TYPES[number], ApiPeerNotifySettings>;
}

/** Правка умолчаний типа: прежние поля (в том числе `hasSound`) сохраняются, меняются только переданные. */
export function mergeNotifyDefault(
  previous: Record<string, unknown> | undefined,
  patch: { mutedUntil?: number; shouldShowPreviews?: boolean; hasSound?: boolean },
) {
  return { ...previous, ...dropUndefined(patch) };
}

/** `hasSound` ↔ поле `sound` `state.v1.NotifySettings`: «none» — без звука, «default» — звук по умолчанию. */
export const NOTIFY_SOUND_NONE = 'none';
export const NOTIFY_SOUND_DEFAULT = 'default';

export function soundToState(hasSound: unknown) {
  if (typeof hasSound !== 'boolean') return undefined;
  return hasSound ? NOTIFY_SOUND_DEFAULT : NOTIFY_SOUND_NONE;
}

export function soundFromState(sound: string | undefined) {
  if (sound === undefined || sound === '') return undefined;
  return sound !== NOTIFY_SOUND_NONE;
}

function dropUndefined<T extends Record<string, unknown>>(value: T | undefined) {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
