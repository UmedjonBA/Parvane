import { describe, expect, it } from 'vitest';

import type { WireGroupInfo, WireMessageContent } from './wire';

import { isContentAllowedForMember } from './groups';
import {
  DEFAULT_GROUP_PERMISSIONS, fromBannedRights, ParvaneStore, shouldApplyGroupInfo, toAdminRights, toBannedRights,
  toWireAdminRights,
} from './store';

// Права групп (spec 003): провод ↔ нативные типы Telegram Web A и правило
// применения сведений по ревизии (conformance GROUP-1)

describe('shouldApplyGroupInfo (GROUP-1)', () => {
  it('применяет новее и равное, игнорирует старее, без локальной — всегда', () => {
    expect(shouldApplyGroupInfo(undefined, 1)).toBe(true);
    expect(shouldApplyGroupInfo(undefined, undefined)).toBe(true);
    expect(shouldApplyGroupInfo(3, 4)).toBe(true);
    expect(shouldApplyGroupInfo(4, 4)).toBe(true);
    expect(shouldApplyGroupInfo(5, 4)).toBe(false);
    expect(shouldApplyGroupInfo(5, undefined)).toBe(false);
  });

  it('стор не откатывает сведения группы устаревшим нотисом', () => {
    const store = new ParvaneStore();
    store.self = 'alice@local';
    const base: WireGroupInfo = {
      group_id: 'g', name: 'v2', kind: 'group', created_by: 'alice@local', members: [], version: 2,
    };
    expect(store.registerGroup(base)).toBe(true);
    expect(store.registerGroup({ ...base, name: 'v1', version: 1 })).toBe(false);
    expect(store.getGroupInfo('g')?.name).toBe('v2');
    expect(store.registerGroup({ ...base, name: 'v2-again' })).toBe(true);
    expect(store.registerGroup({ ...base, name: 'v3', version: 3 })).toBe(true);
    expect(store.getGroupVersion('g')).toBe(3);
    store.unregisterGroup('g');
    expect(store.getGroupVersion('g')).toBeUndefined();
  });
});

describe('права по умолчанию ↔ ApiChatBannedRights', () => {
  it('по умолчанию запрещены только закреп и смена информации', () => {
    expect(toBannedRights(undefined)).toEqual({ pinMessages: true, changeInfo: true });
    expect(toBannedRights({})).toEqual({ pinMessages: true, changeInfo: true });
  });

  it('выключенное право раскрывается на все связанные запреты tt', () => {
    const banned = toBannedRights({
      send_messages: false, send_media: false, send_stickers_gifs: false, send_polls: false, embed_links: false,
      invite_users: false, pin_messages: true, change_info: true,
    });
    expect(banned).toEqual({
      sendMessages: true,
      sendPlain: true,
      sendMedia: true,
      sendPhotos: true,
      sendVideos: true,
      sendRoundvideos: true,
      sendAudios: true,
      sendVoices: true,
      sendDocs: true,
      sendStickers: true,
      sendGifs: true,
      sendPolls: true,
      embedLinks: true,
      inviteUsers: true,
    });
  });

  it('обратное отображение: любой запрет внутри медиа выключает send_media', () => {
    expect(fromBannedRights({})).toEqual({ ...DEFAULT_GROUP_PERMISSIONS, pin_messages: true, change_info: true });
    expect(fromBannedRights({ sendPhotos: true }).send_media).toBe(false);
    expect(fromBannedRights({ sendMedia: true }).send_media).toBe(false);
    expect(fromBannedRights({ sendGifs: true }).send_stickers_gifs).toBe(false);
    expect(fromBannedRights({ sendPlain: true }).send_messages).toBe(false);
    // общий запрет tt без sendPlain — снят с экрана (см. комментарий в store.ts)
    expect(fromBannedRights({ sendMessages: true }).send_messages).toBe(true);
    expect(fromBannedRights({ pinMessages: true, changeInfo: true, inviteUsers: true })).toMatchObject({
      pin_messages: false, change_info: false, invite_users: false, send_messages: true,
    });
    // круг: перевод туда и обратно не теряет флагов
    const perms = { ...DEFAULT_GROUP_PERMISSIONS, send_media: false, send_polls: false };
    expect(fromBannedRights(toBannedRights(perms))).toEqual(perms);
  });

  it('ApiChat группы несёт defaultBannedRights, канал — нет', () => {
    const store = new ParvaneStore();
    store.self = 'alice@local';
    const info: WireGroupInfo = {
      group_id: 'g',
      name: 'G',
      kind: 'group',
      created_by: 'bob@local',
      members: [{ address: 'bob@local', role: 'owner' }, { address: 'alice@local', role: 'member' }],
      default_permissions: { send_messages: false },
      avatar: 'file-1',
      version: 1,
    };
    const chat = store.buildApiChatForGroup(info);
    expect(chat.defaultBannedRights).toMatchObject({ sendMessages: true, sendPlain: true, pinMessages: true });
    expect(chat.avatarPhotoId).toBe('file-1');
    expect(chat.isCreator).toBeUndefined();
    expect(chat.adminRights).toBeUndefined();
    const channel = store.buildApiChatForGroup({ ...info, group_id: 'c', kind: 'channel' });
    expect(channel.defaultBannedRights).toBeUndefined();
  });
});

