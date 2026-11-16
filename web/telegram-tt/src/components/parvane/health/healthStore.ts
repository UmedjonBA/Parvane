import type { createHealthApi } from '../../../api/parvane/healthApi';
import type {
  HealthEntry, HealthParseResult, HealthStatus, HealthView,
} from './healthTypes';

import { createSignal } from '../../../util/signals';
import { callApi } from '../../../api/gramjs';

// Parvane (spec 038): состояние «Здоровья» для экранов. Сводку считает движок (`healthView`), здесь —
// перечитывание по событию `parvane-health-changed` и раз в минуту (сводка зависит от «сейчас»), правки и
// подсказка об отмене последнего действия

// Методы «Здоровья» провайдера (`api/parvane/healthApi.ts`) — с их же типами
type HealthMethods = ReturnType<typeof createHealthApi>;
const callHealth = callApi as unknown as <N extends keyof HealthMethods>(
  name: N, ...args: Parameters<HealthMethods[N]>
) => ReturnType<HealthMethods[N]>;

const HEALTH_EVENT = 'parvane-health-changed';
const REFRESH_MS = 60 * 1000;
// Статус «загрузка» и «нет связи» могут смениться без события — перепроверяем чаще
const RETRY_MS = 3000;

export type HealthState = {
  status: HealthStatus;
  view?: HealthView;
  hasPending: boolean;
};

const [getHealthState, setHealthState] = createSignal<HealthState>({ status: 'loading', hasPending: false });

export { getHealthState };

let lastViewJson: string | undefined;
let isWatching = false;
let refreshTimer: number | undefined;

// Движок пишет отсутствующее значение как `null`; экраны ждут `undefined`
function parseEngineJson<T>(json: string) {
  // eslint-disable-next-line no-null/no-null
  return JSON.parse(json, (_key, value: unknown) => (value === null ? undefined : value)) as T;
}

function tzMinutes() {
  return -new Date().getTimezoneOffset();
}

export async function refreshHealth() {
  const reply = await callHealth('parvaneHealthState', { nowMs: Date.now(), tzMin: tzMinutes() })
    .catch(() => undefined);
  if (!reply) return;
  const previous = getHealthState();
  const isSameView = reply.view === lastViewJson;
  if (isSameView && previous.status === reply.status && previous.hasPending === reply.hasPending) return;
  lastViewJson = reply.view;
  setHealthState({
    status: reply.status,
    view: isSameView ? previous.view : reply.view ? parseEngineJson<HealthView>(reply.view) : undefined,
    hasPending: reply.hasPending,
  });
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  const { status } = getHealthState();
  refreshTimer = window.setTimeout(() => {
    void refreshHealth().then(scheduleRefresh);
  }, status === 'ready' ? REFRESH_MS : RETRY_MS);
}

/** Модуль показан: следим за изменениями. Модуль скрыт — опрос сервера редкий. */
export function watchHealth(isActive: boolean) {
  void callHealth('parvaneHealthSetActive', { isActive });
  if (!isWatching) {
    isWatching = true;
    window.addEventListener(HEALTH_EVENT, () => {
      void refreshHealth();
    });
  }
  if (!isActive) {
    window.clearTimeout(refreshTimer);
    return;
  }
  void refreshHealth().then(scheduleRefresh);
}

/** Разбор строки ввода движком: что получится записать и что не понято. */
export async function parseHealthInput(text: string): Promise<HealthParseResult | undefined> {
  const json = await callHealth('parvaneHealthParse', { text, nowMs: Date.now(), tzMin: tzMinutes() })
    .catch(() => undefined);
  return json ? parseEngineJson<HealthParseResult>(json) : undefined;
}

/** Записать разобранные записи; `false` — не записано (движок не готов, нечего писать). */
export async function addHealthEntries(entries: HealthParseResult['entries']) {
  if (!entries.length) return false;
  const isAdded = await callHealth('parvaneHealthAdd', { entries, nowMs: Date.now() }).catch(() => false);
  if (isAdded) await refreshHealth();
  return Boolean(isAdded);
}

async function applyChanges(changes: unknown[]) {
  await callHealth('parvaneHealthApply', { changes });
  await callHealth('parvaneHealthFlush');
  await refreshHealth();
}

export function deleteHealthEntry(id: string) {
  return applyChanges([{ entry: { id, deleted: true } }]);
}

/** Правка записи: запись уходит целиком с тем же id. */
export function saveHealthEntry(entry: HealthEntry) {
  const { day, ...fields } = entry;
  return applyChanges([{ entry: fields }]);
}

/** Цель показателя либо режима сна (`sleep_bed`, `sleep_wake` — минуты от полуночи); `undefined` — снять. */
export function setHealthGoal(id: string, target: number | undefined) {
  return applyChanges([{ goal: target === undefined ? { id, deleted: true } : { id, target } }]);
}
