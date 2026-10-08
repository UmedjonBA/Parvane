import { createSignal } from '../../../util/signals';
import { callApi } from '../../../api/gramjs';
import { createEmptyPlannerState, normalizePlannerState, type PlannerState } from './plannerModel';

// Parvane (spec 009): состояние планировщика — сигнал + шифрованная запись
// устройства через провайдер. Изменения — только `updatePlanner`: он копирует
// состояние, применяет правку, запоминает прежнее для «Отменить» и сохраняет

type LoadResult = { status: 'ok'; state?: unknown } | { status: 'not-ready' };
type PlannerNotice = { text: string; canUndo: boolean };

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

const SAVE_DELAY_MS = 400;
const LOAD_RETRY_MS = 1000;
const LOAD_ATTEMPTS = 30;

const [getPlannerState, setPlannerState] = createSignal<PlannerState>(createEmptyPlannerState());
const [getIsPlannerLoaded, setIsPlannerLoaded] = createSignal(false);
const [getPlannerNotice, setPlannerNotice] = createSignal<PlannerNotice | undefined>(undefined);

let loadPromise: Promise<void> | undefined;
let loadedUserId: string | undefined;
let saveTimer: number | undefined;
let stateBeforeLastChange: PlannerState | undefined;

export { getPlannerState, getIsPlannerLoaded, getPlannerNotice };

// `userId` — текущий аккаунт: при его смене в той же вкладке состояние читается заново
export function loadPlanner(userId?: string) {
  if (loadedUserId !== userId) {
    resetPlanner();
    loadedUserId = userId;
  }
  loadPromise ??= (async () => {
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
      const result = await callParvane('parvaneLoadPlanner') as LoadResult | undefined;
      if (result?.status === 'ok') {
        setPlannerState(normalizePlannerState(result.state));
        setIsPlannerLoaded(true);
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

export function updatePlanner(mutate: (draft: PlannerState) => void, noticeText?: string) {
  if (!getIsPlannerLoaded()) return;
  const previous = getPlannerState();
  const draft = structuredClone(previous);
  mutate(draft);
  stateBeforeLastChange = previous;
  setPlannerState(draft);
  if (noticeText) setPlannerNotice({ text: noticeText, canUndo: true });
  scheduleSave();
}

export function undoPlanner(noticeText: string) {
  if (!stateBeforeLastChange) return;
  setPlannerState(stateBeforeLastChange);
  stateBeforeLastChange = undefined;
  setPlannerNotice({ text: noticeText, canUndo: false });
  scheduleSave();
}

export function showPlannerNotice(text: string) {
  setPlannerNotice({ text, canUndo: Boolean(stateBeforeLastChange) });
}

function resetPlanner() {
  window.clearTimeout(saveTimer);
  loadPromise = undefined;
  stateBeforeLastChange = undefined;
  setIsPlannerLoaded(false);
  setPlannerNotice(undefined);
  setPlannerState(createEmptyPlannerState());
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void callParvane('parvaneSavePlanner', { state: getPlannerState() });
  }, SAVE_DELAY_MS);
}
