import { describe, expect, it } from 'vitest';

import { buildMusicPlaylistContent } from './musicPlaylistContent';
import { createMusicSharedApi } from './musicSharedApi';

type Json = Record<string, unknown>;

function buildApi(replies: Record<string, Json>, calls: [string, Json][] = []) {
  return createMusicSharedApi({
    call: (method, request) => {
      calls.push([method, request]);
      return Promise.resolve(replies[method] || {});
    },
    resolveNick: (nick) => Promise.resolve(nick === 'bob' ? 'bob@music.example' : undefined),
    selfAddress: () => 'alice@music.example',
    displayName: (address) => address.split('@')[0],
    log: () => undefined,
  });
}

describe('MUSIC-3: общие плейлисты — ответы шарда к виду экрана', () => {
  it('плейлист, треки и участники; та же версия — «без изменений»', async () => {
    const playlist = {
      id: 'p1',
      name: 'Дорога',
      owner: 'alice@music.example',
      access: 'SHARED_ACCESS_SERVER',
      my_role: 'SHARED_ROLE_OWNER',
      member_count: 2, track_count: 1, version: '7', join_key: 'k1', invited: false,
    };
    const api = buildApi({
      'music.shared.get': {
        playlist,
        items: [{ id: 'i1', track_id: 't1', title: 'Берег', adder: 'bob@music.example', added_ms: '5' }],
        members: [
          { address: 'alice@music.example', role: 'SHARED_ROLE_OWNER' },
          { address: 'bob@music.example', role: 'SHARED_ROLE_LISTENER', invited: true, added_count: 1 },
        ],
      },
    });
    const details = await api.parvaneMusicSharedGet({ id: 'p1' });
    expect(details!.playlist).toMatchObject({
      access: 'server', myRole: 'owner', version: 7, joinKey: 'k1', memberCount: 2,
    });
    expect(details!.items[0]).toMatchObject({ trackId: 't1', adderName: 'bob', addedMs: 5 });
    expect(details!.members.map((member) => [member.role, member.isMe, member.isInvited])).toEqual([
      ['owner', true, false], ['listener', false, true],
    ]);
    const unchanged = buildApi({ 'music.shared.get': { unchanged: true } });
    expect(await unchanged.parvaneMusicSharedGet({ id: 'p1', ifVersion: 7 })).toBeUndefined();
  });

  it('позвать по нику: незнакомый ник — к серверу не ходим', async () => {
    const calls: [string, Json][] = [];
    const api = buildApi({ 'music.shared.member': { playlist: { id: 'p1' } } }, calls);
    expect(await api.parvaneMusicSharedMember({ id: 'p1', nick: '@nobody' })).toBe('unknown');
    expect(calls).toEqual([]);
    await api.parvaneMusicSharedMember({ id: 'p1', nick: '@Bob', role: 'listener' });
    expect(calls[0]).toEqual(['music.shared.member', {
      playlist_id: 'p1', address: 'bob@music.example', role: 'SHARED_ROLE_LISTENER', remove: false,
    }]);
  });

  it('карточка в чат несёт id и ключ вступления', () => {
    const content = buildMusicPlaylistContent({
      name: 'Дорога', server: 'music.example', tracks: [], sharedId: 'p1', joinKey: 'k1',
    });
    expect([content.shared_id, content.join_key]).toEqual(['p1', 'k1']);
    const plain = buildMusicPlaylistContent({ name: 'Дорога', server: 'music.example', tracks: [] });
    expect(plain.shared_id).toBeUndefined();
  });
});
