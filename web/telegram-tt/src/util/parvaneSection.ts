import { createSignal } from './signals';

// Parvane (spec 009): раздел приложения, выбранный в нижней части боковой
// панели. Мессенджер остаётся смонтированным (звонки, синхронизация) — раздел
// только решает, что показано справа от панели
export type ParvaneSection = 'messenger' | 'planner' | 'cloud';

const [getParvaneSection, setSignal] = createSignal<ParvaneSection>('messenger');
// Запрос «новая запись» из нижней панели телефона: «План» открывает форму и сбрасывает запрос
const [getPlannerAddRequest, setPlannerAddRequest] = createSignal(false);

// Экран «Плана»: «Сегодня» либо «Календарь». Выбирается кнопками боковой панели (компьютер) и вкладками
// раздела (телефон); устройство помнит последний
export type PlannerView = 'today' | 'calendar' | 'health';

const PLANNER_VIEW_KEY = 'parvane:planner-tab';
const VIEW_VALUES: Record<PlannerView, string> = { today: '0', calendar: '1', health: '2' };

function readPlannerView(): PlannerView {
  try {
    const saved = localStorage.getItem(PLANNER_VIEW_KEY);
    return (Object.keys(VIEW_VALUES) as PlannerView[]).find((view) => VIEW_VALUES[view] === saved) || 'today';
  } catch {
    return 'today';
  }
}

const [getPlannerView, setPlannerViewSignal] = createSignal<PlannerView>(readPlannerView());

export { getParvaneSection, getPlannerAddRequest, getPlannerView };

export function setPlannerView(view: PlannerView) {
  setPlannerViewSignal(view);
  try {
    localStorage.setItem(PLANNER_VIEW_KEY, VIEW_VALUES[view]);
  } catch {
    // Экран просто не запомнится
  }
}

export function openPlannerView(view: PlannerView) {
  setPlannerView(view);
  setParvaneSection('planner');
}

export function setParvaneSection(section: ParvaneSection) {
  if (getParvaneSection() === section) return;
  setSignal(section);
}

export function requestPlannerAdd() {
  setParvaneSection('planner');
  setPlannerAddRequest(true);
}

export function consumePlannerAddRequest() {
  setPlannerAddRequest(false);
}
