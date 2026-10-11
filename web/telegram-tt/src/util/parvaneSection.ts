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

// Вкладка раздела «Знания»: заметки, граф связей, холст либо файлы (прежнее «Облако»)
export type KnowledgeView = 'notes' | 'graph' | 'canvas' | 'files';
export const KNOWLEDGE_VIEWS: KnowledgeView[] = ['notes', 'graph', 'canvas', 'files'];

const KNOWLEDGE_VIEW_KEY = 'parvane:knowledge-tab';

function readKnowledgeView(): KnowledgeView {
  try {
    const saved = localStorage.getItem(KNOWLEDGE_VIEW_KEY) as KnowledgeView;
    return KNOWLEDGE_VIEWS.includes(saved) ? saved : 'notes';
  } catch {
    return 'notes';
  }
}

const [getKnowledgeView, setKnowledgeViewSignal] = createSignal<KnowledgeView>(readKnowledgeView());
// Заметка, которую раздел должен открыть (ссылка из «Плана», заметка дня)
const [getNoteRequest, setNoteRequest] = createSignal<string | undefined>(undefined);

export { getKnowledgeView, getNoteRequest };

export function setKnowledgeView(view: KnowledgeView) {
  setKnowledgeViewSignal(view);
  try {
    localStorage.setItem(KNOWLEDGE_VIEW_KEY, view);
  } catch {
    // Вкладка просто не запомнится
  }
}

/** Открыть «Знания» на заметке с этим названием (нет такой — раздел создаст). */
export function openNote(title: string) {
  setNoteRequest(title);
  setKnowledgeView('notes');
  setParvaneSection('cloud');
}

export function consumeNoteRequest() {
  setNoteRequest(undefined);
}
