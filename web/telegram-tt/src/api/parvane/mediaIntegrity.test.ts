import { describe, expect, it, vi } from 'vitest';

import type { FileGeometry, MediaIntegrity } from './mediaIntegrity';

import { createMediaIntegrity } from './mediaIntegrity';

const CHUNK = 32;

function makeFile(chunks: number, lastChunkBytes = CHUNK) {
  const parts: Uint8Array[] = [];
  for (let index = 0; index < chunks; index++) {
    const size = index === chunks - 1 ? lastChunkBytes : CHUNK;
    parts.push(new Uint8Array(size).fill(index + 1));
  }
  const sizeBytes = CHUNK * (chunks - 1) + lastChunkBytes;
  return { parts, geometry: { sizeBytes, chunkBytes: CHUNK, totalChunks: chunks } };
}

type Harness = {
  integrity: MediaIntegrity;
  fetches: Array<[number, number]>;
  tampered: string[];
  verified: string[];
  unverifiable: Array<[string, string]>;
  timers: Array<{ callback: () => void; ms: number; cancelled: boolean }>;
  runTimers: (ms: number) => void;
  settle: () => Promise<void>;
  fed: number[];
};

function setup({
  parts,
  geometry,
  tagOk = true,
  override,
  expectedPlainSize,
  isOffline = false,
}: {
  parts: Uint8Array[];
  geometry: FileGeometry;
  tagOk?: boolean;
  override?: (index: number, call: number) => Uint8Array | undefined;
  expectedPlainSize?: number;
  // Шард недоступен: ни один пакет не приходит
  isOffline?: boolean;
}): Harness {
  const fetches: Array<[number, number]> = [];
  const tampered: string[] = [];
  const verified: string[] = [];
  const unverifiable: Array<[string, string]> = [];
  const fed: number[] = [];
  const timers: Harness['timers'] = [];
  const callsByIndex = new Map<number, number>();
  const integrityRef: { current?: MediaIntegrity } = {};
  const integrity = createMediaIntegrity({
    fetchChunks: vi.fn((fileId: string, from: number, to: number) => {
      fetches.push([from, to]);
      if (isOffline) return Promise.resolve(undefined);
      if (!integrityRef.current!.noteGeometry(fileId, geometry, expectedPlainSize)) return Promise.resolve(undefined);
      const result = new Map<number, Uint8Array>();
      for (let index = from; index <= to; index++) {
        const call = (callsByIndex.get(index) || 0) + 1;
        callsByIndex.set(index, call);
        result.set(index, override?.(index, call) || parts[index]);
      }
      return Promise.resolve(result);
    }),
    createVerifier: () => Promise.resolve({
      update: (bytes: Uint8Array) => { fed.push(bytes[0]); },
      finish: () => tagOk,
    }),
    onTampered: (fileId) => tampered.push(fileId),
    onVerified: (fileId) => verified.push(fileId),
    onUnverifiable: (fileId, reason) => unverifiable.push([fileId, reason]),
    schedule: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancelSchedule: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
    digest: (bytes) => Promise.resolve(Array.from(bytes).join(',')),
  }, { startDelayMs: 5000, idleMs: 15000, batchChunks: 4 });
  integrityRef.current = integrity;

  return {
    integrity,
    fetches,
    tampered,
    verified,
    unverifiable,
    timers,
    fed,
    runTimers(ms) {
      timers.filter((timer) => !timer.cancelled && timer.ms === ms).forEach((timer) => {
        timer.cancelled = true;
        timer.callback();
      });
    },
    settle: async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
    },
  };
}

