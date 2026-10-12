import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

vi.mock('../../../api/gramjs', () => ({ callApi: vi.fn(() => Promise.resolve(undefined)) }));

const { callApi } = await import('../../../api/gramjs');
const {
  canSyncLearned, getPlannerNotice, getPlannerState, loadPlanner, showPlannerNotice,
} = await import('./plannerStore');
const { serializeLearned } = await import('./plannerQuickLearn');

describe('Уведомление планировщика', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('скрывается само через 3 секунды', () => {
    showPlannerNotice('Saved');
    expect(getPlannerNotice()?.text).toBe('Saved');
    vi.advanceTimersByTime(2900);
    expect(getPlannerNotice()?.text).toBe('Saved');
    vi.advanceTimersByTime(200);
    expect(getPlannerNotice()).toBeUndefined();
  });

  it('новое уведомление начинает отсчёт заново', () => {
    showPlannerNotice('First');
    vi.advanceTimersByTime(2000);
    showPlannerNotice('Second');
    vi.advanceTimersByTime(2000);
    expect(getPlannerNotice()?.text).toBe('Second');
    vi.advanceTimersByTime(1100);
    expect(getPlannerNotice()).toBeUndefined();
  });
});

describe('Словарь правок: перенос записи устройства в «План»', () => {
  const KEY = 'parvane:quick-learned:';
  const api = callApi as unknown as ReturnType<typeof vi.fn>;
  const saved = new Map<string, string>();
  const local = serializeLearned({
    tick: 6,
    heads: {
      пара: { minutes: { value: 60, count: 2 }, at: 6 },
      зал: { kind: { value: 'event', count: 3 }, at: 5 },
    },
  });
  const engine = (learned: unknown[]) => ({
    // eslint-disable-next-line no-null/no-null -- JSON движка: null = «не задано»
    tasks: [], events: [], lists: [], nutrition: [], settings: null, goals: null, learned, headSeq: 1, sizeBytes: 10,
  });
  let answer: Record<string, unknown> = {};

  beforeEach(() => {
    saved.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null, // eslint-disable-line no-null/no-null
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    api.mockReset();
    api.mockImplementation((method: string) => Promise.resolve(
      method === 'parvanePlannerState' ? answer : method === 'parvaneLoadPlanner' ? { status: 'ok' } : undefined,
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const applied = () => api.mock.calls.filter(([method]) => method === 'parvanePlannerApply')
    .flatMap(([, args]) => (args as { changes: Record<string, unknown>[] }).changes);

  it('готовый «План» со словарём другого устройства: слова сводятся без двойного счёта, запись стирается', async () => {
    saved.set(`${KEY}user-a`, local);
    answer = {
      status: 'ready',
      sizeBytes: 10,
      hasPending: false,
      state: engine([{
        id: 'пара', kind: '', kindCount: 0, minutes: 105, minutesCount: 4, touched: 9,
      }]),
    };
    await loadPlanner('user-a');
    expect(canSyncLearned()).toBe(true);
    // «пара» у другого устройства выучена сильнее — не трогается; «зал» добавляется самым свежим
    expect(applied()).toEqual([{
      learned: {
        id: 'зал', kind: 'event', kindCount: 3, minutes: null, minutesCount: 0, touched: 10, // eslint-disable-line no-null/no-null
      },
    }]);
    expect(getPlannerState().learned.map(({ id }) => id)).toEqual(['зал', 'пара']);
    expect(saved.has(`${KEY}user-a`)).toBe(false);
    // Повторная загрузка того же аккаунта ничего не пишет
    api.mockClear();
    await loadPlanner('user-a');
    expect(applied()).toEqual([]);
  });

  it('новый аккаунт без контейнера: запись устройства уходит целиком', async () => {
    saved.set(`${KEY}user-b`, local);
    answer = { status: 'ready', sizeBytes: 0, hasPending: false };
    await loadPlanner('user-b');
    expect(applied().map((change) => (change.learned as { id: string }).id)).toEqual(['зал', 'пара']);
    expect(saved.size).toBe(0);
  });

  it('пустая запись устройства — «План» не трогается', async () => {
    answer = { status: 'ready', sizeBytes: 0, hasPending: false };
    await loadPlanner('user-c');
    expect(applied()).toEqual([]);
  });

  it('устройство не привязано либо нет ключа: запись остаётся на устройстве', async () => {
    saved.set(`${KEY}user-d`, local);
    answer = { status: 'needs-linking', sizeBytes: 0, hasPending: false };
    await loadPlanner('user-d');
    expect(canSyncLearned()).toBe(false);
    saved.set(`${KEY}user-e`, local);
    answer = { status: 'no-key', sizeBytes: 0, hasPending: false };
    await loadPlanner('user-e');
    expect(canSyncLearned()).toBe(false);
    expect(applied()).toEqual([]);
    expect([...saved.keys()]).toEqual([`${KEY}user-d`, `${KEY}user-e`]);
  });

  it('непревращённые правки у провайдера: перенос ждёт сведённого состояния', async () => {
    saved.set(`${KEY}user-f`, local);
    answer = { status: 'ready', sizeBytes: 0, hasPending: true, state: engine([]) };
    await loadPlanner('user-f');
    expect(applied()).toEqual([]);
    expect(saved.has(`${KEY}user-f`)).toBe(true);
  });
});
