// spec 035 T039 (PV-020, FR-026): личные данные — контакты, своё имя и заметка контакта (CONTACT-1),
// блокировки, ссылки-приглашения — не лежат в localStorage открытым текстом; после перезапуска читаются из
// хранилища движка (`hydrate()`). Своего кэша сведений групп у web с T118 нет (журналы групп — в модели движка).
// Данные выдуманные.
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import { createLocalState } from './localState';
import { SecureE2eStorage, secureStorageInternals } from './secureStorage';

const SELF = 'pin-local@local';
const MARKERS = ['заметка-тест', 'Имя-маркер', 'blocked-marker@x', 'invite-marker', 'contact-marker@x'];

type PersonalModule = {
  flushPersonal?: () => Promise<void>;
  forgetPersonal?: (user: string) => void;
};

const values = new Map<string, string>();
const testLocalStorage = {
  get length() { return values.size; },
  key: (index: number) => Array.from(values.keys())[index],
  getItem: (key: string) => values.get(key) ?? null, // eslint-disable-line no-null/no-null
  setItem: (key: string, value: string) => {
    values.set(key, String(value));
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  clear: () => values.clear(),
};

function makeState() {
  return createLocalState({
    getStore: () => ({ self: SELF } as never),
    isAuthorized: () => true,
    selfId: () => SELF,
    sendUpdate: () => undefined,
    buildLocalContent: () => ({}),
    sendMessage: () => Promise.resolve(undefined),
  });
}

function localStorageDump() {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    out.push(`${key}=${localStorage.getItem(key)}`);
  }
  return out.join('\n');
}

describe('PV-020: личные данные не в localStorage', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', testLocalStorage);
    values.clear();
    await SecureE2eStorage.clear(SELF);
  });

  it('контакты, заметка, блокировка, приглашение — ни одного маркера в localStorage', async () => {
    const state = makeState();
    await state.hydrate();
    state.saveContacts(['contact-marker@x']);
    state.saveContactInfo({ 'bob@x': { name: 'Имя-маркер', note: 'заметка-тест' } as never });
    state.saveBlocked(['blocked-marker@x']);
    state.saveInviteLinks({ g1: { link: 'https://example.invalid/invite-marker', date: 1 } });
    const early = localStorageDump();
    MARKERS.forEach((marker) => expect(early).not.toContain(marker));
    // Модуль появился в spec 035; имя собрано, чтобы прежний код падал проверкой, а не разбором импорта
    const personalPath = './personal' + 'Store';
    const personal = await import(/* @vite-ignore */ personalPath).catch(() => undefined) as PersonalModule | undefined;
    expect(personal?.flushPersonal).toBeTypeOf('function');

    const dump = localStorageDump();
    MARKERS.forEach((marker) => expect(dump).not.toContain(marker));

    // Перезапуск: читается из хранилища движка
    await personal!.flushPersonal?.();
    personal!.forgetPersonal?.(SELF);
    (secureStorageInternals as unknown as { forgetAll?: () => void }).forgetAll?.();
    const again = makeState();
    await again.hydrate();
    expect(again.loadContacts()).toEqual(['contact-marker@x']);
    expect(again.loadContactInfo()['bob@x']).toMatchObject({ note: 'заметка-тест' });
    expect(again.isBlocked('blocked-marker@x')).toBe(true);
    expect(again.loadInviteLinks().g1?.link).toContain('invite-marker');
    const after = localStorageDump();
    MARKERS.forEach((marker) => expect(after).not.toContain(marker));
  });
});
