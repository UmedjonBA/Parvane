import { createPersonalSync, type PersonalDeps, type PersonalSpec } from './personalSync';

// Parvane (spec 038): «Здоровье» на сервере — личный контейнер домена `parvane.health.v1`: записи со
// временем и цели, сервер видит только шифртекст. Жизненный цикл общий с «Планом» — `personalSync.ts`.
// Сведение, дни записей, сводка для экранов и разбор свободного ввода — в движке (HEALTH-1…3)
export const HEALTH_DOMAIN = 'parvane.health.v1';

const HEALTH_SPEC: PersonalSpec = {
  kind: 'health',
  domain: HEALTH_DOMAIN,
  label: 'здоровье',
  outboxRecord: 'health-outbox',
  pendingRecord: 'health-pending',
  // Каждое измерение — своя запись со случайным id: сжимать нечего, порядок правок сохраняется
  coalesce: (changes) => changes,
};

export function createHealthSync(deps: PersonalDeps) {
  return {
    ...createPersonalSync(deps, HEALTH_SPEC),
    /** Сводка для экранов на этот момент в этом поясе; контейнера или движка нет — `undefined`. */
    viewJson: (nowMs: number, tzMin: number) => deps.client()?.healthView(nowMs, tzMin),
    /** Изменения для записи разобранных записей (id, «лёг» + «встал» → один сон); движок не поднят — `undefined`. */
    composeChanges: (entries: unknown[], nowMs: number) => {
      const json = deps.client()?.healthCompose(entries, nowMs);
      return json ? (JSON.parse(json) as { changes: unknown[] }).changes : undefined;
    },
    /** Записи показателя страницей (JSON `{entries, hasMore}`); движок не поднят — `undefined`. */
    entriesJson: (kind: string, limit: number, nowMs: number, tzMin: number) => (
      deps.client()?.healthEntries(kind, limit, nowMs, tzMin)
    ),
    /** Сны, приёмы пищи и тренировки по дням отрезка (JSON `{goals, days}`); движок не поднят — `undefined`. */
    daysJson: (fromDay: string, toDay: string) => deps.client()?.healthDays(fromDay, toDay),
    /** Проверка записи формы движком: код отказа либо `undefined`. Движок не поднят — отказ `form`. */
    checkEntry: (entry: unknown, nowMs: number) => {
      const client = deps.client();
      return client ? client.healthCheck(entry, nowMs) : 'form';
    },
    /** Разбор строки ввода с подстановкой чисел еды из прошлых записей; движок не поднят — `undefined`. */
    parseJson: (input: string, nowMs: number, tzMin: number) => deps.client()?.healthRecall(input, nowMs, tzMin),
  };
}

export type HealthSync = ReturnType<typeof createHealthSync>;
