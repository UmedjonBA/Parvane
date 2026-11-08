import { readFileSync } from 'fs';
import { join } from 'path';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { LocalStickerPack } from './localState';

import { createLocalState } from './localState';
import { SecureE2eStorage } from './secureStorage';

// C7-3 (ревью 7 ноя 2026): зеркало вида `packs` журнала личного состояния (наборы стикеров PACK-3, свои GIF GIF-1)
// несёт ключ, nonce и capability блоба. В localStorage — только без них; секреты — в шифрованном хранилище
// (SecureE2eStorage, правило A0028-7), прежние значения переносятся и стираются. Адреса и имена — выдуманные

const SELF = 'packs-owner@local';
const KEY = `parvane:stickerpacks:${SELF}`;
const SECRET_FIELDS = ['"key"', '"nonce"', '"capability"'];

function makeLocalState() {
  return createLocalState({
    getStore: () => ({ self: SELF } as never),
    isAuthorized: () => true,
    selfId: () => SELF,
    sendUpdate: () => undefined,
    buildLocalContent: () => ({}),
    sendMessage: () => Promise.resolve(undefined),
  });
}

const GIF: LocalStickerPack = {
  set_id: `g:${'ab'.repeat(32)}`,
  ref: {
    file_id: 'file-gif-1', name: 'animation', key: 'S0VZLWdpZg==', nonce: 'Tk9OQ0U=', capability: 'Q0FQLWdpZg==',
    blob_domain: 'local',
  },
  added_ms: '1000',
};
const PACK: LocalStickerPack = {
  set_id: 'p:pack-1',
  ref: { file_id: 'file-pack-1', name: 'Котики', count: 3, key: 'S0VZLXBhY2s=', nonce: 'Tk9OQ0Uy' },
  emoji: true,
};

const values = new Map<string, string>();
const testLocalStorage = {
  get length() { return values.size; },
  key: (index: number) => Array.from(values.keys())[index],
  getItem: (key: string) => values.get(key),
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  clear: () => values.clear(),
};

function expectNoSecrets() {
  const raw = localStorage.getItem(KEY) || '';
  SECRET_FIELDS.forEach((field) => expect(raw).not.toContain(field));
}

describe('C7-3: ключи наборов стикеров и GIF — не в localStorage', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', testLocalStorage);
    values.clear();
    await SecureE2eStorage.clear(SELF);
  });

  it('запись: в localStorage без ключей, чтение — целиком, и в новой сессии после hydrate', async () => {
    const state = makeLocalState();
    await state.hydrate();
    state.saveStickerPacks([GIF, PACK]);
    expectNoSecrets();
    // spec 035 T046: зеркало вида — тоже не в localStorage, а в хранилище движка
    expect(localStorage.getItem(KEY)).toBeFalsy();
    expect(state.loadStickerPacks()).toEqual([GIF, PACK]);
    await state.flushPackSecrets();

    const fresh = makeLocalState();
    await fresh.hydrate();
    expect(fresh.loadStickerPacks()).toEqual([GIF, PACK]);
  });

  it('прежние значения с ключами переносятся в шифрованное хранилище и стираются из localStorage', async () => {
    localStorage.setItem(KEY, JSON.stringify([GIF, PACK]));
    const state = makeLocalState();
    await state.hydrate();
    expectNoSecrets();
    expect(state.loadStickerPacks()).toEqual([GIF, PACK]);
    const fresh = makeLocalState();
    await fresh.hydrate();
    expect(fresh.loadStickerPacks()).toEqual([GIF, PACK]);
  });

  it('запись до hydrate не теряет ключей и не оставляет их в localStorage', async () => {
    const before = makeLocalState();
    await before.hydrate();
    before.saveStickerPacks([PACK]);
    await before.flushPackSecrets();

    const state = makeLocalState();
    // Список до загрузки секретов: у прежнего набора ключей ещё нет — сохранённые не затираются
    state.saveStickerPacks([...state.loadStickerPacks(), GIF]);
    expectNoSecrets();
    await state.hydrate();
    expect(state.loadStickerPacks()).toEqual([PACK, GIF]);
  });

  it('снятый набор уносит и свои ключи', async () => {
    const state = makeLocalState();
    await state.hydrate();
    state.saveStickerPacks([GIF, PACK]);
    state.saveStickerPacks([PACK]);
    await state.flushPackSecrets();
    const storage = await SecureE2eStorage.open(SELF);
    const secrets = await storage.loadRecord<Record<string, unknown>>('packsecrets');
    expect(Object.keys(secrets || {})).toEqual([PACK.set_id]);
  });
});

describe('C7-3: журнал состояния не берёт снимок до загрузки ключей', () => {
  it('attach ждёт hydrate() до первой сверки с журналом', () => {
    const source = readFileSync(join(__dirname, 'v2', 'stateJournal.ts'), 'utf8');
    const attach = source.slice(source.indexOf('async function attach('));
    const hydrate = attach.indexOf('deps.localState.hydrate()');
    expect(hydrate).toBeGreaterThan(0);
    expect(hydrate).toBeLessThan(attach.indexOf('pullRemote()'));
  });
});
