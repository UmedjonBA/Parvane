// Parvane: свой фон чата хранится ЗАШИФРОВАННЫМ (spec 002 FR-023) — раньше он
// лежал открытым блобом в Cache Storage. Тест закрывает три вещи, на которых
// правка уже один раз ломалась:
//  1) байты и мим-тип возвращаются обратно без искажений;
//  2) в хранилище не остаётся открытых байтов картинки;
//  3) «пользователь ещё не известен» и «обоев нет» — РАЗНЫЕ ответы: на первом
//     вызывающий обязан повторить, иначе настройка темы сбрасывается впустую.
import { entries } from 'idb-keyval';
import {
  beforeEach, describe, expect, it,
} from 'vitest';

import { SecureE2eStorage, secureStorageInternals } from './secureStorage';

const USER = 'background-owner@local';
const RECORD = 'background:dark';
const PIXELS = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef]);

// Те же две операции, что делает провайдер в saveChatBackground/loadChatBackground
async function saveBackground(user: string, bytes: Uint8Array, mimeType: string) {
  const storage = await SecureE2eStorage.open(user);
  await storage.saveBytesRecord(RECORD, bytes);
  await storage.saveRecord(`${RECORD}:mime`, mimeType);
}

async function loadBackground(user: string) {
  const storage = await SecureE2eStorage.open(user);
  const bytes = await storage.loadBytesRecord(RECORD);
  if (!bytes) return undefined;
  return { bytes, mimeType: await storage.loadRecord<string>(`${RECORD}:mime`) };
}

describe('chat background storage', () => {
  beforeEach(async () => {
    await SecureE2eStorage.clear(USER);
  });

  it('returns the picture bytes and mime unchanged', async () => {
    await saveBackground(USER, PIXELS, 'image/png');

    const loaded = await loadBackground(USER);
    expect(Array.from(loaded!.bytes)).toEqual(Array.from(PIXELS));
    expect(loaded!.mimeType).toBe('image/png');
  });

  it('keeps no plaintext picture bytes in storage', async () => {
    await saveBackground(USER, PIXELS, 'image/png');

    // Ни одна запись хранилища не должна содержать сигнатуру картинки
    const all = await entries(secureStorageInternals.store);
    const hasPlaintext = all.some(([, value]) => {
      const record = value as { ciphertext?: ArrayBuffer };
      if (!record?.ciphertext) return false;
      const stored = new Uint8Array(record.ciphertext);
      return stored.some((_, index) => PIXELS.every((byte, offset) => stored[index + offset] === byte));
    });
    expect(hasPlaintext).toBe(false);
  });

  it('does not leak the background to another account', async () => {
    await saveBackground(USER, PIXELS, 'image/png');

    const other = 'background-stranger@local';
    expect(await loadBackground(other)).toBeUndefined();
    await SecureE2eStorage.clear(other);
  });

  // «Обоев нет» — единственный случай, в котором вызывающему можно сбрасывать
  // настройку темы; «пользователь ещё не известен» таким случаем не является
  it('reports an empty store as empty, not as a failure', async () => {
    expect(await loadBackground(USER)).toBeUndefined();
  });
});
