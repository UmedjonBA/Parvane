import { createPersonalSync, type PersonalDeps, type PersonalSpec } from './personalSync';

// Parvane (spec 039, этап C): плейлисты «Музыки» — личный контейнер домена `parvane.music.v1`, сервер видит
// только шифртекст. Жизненный цикл общий с «Планом» и «Здоровьем» — `personalSync.ts`. Сведение, порядок
// треков и действия пользователя (создать, добавить, переставить) — в движке (MUSIC-2)
const MUSIC_SPEC: PersonalSpec = {
  kind: 'music',
  domain: 'parvane.music.v1',
  label: 'плейлисты',
  outboxRecord: 'music-outbox',
  pendingRecord: 'music-pending',
  // Правки плейлистов идут по порядку: перестановки опираются на места, выданные предыдущими
  coalesce: (changes) => changes,
};

export type MusicPlaylistAction = Record<string, unknown> & {
  action: 'create' | 'rename' | 'delete' | 'add' | 'remove' | 'move';
};

export function createMusicPlaylistsSync(deps: PersonalDeps) {
  return {
    ...createPersonalSync(deps, MUSIC_SPEC),
    /** Плейлисты для экранов; движок не поднят — `undefined`. */
    viewJson: () => deps.client()?.musicStateJson(),
    /** Действие пользователя → изменения движка `{changes, id?, skipped?}`; движок не поднят — `undefined`. */
    compose: (action: MusicPlaylistAction, nowMs: number) => {
      const json = deps.client()?.musicCompose(action, nowMs);
      return json ? JSON.parse(json) as { changes: unknown[]; id?: string; skipped?: number } : undefined;
    },
  };
}

export type MusicPlaylistsSync = ReturnType<typeof createMusicPlaylistsSync>;
