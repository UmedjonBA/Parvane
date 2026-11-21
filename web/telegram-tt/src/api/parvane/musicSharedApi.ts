// Parvane (spec 041, MUSIC-3): общие плейлисты «Музыки» — методы `music.shared.*` шарда music. Плейлист хранится на
// сервере открытым текстом (музыка не E2E), права проверяет сервер; здесь — только приведение ответов к одному виду.
// Личные плейлисты — контейнер `music.v1` (`musicApi.ts`, MUSIC-2)

type Json = Record<string, unknown>;

type Deps = {
  call: (method: string, request: Json) => Promise<Json>;
  // Адрес по нику (`identity`): «Позвать по нику» зовёт только существующих пользователей
  resolveNick: (nick: string) => Promise<string | undefined>;
  selfAddress: () => string;
  displayName: (address: string) => string;
  log: (message: string) => void;
};

export type MusicSharedAccess = 'members' | 'server';
export type MusicSharedRole = 'owner' | 'editor' | 'listener' | 'none';

export type MusicSharedPlaylist = {
  id: string;
  name: string;
  owner: string;
  access: MusicSharedAccess;
  myRole: MusicSharedRole;
  memberCount: number;
  trackCount: number;
  durationSecs: number;
  createdMs: number;
  updatedMs: number;
  version: number;
  // Ключ вступления для карточки в чате — только у владельца
  joinKey?: string;
  // Позван и ещё не открывал
  isInvited: boolean;
};

export type MusicSharedItem = {
  id: string;
  trackId: string;
  server: string;
  title: string;
  artist: string;
  durationSecs: number;
  adder: string;
  adderName: string;
  addedMs: number;
};

export type MusicSharedMember = {
  address: string;
  name: string;
  role: MusicSharedRole;
  isInvited: boolean;
  addedCount: number;
  joinedMs: number;
  isMe: boolean;
};

export type MusicSharedDetails = {
  playlist: MusicSharedPlaylist;
  items: MusicSharedItem[];
  members: MusicSharedMember[];
};

export type MusicSharedTrackInput = {
  trackId: string;
  server?: string;
  title: string;
  artist: string;
  durationSecs: number;
};

const ROLES: Record<string, MusicSharedRole> = {
  SHARED_ROLE_OWNER: 'owner',
  SHARED_ROLE_EDITOR: 'editor',
  SHARED_ROLE_LISTENER: 'listener',
};
const ROLE_NAMES: Record<Exclude<MusicSharedRole, 'none' | 'owner'>, string> = {
  editor: 'SHARED_ROLE_EDITOR',
  listener: 'SHARED_ROLE_LISTENER',
};
const ACCESS_NAMES: Record<MusicSharedAccess, string> = {
  members: 'SHARED_ACCESS_MEMBERS',
  server: 'SHARED_ACCESS_SERVER',
};

function field(source: Json, name: string): unknown {
  if (name in source) return source[name];
  return source[name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())];
}

const text = (source: Json, name: string) => {
  const value = field(source, name);
  return typeof value === 'string' ? value : '';
};
const count = (source: Json, name: string) => Number(field(source, name)) || 0;
const list = (source: Json, name: string) => {
  const value = field(source, name);
  return Array.isArray(value) ? value as Json[] : [];
};
const object = (source: Json, name: string) => {
  const value = field(source, name);
  return value && typeof value === 'object' ? value as Json : undefined;
};

function toPlaylist(raw: Json): MusicSharedPlaylist {
  return {
    id: text(raw, 'id'),
    name: text(raw, 'name'),
    owner: text(raw, 'owner'),
    access: text(raw, 'access') === ACCESS_NAMES.server ? 'server' : 'members',
    myRole: ROLES[text(raw, 'my_role')] || 'none',
    memberCount: count(raw, 'member_count'),
    trackCount: count(raw, 'track_count'),
    durationSecs: count(raw, 'duration_secs'),
    createdMs: count(raw, 'created_ms'),
    updatedMs: count(raw, 'updated_ms'),
    version: count(raw, 'version'),
    joinKey: text(raw, 'join_key') || undefined,
    isInvited: Boolean(field(raw, 'invited')),
  };
}

function toTrackInput(track: MusicSharedTrackInput): Json {
  return {
    track_id: track.trackId,
    server: track.server || '',
    title: track.title,
    artist: track.artist,
    duration_secs: track.durationSecs,
  };
}

