import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

vi.mock('../../../api/gramjs', () => ({ callApi: vi.fn(() => Promise.resolve(undefined)) }));

const { callApi } = await import('../../../api/gramjs');
const {
  canSyncLearned, canSyncQuickHistory, getPlannerNotice, getPlannerState, loadPlanner, showPlannerNotice,
  updatePlanner,
} = await import('./plannerStore');
const { serializeLearned } = await import('./plannerQuickLearn');
const { quickLineId, serializeHistory } = await import('./plannerQuickSuggest');

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

describe('Перечитка состояния движка без изменений не трогает состояние экранов (C1)', () => {
  const api = callApi as unknown as ReturnType<typeof vi.fn>;
  const task = (id: string, name: string) => ({
    id, name, description: '', steps: [], status: 'queue', listId: '', rank: 1, day: '2026-10-08', start: '',
    due: '', minutes: 30, repeat: null, occurrences: [], origin: null, source: null, // eslint-disable-line no-null/no-null
  });
  const engine = (tasks: unknown[]) => ({
    // eslint-disable-next-line no-null/no-null -- JSON движка: null = «не задано»
    tasks, events: [], lists: [], nutrition: [], settings: null, goals: null, headSeq: 1, sizeBytes: 10,
  });
  let answer: Record<string, unknown> = {};
  const flush = () => new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null, // eslint-disable-line no-null/no-null
      setItem: vi.fn(),
      removeItem: vi.fn(),
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

  it('та же сырая строка — тот же объект состояния; другая — новое с прежними объектами записей', async () => {
    const state = engine([task('t1', 'Один'), task('t2', 'Два')]);
    answer = {
      status: 'ready', sizeBytes: 10, hasPending: false, state, raw: 'A',
    };
    await loadPlanner('user-raw');
    const shown = getPlannerState();
    expect(shown.tasks.map(({ id }) => id)).toEqual(['t1', 't2']);
    // Раздел открыт заново — перечитка
    void loadPlanner('user-raw');
    await flush();
    expect(getPlannerState()).toBe(shown);
    // Разобранный JSON мог бы отличаться, но строка та же — не перечитывается
    answer = { ...answer, state: engine([task('t1', 'Другое')]) };
    void loadPlanner('user-raw');
    await flush();
    expect(getPlannerState()).toBe(shown);
    answer = {
      status: 'ready', sizeBytes: 10, hasPending: false, raw: 'B',
      state: engine([task('t1', 'Один'), task('t2', 'Два-2')]),
    };
    void loadPlanner('user-raw');
    await flush();
    const next = getPlannerState();
    expect(next).not.toBe(shown);
    expect(next.tasks[0]).toBe(shown.tasks[0]);
    expect(next.tasks[1].name).toBe('Два-2');
  });

  it('ревизия и отпечаток JSON — то же правило', async () => {
    const state = engine([task('t1', 'Один')]);
    answer = {
      status: 'ready', sizeBytes: 10, hasPending: false, state, revision: 3,
    };
    await loadPlanner('user-rev');
    const shown = getPlannerState();
    void loadPlanner('user-rev');
    await flush();
    expect(getPlannerState()).toBe(shown);
    answer = { ...answer, revision: 4 };
    void loadPlanner('user-rev');
    await flush();
    expect(getPlannerState()).not.toBe(shown);

    answer = { status: 'ready', sizeBytes: 10, hasPending: false, state: engine([task('t1', 'Один')]) };
    await loadPlanner('user-print');
    const printed = getPlannerState();
    answer = { ...answer, state: engine([task('t1', 'Один')]) };
    void loadPlanner('user-print');
    await flush();
    expect(getPlannerState()).toBe(printed);
    answer = { ...answer, state: engine([task('t1', 'Иное')]) };
    void loadPlanner('user-print');
    await flush();
    expect(getPlannerState().tasks[0].name).toBe('Иное');
  });

  it('после своей правки ответ движка применяется, даже если строка та же', async () => {
    answer = {
      status: 'ready', sizeBytes: 10, hasPending: false, state: engine([task('t1', 'Один')]), raw: 'A',
    };
    await loadPlanner('user-edit');
    updatePlanner((draft) => {
      draft.tasks[0].name = 'Правка';
    });
    expect(getPlannerState().tasks[0].name).toBe('Правка');
    // Движок правку отверг (строка прежняя) — экран возвращается к состоянию движка
    void loadPlanner('user-edit');
    await flush();
    expect(getPlannerState().tasks[0].name).toBe('Один');
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

describe('История ввода текстом: перенос записи устройства в «План»', () => {
  const KEY = 'parvane:quick-history:';
  const api = callApi as unknown as ReturnType<typeof vi.fn>;
  const saved = new Map<string, string>();
  const local = serializeHistory({
    tick: 3,
    lines: [{ text: 'Купить кабель', count: 2, at: 3 }, { text: 'зал 19:00', count: 1, at: 1 }],
    hidden: ['обед'],
  });
  // `quickLines` нет — движок прежней сборки
  const engine = (quickLines?: unknown[]) => ({
    // eslint-disable-next-line no-null/no-null -- JSON движка: null = «не задано»
    tasks: [], events: [], lists: [], nutrition: [], settings: null, goals: null, quickLines, headSeq: 1, sizeBytes: 10,
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

  it('готовый «План» с историей другого устройства: строки объединяются, запись стирается', async () => {
    saved.set(`${KEY}hist-a`, local);
    answer = {
      status: 'ready',
      sizeBytes: 10,
      hasPending: false,
      state: engine([{
        id: quickLineId('купить кабель'), text: 'купить кабель', count: 5, touched: 40, hidden: false,
      }]),
    };
    await loadPlanner('hist-a');
    expect(canSyncQuickHistory()).toBe(true);
    // «купить кабель» у другого устройства использована чаще — запись не трогается; своя строка добавляется
    // самой свежей, забытый шаблон — к забытым
    expect(applied()).toEqual([
      {
        quickLine: {
          id: quickLineId('обед', true), text: 'обед', count: 0, touched: 41, hidden: true,
        },
      },
      {
        quickLine: {
          id: quickLineId('зал 19:00'), text: 'зал 19:00', count: 1, touched: 41, hidden: false,
        },
      },
    ]);
    expect(getPlannerState().quickLines.map(({ text }) => text).sort()).toEqual(['зал 19:00', 'купить кабель', 'обед']);
    expect(saved.has(`${KEY}hist-a`)).toBe(false);
    // Повторная загрузка того же аккаунта ничего не пишет
    api.mockClear();
    await loadPlanner('hist-a');
    expect(applied()).toEqual([]);
  });

  it('движок прежней сборки истории не знает: запись остаётся на устройстве и в «План» не пишется', async () => {
    saved.set(`${KEY}hist-b`, local);
    answer = {
      status: 'ready', sizeBytes: 10, hasPending: false, state: engine(),
    };
    await loadPlanner('hist-b');
    expect(canSyncLearned()).toBe(true);
    expect(canSyncQuickHistory()).toBe(false);
    expect(applied()).toEqual([]);
    expect(saved.has(`${KEY}hist-b`)).toBe(true);
  });

  it('новый аккаунт без контейнера: история ждёт на устройстве первого состояния движка', async () => {
    saved.set(`${KEY}hist-c`, local);
    answer = { status: 'ready', sizeBytes: 0, hasPending: false };
    await loadPlanner('hist-c');
    expect(canSyncQuickHistory()).toBe(false);
    expect(applied()).toEqual([]);
    // Контейнер появился (первая запись): следующая загрузка переносит историю целиком
    answer = {
      status: 'ready', sizeBytes: 10, hasPending: false, state: engine([]),
    };
    await loadPlanner('hist-c');
    // Повторная загрузка перечитывает состояние, не дожидаясь ответа
    await vi.waitFor(() => {
      expect(applied().map((change) => (change.quickLine as { text: string }).text).sort())
        .toEqual(['Купить кабель', 'зал 19:00', 'обед']);
    });
    expect(saved.size).toBe(0);
  });

  it('устройство не привязано: история остаётся на устройстве', async () => {
    saved.set(`${KEY}hist-d`, local);
    answer = { status: 'needs-linking', sizeBytes: 0, hasPending: false };
    await loadPlanner('hist-d');
    expect(canSyncQuickHistory()).toBe(false);
    expect(applied()).toEqual([]);
    expect(saved.has(`${KEY}hist-d`)).toBe(true);
  });
});
