import { createStore, get, keys, set } from 'idb-keyval';
import { describe, expect, it } from 'vitest';

import { SecureE2eStorage } from './secureStorage';
import {
  buildPvpkArchive,
  findInstalledPackBySetId,
  getEmojiPackNames,
  getEmojiPackRawName,
  getReceivedPackRef,
  getSetIdForPackName,
  loadInstalledPacks,
  parsePvpkArchive,
  registerReceivedEmojiPackRef,
  removeInstalledPack,
  resetPackRegistries,
  sanitizePackName,
  saveInstalledPack,
} from './stickerPacks';

function bytesOf(...values: number[]) {
  return new Uint8Array(values).buffer;
}

describe('PVPK1 container', () => {
  it('round-trips files and keeps byte layout parsable', () => {
    const files = [
      { name: '01-1f600.png', data: bytesOf(1, 2, 3) },
      { name: 'dance.tgs', data: bytesOf(4, 5) },
      { name: 'clip.webm', data: bytesOf(6) },
    ];
    const archive = buildPvpkArchive(files)!;
    // Формат desktop: "PVPK1" + u32LE длина JSON-индекса
    expect(new TextDecoder().decode(archive.subarray(0, 5))).toBe('PVPK1');
    const indexLen = new DataView(archive.buffer).getUint32(5, true);
    const index = JSON.parse(new TextDecoder().decode(archive.subarray(9, 9 + indexLen)));
    expect(index).toEqual([
      { name: '01-1f600.png', size: 3 },
      { name: 'dance.tgs', size: 2 },
      { name: 'clip.webm', size: 1 },
    ]);

    const parsed = parsePvpkArchive(archive)!;
    expect(parsed.map(({ name }) => name)).toEqual(['01-1f600.png', 'dance.tgs', 'clip.webm']);
    expect(Array.from(new Uint8Array(parsed[0].data))).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(parsed[2].data))).toEqual([6]);
  });

  it('skips unknown extensions on build and sanitizes names on parse', () => {
    expect(buildPvpkArchive([{ name: 'evil.exe', data: bytesOf(1) }])).toBeUndefined();

    const archive = buildPvpkArchive([{ name: 'ok.png', data: bytesOf(1, 2) }])!;
    // Подделываем index: имя с путём наружу и незнакомое расширение
    const indexLen = new DataView(archive.buffer).getUint32(5, true);
    const tampered = JSON.parse(new TextDecoder().decode(archive.subarray(9, 9 + indexLen)));
    tampered[0].name = '../../escape.png';
    const tamperedIndex = new TextEncoder().encode(JSON.stringify(tampered));
    const out = new Uint8Array(9 + tamperedIndex.length + 2);
    out.set(archive.subarray(0, 5), 0);
    new DataView(out.buffer).setUint32(5, tamperedIndex.length, true);
    out.set(tamperedIndex, 9);
    out.set([1, 2], 9 + tamperedIndex.length);
    const parsed = parsePvpkArchive(out)!;
    expect(parsed[0].name).toBe('escape.png');
  });

  it('rejects wrong magic and truncated payloads', () => {
    expect(parsePvpkArchive(new Uint8Array([1, 2, 3]))).toBeUndefined();
    const archive = buildPvpkArchive([{ name: 'a.png', data: bytesOf(1, 2, 3, 4) }])!;
    archive[0] = 0x58;
    expect(parsePvpkArchive(archive)).toBeUndefined();
  });

  it('sanitizes pack names like desktop and derives stable set ids', () => {
    expect(sanitizePackName('  My Pack/..\\<x>!  ')).toBe('My Packx');
    expect(sanitizePackName('')).toBe('Pack');
    expect(getSetIdForPackName('My Pack')).toBe(getSetIdForPackName('My Pack'));
    expect(getSetIdForPackName('My Pack')).not.toBe(getSetIdForPackName('Other'));
    expect(getSetIdForPackName('My Pack').startsWith('pvpk-')).toBe(true);
  });
});

