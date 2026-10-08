import { createSignal } from '../../../util/signals';
import { callApi } from '../../../api/gramjs';
import { createEmptyPlannerState, normalizePlannerState, type PlannerState } from './plannerModel';
import {
  diffChanges, type EngineState, fromEngineState, isLegacyPlannerRecord, legacyToChanges, type PlannerChange,
} from './plannerSync';

// Parvane (spec 010): состояние планировщика — сигнал поверх контейнера домена
// в движке. Экраны правят `PlannerState` через `updatePlanner`: разница
// состояний уходит провайдеру списком изменений (пакетируется и шифруется
// там), сведённое состояние возвращается событием `parvane-planner-changed`.
// «Отменить» — обратные изменения (обычная правка с новой меткой), а не откат.
// Данные этапа 1 (одна запись устройства) переносятся в контейнер один раз.

export type PlannerStatus = 'loading' | 'needs-linking' | 'no-key' | 'offline' | 'ready';
type PlannerNotice = { text: string; canUndo: boolean };
type StateResult = {
  status: PlannerStatus;
  state?: EngineState;
  sizeBytes: number;
  hasPending: boolean;
  error?: string;
};
type LegacyResult = { status: 'ok'; state?: unknown } | { status: 'not-ready' };

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

const LOAD_RETRY_MS = 1000;
const LOAD_ATTEMPTS = 60;
const PLANNER_EVENT = 'parvane-planner-changed';

const [getPlannerState, setPlannerState] = createSignal<PlannerState>(createEmptyPlannerState());
const [getIsPlannerLoaded, setIsPlannerLoaded] = createSignal(false);
const [getPlannerStatus, setPlannerStatus] = createSignal<PlannerStatus>('loading');
const [getPlannerNotice, setPlannerNotice] = createSignal<PlannerNotice | undefined>(undefined);
const [getPlannerSizeBytes, setPlannerSizeBytes] = createSignal(0);

let loadPromise: Promise<void> | undefined;
let loadedUserId: string | undefined;
let stateBeforeLastChange: PlannerState | undefined;
let isListening = false;
let isMigrating = false;
// Пока устройство не привязано, стек планировщика не запускается — опрашиваем до готовности
let linkingTimer: number | undefined;
const LINKING_POLL_MS = 3000;

export {
  getPlannerState, getIsPlannerLoaded, getPlannerStatus, getPlannerNotice, getPlannerSizeBytes,
};

function listen() {
  if (isListening || typeof window === 'undefined') return;
  isListening = true;
  window.addEventListener(PLANNER_EVENT, () => {
    void refreshFromEngine();
  });
}

/** Перечитать состояние движка (после синка, события, своей правки). */
async function refreshFromEngine(): Promise<StateResult | undefined> {
  const result = await callParvane('parvanePlannerState').catch(() => undefined) as StateResult | undefined;
  if (!result) return undefined;
  setPlannerStatus(result.status);
  setPlannerSizeBytes(result.sizeBytes || 0);
  if (result.state && result.status !== 'needs-linking' && !result.hasPending) {
    // Пока у провайдера есть непревращённые в операцию правки, состояние движка
    // отстаёт от черновика экрана — не затираем его
    try {
      setPlannerState(fromEngineState(result.state));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[parvane] планировщик: состояние движка не разобрано', err);
    }
    setIsPlannerLoaded(true);
  } else if (result.status === 'ready' || result.status === 'offline' || result.status === 'no-key') {
    // Контейнера ещё нет (создастся первой правкой) — пустой планировщик
    setIsPlannerLoaded(true);
  }
  if (result.status === 'needs-linking' && linkingTimer === undefined && typeof window !== 'undefined') {
    linkingTimer = window.setInterval(() => {
      void refreshFromEngine().then((next) => {
        if (next && next.status !== 'needs-linking' && next.status !== 'loading' && linkingTimer !== undefined) {
          window.clearInterval(linkingTimer);
          linkingTimer = undefined;
          void migrateLegacy(next);
        }
      });
    }, LINKING_POLL_MS);
  }
  return result;
}

// Данные этапа 1 (FR-008): запись устройства → изменения одной партией, затем маркер
async function migrateLegacy(result: StateResult) {
  if (isMigrating || result.status !== 'ready') return;
  const legacy = await callParvane('parvaneLoadPlanner').catch(() => undefined) as LegacyResult | undefined;
  if (!legacy || legacy.status !== 'ok' || !isLegacyPlannerRecord(legacy.state)) return;
  isMigrating = true;
  try {
    const state = normalizePlannerState(legacy.state);
    const prefix = typeof navigator === 'undefined' ? 'web' : `web${Math.abs(hashCode(navigator.userAgent)) % 100000}`;
    const changes = legacyToChanges(state, prefix);
    const count = state.tasks.length + state.events.length + Object.keys(state.nutrition).length;
    await callParvane('parvanePlannerApply', { changes });
    await callParvane('parvanePlannerFlush');
    await callParvane('parvanePlannerMarkMigrated', { count });
    await refreshFromEngine();
  } finally {
    isMigrating = false;
  }
}

function hashCode(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash;
}

// `userId` — текущий аккаунт: при его смене в той же вкладке состояние читается заново
export function loadPlanner(userId?: string) {
  listen();
  if (loadedUserId !== userId) {
    resetPlanner();
    loadedUserId = userId;
  }
  // Раздел открыт заново: состояние движка могло уйти вперёд (синк, привязка)
  if (loadPromise) void refreshFromEngine();
  loadPromise ??= (async () => {
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
      const result = await refreshFromEngine();
      if (result && result.status !== 'loading') {
        await migrateLegacy(result);
        return;
      }
      await new Promise((resolve) => {
        window.setTimeout(resolve, LOAD_RETRY_MS);
      });
    }
    loadPromise = undefined;
  })();
  return loadPromise;
}

function sendChanges(changes: PlannerChange[]) {
  if (!changes.length) return;
  void callParvane('parvanePlannerApply', { changes }).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn('[parvane] планировщик: правки не переданы провайдеру', err);
  });
}

export function updatePlanner(mutate: (draft: PlannerState) => void, noticeText?: string) {
  if (!getIsPlannerLoaded()) return;
  const previous = getPlannerState();
  const draft = structuredClone(previous);
  mutate(draft);
  stateBeforeLastChange = previous;
  setPlannerState(draft);
  if (noticeText) setPlannerNotice({ text: noticeText, canUndo: true });
  sendChanges(diffChanges(previous, draft));
}

export function undoPlanner(noticeText: string) {
  if (!stateBeforeLastChange) return;
  const current = getPlannerState();
  const target = stateBeforeLastChange;
  stateBeforeLastChange = undefined;
  setPlannerState(target);
  setPlannerNotice({ text: noticeText, canUndo: false });
  sendChanges(diffChanges(current, target));
}

// Уведомление без изменения состояния (ошибка ввода): «Отменить» к нему не
// относится — кнопка предлагала бы откатить предыдущее успешное действие
export function showPlannerNotice(text: string) {
  setPlannerNotice({ text, canUndo: false });
}

function resetPlanner() {
  if (linkingTimer !== undefined && typeof window !== 'undefined') window.clearInterval(linkingTimer);
  linkingTimer = undefined;
  loadPromise = undefined;
  stateBeforeLastChange = undefined;
  setIsPlannerLoaded(false);
  setPlannerStatus('loading');
  setPlannerNotice(undefined);
  setPlannerSizeBytes(0);
  setPlannerState(createEmptyPlannerState());
}