describe('права админа ↔ ApiChatAdminRights', () => {
  it('отсутствующий набор — полный (legacy-админ)', () => {
    expect(toAdminRights(undefined)).toEqual({
      changeInfo: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, addAdmins: true,
    });
    expect(toAdminRights(undefined, true)).toMatchObject({ postMessages: true, editMessages: true });
  });

  it('частичный набор переносится флаг в флаг, лишние права tt отбрасываются', () => {
    const partial = {
      pin_messages: true, ban_users: false, change_info: false, delete_messages: false, invite_users: false,
      add_admins: false,
    };
    expect(toAdminRights(partial)).toEqual({ pinMessages: true });
    expect(toWireAdminRights({ pinMessages: true, anonymous: true, manageCall: true })).toEqual({
      change_info: false, delete_messages: false, ban_users: false, invite_users: false, pin_messages: true,
      add_admins: false,
    });
  });

  it('ApiChat своего админа несёт его права, владелец — isCreator', () => {
    const store = new ParvaneStore();
    store.self = 'bob@local';
    const info: WireGroupInfo = {
      group_id: 'g',
      name: 'G',
      kind: 'group',
      created_by: 'alice@local',
      members: [
        { address: 'alice@local', role: 'owner' },
        {
          address: 'bob@local',
          role: 'admin',
          admin_rights: {
            pin_messages: true, ban_users: false, change_info: false, delete_messages: false, invite_users: false,
            add_admins: false,
          },
        },
      ],
    };
    expect(store.buildApiChatForGroup(info).adminRights).toEqual({ pinMessages: true });
    store.self = 'alice@local';
    const owner = store.buildApiChatForGroup(info);
    expect(owner.isCreator).toBe(true);
    expect(owner.adminRights).toBeUndefined();
  });
});

describe('isContentAllowedForMember (FR-009, только на клиентах)', () => {
  const text = (extra: Partial<WireMessageContent> = {}): WireMessageContent => ({
    kind: 'text', text: 'hi', ...extra,
  });
  const of = (kind: string) => ({ kind } as WireMessageContent);

  it('по умолчанию всё разрешено', () => {
    const kinds = ['text', 'photo', 'video', 'file', 'voice', 'video_note', 'sticker', 'gif', 'poll', 'location'];
    for (const kind of kinds) {
      expect(isContentAllowedForMember(undefined, of(kind))).toBe(true);
    }
  });

  it('send_messages выключает всё, остальные — свой тип', () => {
    expect(isContentAllowedForMember({ send_messages: false }, text())).toBe(false);
    expect(isContentAllowedForMember({ send_media: false }, of('photo'))).toBe(false);
    expect(isContentAllowedForMember({ send_media: false }, of('voice'))).toBe(false);
    expect(isContentAllowedForMember({ send_media: false }, text())).toBe(true);
    expect(isContentAllowedForMember({ send_media: false }, of('sticker'))).toBe(true);
    expect(isContentAllowedForMember({ send_stickers_gifs: false }, of('gif'))).toBe(false);
    expect(isContentAllowedForMember({ send_stickers_gifs: false }, of('photo'))).toBe(true);
    expect(isContentAllowedForMember({ send_polls: false }, of('poll'))).toBe(false);
  });

  it('embed_links скрывает текст со ссылкой или превью, обычный текст оставляет', () => {
    expect(isContentAllowedForMember({ embed_links: false }, text())).toBe(true);
    expect(isContentAllowedForMember({ embed_links: false }, text({
      entities: [{ type: 'MessageEntityUrl', offset: 0, length: 5 }],
    }))).toBe(false);
    expect(isContentAllowedForMember({ embed_links: false }, text({
      webpage: { url: 'https://x' },
    }))).toBe(false);
    expect(isContentAllowedForMember({ embed_links: false }, text({
      entities: [{ type: 'MessageEntityBold', offset: 0, length: 2 }],
    }))).toBe(true);
  });
});