describe('installed packs at rest', () => {
  const pngBytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).buffer;

  it('stores pack files only as ciphertext and round-trips rawName', async () => {
    const user = `packs-secure-${Date.now()}@local`;
    await SecureE2eStorage.clear(user);
    await saveInstalledPack(user, {
      name: 'PvEmoji123', rawName: 'Pv.Emoji!123', isEmoji: true, files: [{ name: '01-1f600.png', data: pngBytes() }],
    });
    resetPackRegistries();
    const packs = await loadInstalledPacks(user);
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ name: 'PvEmoji123', rawName: 'Pv.Emoji!123', isEmoji: true });
    expect(new Uint8Array(packs[0].files[0].data)).toEqual(new Uint8Array(pngBytes()));
    // В общем хранилище E2E нет открытых байтов PNG
    const store = createStore('parvane-e2e-v2', 'secure-state');
    for (const key of await keys(store)) {
      const value = await get(key, store);
      if (!value?.ciphertext) continue;
      const bytes = new Uint8Array(value.ciphertext);
      const index = bytes.findIndex((byte, i) => byte === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4e);
      expect(index).toBe(-1);
    }
    await removeInstalledPack(user, getSetIdForPackName('PvEmoji123'));
    resetPackRegistries();
    expect(await loadInstalledPacks(user)).toEqual([]);
    await SecureE2eStorage.clear(user);
  });

  // Граничный случай спеки: два одноимённых пака от РАЗНЫХ отправителей — это
  // два набора, и хранение обязано их различать. Пока запись ключевалась именем,
  // второй install затирал архив первого, а его docId ложились на чужие файлы
  it('keeps same-named packs from different senders as separate records', async () => {
    const user = `packs-collide-${Date.now()}@local`;
    await SecureE2eStorage.clear(user);
    resetPackRegistries();
    const fromAlice = registerReceivedEmojiPackRef({ file_id: 'f1', name: 'Pv.Emoji!123', count: 1 }, 'alice@bubble');
    const fromBob = registerReceivedEmojiPackRef({ file_id: 'f2', name: 'Pv.Emoji!123', count: 1 }, 'bob@bubble');
    expect(fromBob).not.toBe(fromAlice);

    const aliceBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 1, 1, 1]).buffer;
    const bobBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2, 2, 2, 2]).buffer;
    await saveInstalledPack(user, {
      name: 'PvEmoji123',
      setId: fromAlice,
      rawName: 'Pv.Emoji!123',
      isEmoji: true,
      files: [{ name: '01-1f600.png', data: aliceBytes }],
    });
    await saveInstalledPack(user, {
      name: 'PvEmoji123',
      setId: fromBob,
      rawName: 'Pv.Emoji!123',
      isEmoji: true,
      files: [{ name: '01-1f600.png', data: bobBytes }],
    });

    resetPackRegistries();
    const packs = await loadInstalledPacks(user);
    expect(packs).toHaveLength(2);
    expect(new Uint8Array(packs.find((p) => p.setId === fromAlice)!.files[0].data))
      .toEqual(new Uint8Array(aliceBytes));
    expect(new Uint8Array(packs.find((p) => p.setId === fromBob)!.files[0].data))
      .toEqual(new Uint8Array(bobBytes));

    // Удаление одного набора не трогает второй
    await removeInstalledPack(user, fromBob);
    resetPackRegistries();
    expect((await loadInstalledPacks(user)).map(({ setId }) => setId)).toEqual([fromAlice]);
    await SecureE2eStorage.clear(user);
  });

  // Записи, сделанные до 16 сен 2026, лежат под именем пака — они обязаны
  // пережить перенос на ключ набора и остаться находимыми по своему setId
  it('migrates records keyed by name onto the set id', async () => {
    const user = `packs-migrate-${Date.now()}@local`;
    await SecureE2eStorage.clear(user);
    const storage = await SecureE2eStorage.open(user);
    await storage.saveBytesRecord('stickerpack:Old', buildPvpkArchive([{ name: '01.png', data: pngBytes() }])!);
    await storage.saveRecord('stickerpacks', [{ name: 'Old' }]);

    resetPackRegistries();
    const packs = await loadInstalledPacks(user);
    expect(packs).toHaveLength(1);
    expect(packs[0].setId).toBe(getSetIdForPackName('Old'));
    expect(await findInstalledPackBySetId(user, getSetIdForPackName('Old'))).toBeDefined();
    // Старая запись под именем удалена, байты лежат под ключом набора
    expect(await storage.loadBytesRecord('stickerpack:Old')).toBeUndefined();
    expect(await storage.loadBytesRecord(`stickerpack:${getSetIdForPackName('Old')}`)).toBeDefined();
    await SecureE2eStorage.clear(user);
  });

  it('migrates legacy plaintext packs and deletes the old record', async () => {
    const user = `packs-legacy-${Date.now()}@local`;
    await SecureE2eStorage.clear(user);
    const legacyStore = createStore('parvane-stickers', 'packs');
    await set(`packs:${user}`, [{ name: 'Old', files: [{ name: '01.png', data: pngBytes() }] }], legacyStore);
    resetPackRegistries();
    const packs = await loadInstalledPacks(user);
    expect(packs.map(({ name }) => name)).toEqual(['Old']);
    expect(await get(`packs:${user}`, legacyStore)).toBeUndefined();
    await SecureE2eStorage.clear(user);
  });
});

