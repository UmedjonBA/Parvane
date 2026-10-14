import { createSignal } from '../../../util/signals';
import { callApi } from '../../../api/gramjs';
import { createEmptyPlannerState, normalizePlannerState, type PlannerState } from './plannerModel';
import {
  hasLearned, learnStoreFromWords, learnStoreToWords, mergeLearnStores, readLearned, resetLearned,
} from './plannerQuickLearn';
import {
  hasHistory, historyFromLines, historyToLines, mergeHistories, readHistory, resetHistory,
} from './plannerQuickSuggest';
import {
  diffChanges, type EngineState, fromEngineState, hasEngineQuickLines, isLegacyPlannerRecord, legacyToChanges,
  type PlannerChange,
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
  // Провайдер новой сборки отдаёт сырую строку JSON состояния и номер ревизии: по ним без разбора видно,
  // что состояние не изменилось. У провайдера прежней сборки полей нет — сравнивается отпечаток
  raw?: string;
  revision?: number;
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
// Движок отдаёт историю ввода текстом (`quickLines`): значит, примет и её правку. У движка прежней сборки
// (вкладка со старым WASM) признака нет — история остаётся на устройстве
const [getHasQuickLines, setHasQuickLines] = createSignal(false);

let loadPromise: Promise<void> | undefined;
let loadedUserId: string | undefined;
let stateBeforeLastChange: PlannerState | undefined;
// Чем было состояние движка, которое показано сейчас: та же строка / ревизия / отпечаток — перечитка (раз в
// 8 с по синку, при открытии раздела) не трогает сигнал состояния, экраны не перерисовываются. Сбрасывается
// своей правкой: после неё показан черновик, и следующий ответ движка применяется в любом случае
let appliedEngine: { raw?: string; revision?: number; fingerprint?: string } | undefined;
let isListening = false;
let isMigrating = false;
// Запись словаря правок на устройстве проверяется один раз за загрузку, когда «План» готов
let isLearnedMigrated = false;
// Пока устройство не привязано, стек планировщика не запускается — опрашиваем до готовности
let linkingTimer: number | undefined;
const LINKING_POLL_MS = 3000;
const NOTICE_HIDE_MS = 3000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export {
  getPlannerState, getIsPlannerLoaded, getPlannerStatus, getPlannerNotice, getPlannerSizeBytes, getHasQuickLines,
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
  if (result.state) setHasQuickLines(hasEngineQuickLines(result.state));
  if (result.state && result.status !== 'needs-linking' && !result.hasPending) {
    // Пока у провайдера есть непревращённые в операцию правки, состояние движка
    // отстаёт от черновика экрана — не затираем его
    if (!isAppliedEngineState(result)) {
      try {
        setPlannerState(fromEngineState(result.state, getPlannerState()));
        appliedEngine = engineMarkOf(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[parvane] планировщик: состояние движка не разобрано', err);
      }
    }
    setIsPlannerLoaded(true);
  } else if (result.status === 'ready' || result.status === 'offline' || result.status === 'no-key') {
    // Контейнера ещё нет (создастся первой правкой) — пустой планировщик
    setIsPlannerLoaded(true);
  }
  // Словарь на экране — весь словарь из «Плана» (нет непревращённых правок): можно вливать запись устройства
  if (result.status === 'ready' && !result.hasPending) {
    migrateLearned();
    migrateQuickHistory();
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

// Отметка состояния движка: строка JSON либо ревизия, иначе — отпечаток разобранного JSON (одна сериализация
// дешевле разбора состояния и перерисовки экранов)
function engineMarkOf(result: StateResult): NonNullable<typeof appliedEngine> {
  if (result.raw !== undefined) return { raw: result.raw };
  if (result.revision !== undefined) return { revision: result.revision };
  return { fingerprint: JSON.stringify(result.state) };
}

function isAppliedEngineState(result: StateResult) {
  if (!appliedEngine || !getIsPlannerLoaded()) return false;
  if (result.raw !== undefined) return result.raw === appliedEngine.raw;
  if (result.revision !== undefined) return result.revision === appliedEngine.revision;
  return appliedEngine.fingerprint !== undefined && JSON.stringify(result.state) === appliedEngine.fingerprint;
}

/**
 * Раздел «План» на экране либо нет: провайдер новой сборки реже опрашивает движок, пока раздел скрыт.
 * У провайдера прежней сборки метода нет — вызов просто не удаётся.
 */
export function setPlannerActive(isActive: boolean) {
  try {
    void callParvane('parvanePlannerSetActive', { isActive }).catch(() => undefined);
  } catch {
    // Метода нет
  }
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

/** Словарь правок ввода текстом пишется в данные «Плана»: «План» загружен и не ждёт привязки либо ключа. */
export function canSyncLearned() {
  const status = getPlannerStatus();
  return getIsPlannerLoaded() && (status === 'ready' || status === 'offline');
}

// Словарь правок, накопленный на устройстве (до синхронизации либо пока «План» был недоступен),
// вливается в данные «Плана» и стирается с устройства. Без уведомления и без «Отменить»
function migrateLearned() {
  if (isLearnedMigrated || !canSyncLearned()) return;
  isLearnedMigrated = true;
  const local = readLearned(loadedUserId);
  if (!hasLearned(local)) return;
  const previous = getPlannerState();
  const draft = structuredClone(previous);
  draft.learned = learnStoreToWords(mergeLearnStores(learnStoreFromWords(previous.learned), local));
  // «Отменить» прежней правки вернуло бы и состояние без словаря
  stateBeforeLastChange = undefined;
  setLocalState(draft);
  sendChanges(diffChanges(previous, draft));
  resetLearned(loadedUserId);
}

/**
 * История ввода текстом пишется в данные «Плана»: «План» принимает правки, и движок историю понимает. У
 * нового аккаунта контейнера ещё нет (состояния движок не отдал) — до первой записи история ведётся на
 * устройстве и переносится, как только состояние появится.
 */
export function canSyncQuickHistory() {
  return canSyncLearned() && getHasQuickLines();
}

// История, накопленная на устройстве (до синхронизации либо пока «План» был недоступен), вливается в
// данные «Плана» и стирается с устройства. Отметки о переносе нет: перенесённое — это стёртая запись.
// Без уведомления и без «Отменить»
function migrateQuickHistory() {
  if (!canSyncQuickHistory()) return;
  const local = readHistory(loadedUserId);
  if (!hasHistory(local)) return;
  const previous = getPlannerState();
  const draft = structuredClone(previous);
  draft.quickLines = historyToLines(mergeHistories(historyFromLines(previous.quickLines), local), previous.quickLines);
  // «Отменить» прежней правки вернуло бы и состояние без истории
  stateBeforeLastChange = undefined;
  setLocalState(draft);
  sendChanges(diffChanges(previous, draft));
  resetHistory(loadedUserId);
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

// Черновик экрана: показан он, а не состояние движка — следующий ответ движка применяется обязательно
function setLocalState(state: PlannerState) {
  appliedEngine = undefined;
  setPlannerState(state);
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
  setLocalState(draft);
  if (noticeText) publishNotice({ text: noticeText, canUndo: true });
  sendChanges(diffChanges(previous, draft));
}

export function undoPlanner(noticeText: string) {
  if (!stateBeforeLastChange) return;
  const current = getPlannerState();
  const target = stateBeforeLastChange;
  stateBeforeLastChange = undefined;
  setLocalState(target);
  publishNotice({ text: noticeText, canUndo: false });
  sendChanges(diffChanges(current, target));
}

// Уведомление без изменения состояния (ошибка ввода): «Отменить» к нему не
// относится — кнопка предлагала бы откатить предыдущее успешное действие
export function showPlannerNotice(text: string) {
  publishNotice({ text, canUndo: false });
}

// Полоска уходит сама; новое уведомление начинает отсчёт заново
function publishNotice(notice?: PlannerNotice) {
  if (noticeTimer !== undefined) clearTimeout(noticeTimer);
  noticeTimer = undefined;
  setPlannerNotice(notice);
  if (!notice) return;
  noticeTimer = setTimeout(() => {
    noticeTimer = undefined;
    setPlannerNotice(undefined);
  }, NOTICE_HIDE_MS);
}

function resetPlanner() {
  if (linkingTimer !== undefined && typeof window !== 'undefined') window.clearInterval(linkingTimer);
  linkingTimer = undefined;
  loadPromise = undefined;
  stateBeforeLastChange = undefined;
  appliedEngine = undefined;
  isLearnedMigrated = false;
  setHasQuickLines(false);
  setIsPlannerLoaded(false);
  setPlannerStatus('loading');
  publishNotice(undefined);
  setPlannerSizeBytes(0);
  setPlannerState(createEmptyPlannerState());
}