describe('media integrity scheduler', () => {
  it('starts only after the start delay and verifies every chunk in order in batches', async () => {
    const file = makeFile(10, 20);
    const h = setup(file);
    h.integrity.touch('f');
    await h.settle();
    expect(h.fetches).toEqual([]);
    h.runTimers(5000);
    await h.settle();
    expect(h.verified).toEqual(['f']);
    expect(h.fed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // первый пакет — геометрия (0..0), дальше пакеты по 4
    expect(h.fetches).toEqual([[0, 0], [0, 3], [4, 7], [8, 9]]);
  });

  it('marks the file tampered when the tag does not match', async () => {
    const h = setup({ ...makeFile(3), tagOk: false });
    h.integrity.touch('f');
    h.runTimers(5000);
    await h.settle();
    expect(h.tampered).toEqual(['f']);
    expect(h.integrity.isTampered('f')).toBe(true);
  });

  it('treats a chunk served with different bytes to the player and the verifier as tampering', async () => {
    const file = makeFile(6);
    // Плееру облако отдало подменённый фрагмент 2, проверке — честный:
    // отличие от эталона (первого экземпляра) = подмена
    const player = setup(file);
    expect(await player.integrity.noteChunk('g', 2, new Uint8Array(CHUNK).fill(99))).toBe(true);
    player.integrity.touch('g');
    player.runTimers(5000);
    await player.settle();
    expect(player.tampered).toEqual(['g']);
    expect(player.verified).toEqual([]);
  });

  it('detects tampering when the verifier gets a different copy of an already seen chunk', async () => {
    const file = makeFile(6);
    const h = setup(file);
    // Плеер уже видел честный фрагмент 1, повторный ответ облака отличается
    expect(await h.integrity.noteChunk('f', 1, file.parts[1])).toBe(true);
    expect(await h.integrity.noteChunk('f', 1, new Uint8Array(CHUNK).fill(77))).toBe(false);
    expect(h.tampered).toEqual(['f']);
  });

  it('rejects a cloud size that does not match the message and accepts a missing message size', () => {
    const file = makeFile(3);
    const wrong = setup({ ...file, expectedPlainSize: 5 });
    expect(wrong.integrity.noteGeometry('f', file.geometry, 5)).toBe(false);
    expect(wrong.tampered).toEqual(['f']);

    const plain = setup(file);
    expect(plain.integrity.noteGeometry('f', file.geometry, file.geometry.sizeBytes - 16)).toBe(true);
    const unknown = setup(file);
    expect(unknown.integrity.noteGeometry('f', file.geometry, undefined)).toBe(true);
    expect(unknown.integrity.noteGeometry('f', { ...file.geometry, sizeBytes: 1 }, undefined)).toBe(false);
  });

  it('waits while the player has a pending window request', async () => {
    const file = makeFile(8);
    const h = setup(file);
    h.integrity.beginPlayerRequest();
    h.integrity.touch('f');
    h.runTimers(5000);
    await h.settle();
    // геометрия получена, но пакеты не шли
    expect(h.fetches).toEqual([[0, 0]]);
    h.integrity.endPlayerRequest();
    await h.settle();
    expect(h.verified).toEqual(['f']);
  });

  it('resumes a paused job from nextIndex', async () => {
    const file = makeFile(8);
    const h = setup(file);
    h.integrity.beginPlayerRequest();
    h.integrity.touch('f');
    h.runTimers(5000);
    await h.settle();
    h.runTimers(15000); // простой — пауза
    expect(h.integrity.stateOf('f')).toBe('paused');
    h.integrity.endPlayerRequest();
    await h.settle();
    expect(h.verified).toEqual([]);
    h.integrity.touch('f');
    h.runTimers(5000);
    await h.settle();
    expect(h.verified).toEqual(['f']);
    expect(h.fed).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // FR-022: докачка и проверка обязаны дойти до конца, даже если пользователь
  // закрыл просмотрщик и окон плеера больше не будет — раньше задача уходила в
  // paused по простою и ждала touch(), которого уже никто не сделает
  it('resumes a job paused by idle without another player request', async () => {
    const file = makeFile(8);
    const h = setup(file);
    h.integrity.beginPlayerRequest();
    h.integrity.touch('f');
    h.runTimers(5000);
    await h.settle();
    h.runTimers(15000); // простой — пауза
    expect(h.integrity.stateOf('f')).toBe('paused');
    // плеер закрыт, touch() больше не будет
    h.integrity.endPlayerRequest();
    await h.settle();
    h.runTimers(1000); // будильник продолжения
    await h.settle();
    expect(h.verified).toEqual(['f']);
    expect(h.fed).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // FR-022: «проверить не удалось» обязано дойти наружу. Шард недоступен или
  // вкладка давно офлайн — попытки возобновления кончаются, задача остаётся в
  // paused навсегда, и без этого сигнала UI показывал бы файл проверенным
  it('reports a file it could never finish verifying without calling it tampered', async () => {
    const h = setup({ ...makeFile(8), isOffline: true });
    h.integrity.touch('f');
    h.runTimers(5000);
    await h.settle();
    // Отступ растёт: 1000, 2000, … 10000 мс — по попытке на будильник
    for (let attempt = 1; attempt <= 10; attempt++) {
      h.runTimers(1000 * attempt);
      await h.settle();
    }
    expect(h.unverifiable).toEqual([['f', 'нет геометрии файла']]);
    // Непроверяемый ≠ подменённый: файл не помечен, воспроизведение не рвётся
    expect(h.tampered).toEqual([]);
    expect(h.integrity.isTampered('f')).toBe(false);
    expect(h.integrity.stateOf('f')).toBe('paused');
  });

  // Смена аккаунта не должна навсегда вешать конвейер: раньше `reset()`
  // бросал ожидающих простоя плеера, задача не завершалась, `activeFileId`
  // оставался занятым, и фоновая проверка молча переставала работать
  it('keeps working after a reset while a job waits for the player', async () => {
    const h = setup(makeFile(8));
    h.integrity.beginPlayerRequest();
    h.integrity.touch('f');
    h.runTimers(5000);
    await h.settle();

    h.integrity.reset();
    await h.settle();

    // Новая задача после сброса обязана дойти до конца
    h.integrity.endPlayerRequest();
    h.integrity.touch('f');
    h.runTimers(5000);
    await h.settle();
    expect(h.verified).toEqual(['f']);
  });

  // SC-003 мерит пять секунд от НАЧАЛА ВОСПРОИЗВЕДЕНИЯ: если метаданные
  // тянулись дольше отсрочки, задача уже идёт — её надо вернуть в ожидание
  it('defers a running job when playback actually starts', async () => {
    const h = setup(makeFile(8));
    h.integrity.touch('f');
    h.runTimers(5000);
    await h.settle();
    expect(h.integrity.stateOf('f')).toBe('verified');

    const late = setup(makeFile(8));
    late.integrity.beginPlayerRequest();
    late.integrity.touch('f');
    late.runTimers(5000);
    await late.settle();
    // Задача стартовала до воспроизведения — событие `play` откладывает её
    late.integrity.notePlaybackStarted('f');
    expect(late.integrity.stateOf('f')).toBe('waiting');
    late.integrity.endPlayerRequest();
    late.runTimers(5000);
    await late.settle();
    expect(late.verified).toEqual(['f']);
  });

  it('keeps only one active verification at a time', async () => {
    const file = makeFile(4);
    const h = setup(file);
    h.integrity.beginPlayerRequest();
    h.integrity.touch('a');
    h.integrity.touch('b');
    h.runTimers(5000);
    await h.settle();
    // только первый файл успел запросить геометрию
    expect(h.fetches).toEqual([[0, 0]]);
    h.integrity.endPlayerRequest();
    await h.settle();
    expect(h.verified).toEqual(['a', 'b']);
  });

  // Цель плана «пиковая доп. память проверки < 20 МБ» держится не на замере, а
  // на двух структурных границах: за раз в полёте не больше одного пакета из
  // batchChunks фрагментов, и от длины файла размер пакета не зависит (байты
  // фрагментов после обработки не удерживаются — в задаче остаются только
  // дайджесты). При боевых 24 фрагментах по 192 КБ это ≈ 4,6 МБ.
  it('keeps the in-flight batch bounded regardless of file length', async () => {
    const long = makeFile(200);
    const h = setup(long);
    h.integrity.touch('f');
    h.runTimers(5000);
    // 200 фрагментов = 50 пакетов, каждому нужен свой круг микрозадач
    for (let i = 0; i < 60 && !h.verified.length; i++) await h.settle();
    expect(h.verified).toEqual(['f']);

    // Первый запрос — геометрия (0..0), дальше пакеты ровно по batchChunks = 4
    const [geometryFetch, ...batches] = h.fetches;
    expect(geometryFetch).toEqual([0, 0]);
    const sizes = batches.map(([from, to]) => to - from + 1);
    expect(Math.max(...sizes)).toBe(4);

    // Пакеты идут подряд и без перекрытия — значит одновременно в памяти
    // держится не больше одного пакета, а не весь файл
    let expectedFrom = 0;
    batches.forEach(([from, to]) => {
      expect(from).toBe(expectedFrom);
      expectedFrom = to + 1;
    });
    expect(expectedFrom).toBe(200);

    // Файл в 20 раз длиннее проверяется теми же пакетами: потолок памяти от
    // длины не растёт
    const short = setup(makeFile(10));
    short.integrity.touch('f');
    short.runTimers(5000);
    await short.settle();
    const shortSizes = short.fetches.slice(1).map(([from, to]) => to - from + 1);
    expect(Math.max(...shortSizes)).toBe(Math.max(...sizes));
  });
});
