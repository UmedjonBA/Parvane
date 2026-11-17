import type { HealthSync } from './v2/health';

// Parvane (spec 038): методы «Здоровья» для экранов. Состояние, сводка и разбор ввода — из движка
// (контейнер домена `parvane.health.v1`); изменения — событием окна `parvane-health-changed`.
// Методы — всегда Promise: вызывающие ждут `.catch` у результата

type Deps = {
  health: () => HealthSync;
  log: (message: string) => void;
};

export type HealthStateReply = {
  status: ReturnType<HealthSync['status']>;
  // JSON сводки движка (`healthView`) — строкой: экран пропускает равные, не разбирая
  view?: string;
  hasPending: boolean;
  error?: string;
};

export function createHealthApi(deps: Deps) {
  // Подключение контейнера и опрос — один раз за сессию страницы; дальше синк идёт по таймеру модуля
  let isEnsureStarted = false;

  // Контейнер подключается при первом обращении любого экрана — «Здоровья» либо календаря «Плана»
  function ensureOnce() {
    const health = deps.health();
    const status = health.status();
    if (status !== 'needs-linking' && status !== 'loading' && !isEnsureStarted) {
      isEnsureStarted = true;
      void health.ensure();
    }
    return health;
  }

  function readState(nowMs: number, tzMin: number): HealthStateReply {
    const health = ensureOnce();
    const status = health.status();
    return {
      status, view: health.viewJson(nowMs, tzMin), hasPending: health.hasPending(), error: health.lastError(),
    };
  }

  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async parvaneHealthState({ nowMs, tzMin }: { nowMs: number; tzMin: number }): Promise<HealthStateReply> {
      try {
        return readState(nowMs, tzMin);
      } catch (err) {
        deps.log(`здоровье: состояние не прочитано: ${String(err)}`);
        return { status: 'offline', hasPending: false, error: String(err) };
      }
    },

    /**
     * Разбор строки ввода (HEALTH-2) с подстановкой «моих продуктов» (HEALTH-3 п. 13): JSON `{entries, unparsed,
     * problems}`; движок не готов — `undefined`.
     */
    // eslint-disable-next-line @typescript-eslint/require-await
    async parvaneHealthParse({ text, nowMs, tzMin }: { text: string; nowMs: number; tzMin: number }) {
      try {
        return deps.health().parseJson(text, nowMs, tzMin);
      } catch (err) {
        deps.log(`здоровье: ввод не разобран: ${String(err)}`);
        return undefined;
      }
    },

    /** Записи показателя новыми первыми: JSON `{entries, hasMore}`; `sleep` — сон вместе с отметками. */
    // eslint-disable-next-line @typescript-eslint/require-await
    async parvaneHealthEntries({
      kind, limit, nowMs, tzMin,
    }: { kind: string; limit: number; nowMs: number; tzMin: number }) {
      try {
        return deps.health().entriesJson(kind, limit, nowMs, tzMin);
      } catch (err) {
        deps.log(`здоровье: записи не прочитаны: ${String(err)}`);
        return undefined;
      }
    },

    /** Здоровье по дням отрезка — календарю «Плана»: JSON `{goals, days}`; движок не готов — `undefined`. */
    // eslint-disable-next-line @typescript-eslint/require-await
    async parvaneHealthDays({ fromDay, toDay }: { fromDay: string; toDay: string }) {
      try {
        return ensureOnce().daysJson(fromDay, toDay);
      } catch (err) {
        deps.log(`здоровье: дни не прочитаны: ${String(err)}`);
        return undefined;
      }
    },

    /** Проверка записи формы (диапазоны — как у разбора): код отказа либо `undefined`. */
    // eslint-disable-next-line @typescript-eslint/require-await
    async parvaneHealthCheck({ entry, nowMs }: { entry: unknown; nowMs: number }) {
      try {
        return deps.health().checkEntry(entry, nowMs);
      } catch (err) {
        deps.log(`здоровье: запись не проверена: ${String(err)}`);
        return 'form';
      }
    },

    /** Записать разобранные записи (поле `entries` разбора): id и сведение сна — в движке. `false` — не записано. */
    async parvaneHealthAdd({ entries, nowMs }: { entries: unknown[]; nowMs: number }) {
      const health = deps.health();
      const changes = health.composeChanges(entries, nowMs);
      if (!changes?.length) return false;
      health.apply(changes);
      await health.flush();
      return true;
    },

    /** Изменения: `{entry: {…}}`, `{entry: {id, deleted: true}}`, `{goal: {id, target}}`, `{goal: {id, deleted}}`. */
    // eslint-disable-next-line @typescript-eslint/require-await
    async parvaneHealthApply({ changes }: { changes: unknown[] }) {
      deps.health().apply(changes);
      return true;
    },

    async parvaneHealthFlush() {
      await deps.health().flush();
      return true;
    },

    async parvaneHealthSync() {
      await deps.health().syncNow();
      return true;
    },

    /** Есть ли у «Здоровья» зрители: без них опрос сервера редкий. */
    // eslint-disable-next-line @typescript-eslint/require-await
    async parvaneHealthSetActive({ isActive }: { isActive: boolean }) {
      deps.health().setActive(isActive);
      return true;
    },
  };
}