describe('emoji pack names (EMOJI-1)', () => {
  it('keeps the first raw name and accumulates aliases from later refs', () => {
    resetPackRegistries();
    const setId = registerReceivedEmojiPackRef({ file_id: 'f1', name: 'Pv.Emoji!123', count: 1 });
    const again = registerReceivedEmojiPackRef({ file_id: 'f2', name: 'PvEmoji123', count: 1 });
    expect(again).toBe(setId);
    expect(getEmojiPackRawName(setId)).toBe('Pv.Emoji!123');
    expect(getEmojiPackNames(setId)).toEqual(expect.arrayContaining(['Pv.Emoji!123', 'PvEmoji123']));
  });

  it('falls back to the stored name for legacy records without rawName', () => {
    resetPackRegistries();
    expect(getEmojiPackNames('pvpk-legacy', { name: 'Old' })).toEqual(['Old']);
  });

  // Граничный случай спеки: «Два одинаково названных пака от разных
  // отправителей: эмодзи не подменяются чужими картинками»
  it('keeps packs with the same name from different senders apart', () => {
    resetPackRegistries();
    const fromAlice = registerReceivedEmojiPackRef({ file_id: 'f1', name: 'Pv.Emoji!123', count: 1 }, 'alice@bubble');
    const fromBob = registerReceivedEmojiPackRef({ file_id: 'f2', name: 'Pv.Emoji!123', count: 1 }, 'bob@bubble');

    expect(fromBob).not.toBe(fromAlice);
    // Сырое имя второго отправителя НЕ становится алиасом набора первого:
    // иначе его docId резолвились бы в файлы чужого пака
    expect(getEmojiPackRawName(fromAlice)).toBe('Pv.Emoji!123');
    expect(getEmojiPackRawName(fromBob)).toBe('Pv.Emoji!123');
    expect(getReceivedPackRef(fromAlice)?.file_id).toBe('f1');
    expect(getReceivedPackRef(fromBob)?.file_id).toBe('f2');
  });

  it('treats a repeat ref from the same sender as the same pack', () => {
    resetPackRegistries();
    const first = registerReceivedEmojiPackRef({ file_id: 'f1', name: 'Pv.Emoji!123', count: 1 }, 'alice@bubble');
    // По PACK-1 тот же пак на другой круг получателей приходит с новым
    // file_id — это по-прежнему один набор, и алиас копится как раньше
    const again = registerReceivedEmojiPackRef({ file_id: 'f9', name: 'PvEmoji123', count: 1 }, 'alice@bubble');
    expect(again).toBe(first);
    expect(getEmojiPackNames(first)).toEqual(expect.arrayContaining(['Pv.Emoji!123', 'PvEmoji123']));
  });
});
