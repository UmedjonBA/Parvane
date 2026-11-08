import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isCurrentAvatarDeleted } from './profilePhoto';

// Этап 4 ревью 7 ноя 2026 (`local-workdirs/review-20261107/ui-web.md`, B и C): пункты Telegram, которым у Parvane
// нет опоры, скрыты; фоновые запросы tt — тихие заглушки. Сторож проверяет, что скрытое не вернулось
const SRC = path.resolve(process.cwd(), 'src');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

describe('B8: удалить своё фото профиля', () => {
  it('удаляется текущее фото — аватар снимается', () => {
    expect(isCurrentAvatarDeleted([{ id: 'f1' }], 'f1')).toBe(true);
    expect(isCurrentAvatarDeleted([{ id: 'old' }], 'f1')).toBe(false);
    expect(isCurrentAvatarDeleted([{ id: 'f1' }], undefined)).toBe(false);
  });

  it('провайдер шлёт пустой id в identity, а не «true» без действия', () => {
    const provider = read('api/parvane/provider.ts');
    expect(provider).toMatch(/async deleteProfilePhotos\(photos: ApiPhoto\[\]\)[\s\S]{0,300}file_id: ''/);
  });
});

describe('скрытые пункты Telegram', () => {
  it('B4: фишки «Публичные посты» нет', () => {
    expect(read('components/middle/search/MiddleSearch.tsx')).not.toContain('{renderTypeTag(\'channels\')}');
  });

  it('B7: галочки «закрепить для обоих / уведомить всех» нет', () => {
    expect(read('components/common/PinMessageModal.tsx')).toContain('const canPinForAll = false;');
  });

  it('B9, B11: главная вкладка профиля и «Поделиться папкой» скрыты', () => {
    expect(read('global/selectors/peers.ts')).toContain('if (IS_PARVANE_MAIN_TAB_DISABLED) return false;');
    expect(read('global/selectors/chats.ts')).toContain('if (IS_PARVANE_FOLDER_LINKS_DISABLED) return false;');
  });

  it('B10: «Подписывать сообщения» скрыто', () => {
    expect(read('components/right/management/ManageChatAdministrators.tsx'))
      .toContain('const canToggleSignatures = false;');
  });

  it('C2: «Постепенный вывод текста» скрыт', () => {
    expect(read('components/left/settings/SettingsPerformance.tsx')).not.toContain('key: \'textStreaming\'');
  });

  it('C3: галочки транспорта MTProto скрыты', () => {
    expect(read('components/left/settings/SettingsExperimental.tsx'))
      .toContain('const IS_MTPROTO_OPTIONS_SHOWN = false;');
  });

  it('C4: код-пароль Telegram Web A и Ctrl+Shift+L отключены', () => {
    expect(read('global/selectors/settings.ts')).toContain('if (IS_PARVANE_TT_PASSCODE_DISABLED) return false;');
  });
});

describe('подключено', () => {
  it('B1: дата подсказки доходит до поиска', () => {
    expect(read('global/actions/api/globalSearch.ts'))
      .toMatch(/query, resultsByType, chatId, minDate, maxDate,\n {2}\} = selectTabState/);
  });

  it('B12: «Динамический порядок наборов» поднимает набор', () => {
    expect(read('global/actions/apiUpdaters/symbols.ts')).toContain('case \'updateMoveStickerSetToTop\'');
    expect(read('api/parvane/provider.ts'))
      .toContain('sendUpdate({ \'@type\': \'updateMoveStickerSetToTop\', id: ref.setId });');
  });

  it('B13: подсказка стикеров по эмодзи реализована', () => {
    expect(read('api/parvane/provider.ts')).toContain('async fetchStickersForEmoji({ emoji }');
  });

  it('B15: строки «Unblock» и пустого списка контактов — из словаря', () => {
    expect(read('components/left/settings/SettingsPrivacyBlockedUsers.tsx')).not.toContain('title: \'Unblock\'');
    expect(read('components/left/main/ContactList.tsx')).not.toContain('\'Contact list is empty.\'');
    const pack = read('api/parvane/oldLangPack.ts');
    expect(pack.match(/ParvaneContactsEmpty:/g)?.length).toBe(2);
    expect(pack.match(/ParvanePrivacySaveFailed:/g)?.length).toBe(2);
  });

  it('B16: ник копируется с уведомлением из словаря', () => {
    const extra = read('components/common/profile/ChatExtra.tsx');
    expect(extra).toContain('const IS_COLLECTIBLE_USERNAMES_SUPPORTED = false;');
    expect(extra).not.toContain('was copied');
  });

  it('фоновые вызовы tt не пишут api-missing', () => {
    const provider = read('api/parvane/provider.ts');
    ['fetchMessageReactions', 'fetchMessageViews', 'fetchFactChecks', 'fetchSavedReactionTags', 'readAllReactions',
      'readAllPollVotes', 'sendEmojiInteraction', 'sendWatchingEmojiInteraction'].forEach((name) => {
      expect(provider).toContain(`'${name}'`);
    });
    expect(provider).toContain('...PARVANE_SILENT_STUBS,');
  });
});
