import { createSignal } from './signals';

// Parvane (spec 009): раздел приложения, выбранный в нижней части боковой
// панели. Мессенджер остаётся смонтированным (звонки, синхронизация) — раздел
// только решает, что показано справа от панели
export type ParvaneSection = 'messenger' | 'planner' | 'cloud';

const [getParvaneSection, setSignal] = createSignal<ParvaneSection>('messenger');
// Запрос «новая запись» из нижней панели телефона: «План» открывает форму и сбрасывает запрос
const [getPlannerAddRequest, setPlannerAddRequest] = createSignal(false);

// Экран «Плана»: «Сегодня», виды календаря либо «Здоровье». «Сегодня» — первый вид «Календаря»: в боковой
// панели (компьютер) и во вкладках раздела (телефон) это одна кнопка «Календарь», а между «Сегодня» и
// неделей / месяцем / годом / списком переключает шапка календаря. Устройство помнит последний экран
export type PlannerView = 'today' | 'calendar' | 'health';
type PlannerCalendarSide = Exclude<PlannerView, 'health'>;

const PLANNER_VIEW_KEY = 'parvane:planner-tab';
// Что показывал «Календарь» в последний раз — «Сегодня» либо сетку; нужно, когда последним было «Здоровье»
const PLANNER_CALENDAR_SIDE_KEY = 'parvane:planner-calendar-tab';
const VIEW_VALUES: Record<PlannerView, string> = { today: '0', calendar: '1', health: '2' };

function readSavedView(key: string): PlannerView | undefined {
  try {
    const saved = localStorage.getItem(key);
    return (Object.keys(VIEW_VALUES) as PlannerView[]).find((view) => VIEW_VALUES[view] === saved);
  } catch {
    return undefined;
  }
}

function saveView(key: string, view: PlannerView) {
  try {
    localStorage.setItem(key, VIEW_VALUES[view]);
  } catch {
    // Экран просто не запомнится
  }
}

function readPlannerView(): PlannerView {
  return readSavedView(PLANNER_VIEW_KEY) || 'today';
}

// Записи прежних версий ключа стороны не несут: тогда сторона — последний экран, если это не «Здоровье»
function readCalendarSide(): PlannerCalendarSide {
  const side = readSavedView(PLANNER_CALENDAR_SIDE_KEY) || readPlannerView();
  return side === 'health' ? 'today' : side;
}

const [getPlannerView, setPlannerViewSignal] = createSignal<PlannerView>(readPlannerView());
let calendarSide = readCalendarSide();

export { getParvaneSection, getPlannerAddRequest, getPlannerView };

export function setPlannerView(view: PlannerView) {
  setPlannerViewSignal(view);
  saveView(PLANNER_VIEW_KEY, view);
  if (view === 'health') return;
  calendarSide = view;
  saveView(PLANNER_CALENDAR_SIDE_KEY, view);
}

/** Показать «Календарь» на том, что он показывал в последний раз: «Сегодня» либо сетка. */
export function showPlannerCalendar() {
  setPlannerView(calendarSide);
}

export function openPlannerView(view: PlannerView) {
  setPlannerView(view);
  setParvaneSection('planner');
}

/** Кнопка «Календарь» боковой панели: раздел «План» на последнем виде календаря. */
export function openPlannerCalendar() {
  showPlannerCalendar();
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

/** Открыть «Знания» на вкладке: «Облако» боковой панели — это вкладка «Файлы». */
export function openKnowledgeView(view: KnowledgeView) {
  setKnowledgeView(view);
  setParvaneSection('cloud');
}

// Запрос «открыть настройки плана» из «Профиля»: «План» открывает свои настройки и сбрасывает запрос
// (как запрос новой записи). Пока раздел запрос не читает, «Профиль» просто открывает «Сегодня»
const [getPlannerSettingsRequest, setPlannerSettingsRequest] = createSignal(false);

export { getPlannerSettingsRequest };

export function requestPlannerSettings() {
  setPlannerView('today');
  setParvaneSection('planner');
  setPlannerSettingsRequest(true);
}

export function consumePlannerSettingsRequest() {
  setPlannerSettingsRequest(false);
}