export function createMusicSharedApi(deps: Deps) {
  const playlistOf = (reply: Json) => {
    const raw = object(reply, 'playlist');
    return raw ? toPlaylist(raw) : undefined;
  };

  return {
    /** Общие плейлисты, где я участник; `isServerWide` — ещё и открытые всем на сервере. */
    async parvaneMusicSharedList({ isServerWide }: { isServerWide?: boolean } = {}) {
      const reply = await deps.call('music.shared.list', { server_wide: Boolean(isServerWide) });
      return list(reply, 'playlists').map(toPlaylist);
    },

    /** Плейлист с треками и участниками; та же версия — `undefined` (ничего не изменилось). */
    async parvaneMusicSharedGet({ id, ifVersion = 0 }: { id: string; ifVersion?: number }) {
      const reply = await deps.call('music.shared.get', { playlist_id: id, if_version: ifVersion });
      if (field(reply, 'unchanged')) return undefined;
      const playlist = playlistOf(reply);
      if (!playlist) return undefined;
      const self = deps.selfAddress();
      const details: MusicSharedDetails = {
        playlist,
        items: list(reply, 'items').map((raw) => ({
          id: text(raw, 'id'),
          trackId: text(raw, 'track_id'),
          server: text(raw, 'server'),
          title: text(raw, 'title'),
          artist: text(raw, 'artist'),
          durationSecs: count(raw, 'duration_secs'),
          adder: text(raw, 'adder'),
          adderName: deps.displayName(text(raw, 'adder')),
          addedMs: count(raw, 'added_ms'),
        })),
        members: list(reply, 'members').map((raw) => ({
          address: text(raw, 'address'),
          name: deps.displayName(text(raw, 'address')),
          role: ROLES[text(raw, 'role')] || 'none',
          isInvited: Boolean(field(raw, 'invited')),
          addedCount: count(raw, 'added_count'),
          joinedMs: count(raw, 'joined_ms'),
          isMe: text(raw, 'address') === self,
        })),
      };
      return details;
    },

    async parvaneMusicSharedCreate({ name, access, tracks = [] }: {
      name: string; access: MusicSharedAccess; tracks?: MusicSharedTrackInput[];
    }) {
      const reply = await deps.call('music.shared.create', {
        name, access: ACCESS_NAMES[access], items: tracks.map(toTrackInput),
      });
      return playlistOf(reply);
    },

    /** Владелец: название, доступ, ключ вступления для чата. */
    async parvaneMusicSharedEdit({
      id, name, access, isIssueJoinKey, isRotateJoinKey,
    }: {
      id: string; name?: string; access?: MusicSharedAccess; isIssueJoinKey?: boolean; isRotateJoinKey?: boolean;
    }) {
      const reply = await deps.call('music.shared.edit', {
        playlist_id: id,
        name: name || '',
        access: access ? ACCESS_NAMES[access] : undefined,
        issue_join_key: Boolean(isIssueJoinKey),
        rotate_join_key: Boolean(isRotateJoinKey),
      });
      return playlistOf(reply);
    },

    async parvaneMusicSharedDelete({ id }: { id: string }) {
      await deps.call('music.shared.delete', { playlist_id: id });
      return true;
    },

    /** Добавить в конец (повторы пропускаются), убрать, переставить перед `moveBeforeId` (пусто — в конец). */
    async parvaneMusicSharedItems({
      id, add = [], remove = [], moveId, moveBeforeId,
    }: {
      id: string; add?: MusicSharedTrackInput[]; remove?: string[]; moveId?: string; moveBeforeId?: string;
    }) {
      const reply = await deps.call('music.shared.items', {
        playlist_id: id,
        add: add.map(toTrackInput),
        remove,
        move_id: moveId || '',
        move_before_id: moveBeforeId || '',
      });
      return { playlist: playlistOf(reply), skipped: count(reply, 'skipped') };
    },

    /** Владелец: позвать по нику (роль «добавляет» / «слушает»), сменить роль либо убрать.
     * Ник не найден — `'unknown'`. */
    async parvaneMusicSharedMember({
      id, nick, address, role = 'editor', isRemove,
    }: {
      id: string;
      nick?: string;
      address?: string;
      role?: Exclude<MusicSharedRole, 'none' | 'owner'>;
      isRemove?: boolean;
    }) {
      const target = address || await deps.resolveNick((nick || '').trim().replace(/^@/, '').toLowerCase());
      if (!target) return 'unknown' as const;
      const reply = await deps.call('music.shared.member', {
        playlist_id: id, address: target, role: ROLE_NAMES[role], remove: Boolean(isRemove),
      });
      return playlistOf(reply);
    },

    async parvaneMusicSharedLeave({ id }: { id: string }) {
      await deps.call('music.shared.leave', { playlist_id: id });
      return true;
    },

    /** Вступить по ключу из карточки плейлиста в чате (роль «добавляет»). */
    async parvaneMusicSharedJoin({ id, joinKey }: { id: string; joinKey: string }) {
      const reply = await deps.call('music.shared.join', { playlist_id: id, join_key: joinKey });
      return playlistOf(reply);
    },
  };
}
