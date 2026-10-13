import type { PlannerCalendarView } from '../components/parvane/planner/plannerModel';

import { createSignal } from './signals';

// Parvane (spec 009): раздел приложения, выбранный в нижней части боковой
// панели. Мессенджер остаётся смонтированным (звонки, синхронизация) — раздел
// только решает, что показано справа от панели
export type ParvaneSection = 'messenger' | 'planner' | 'cloud';

// Раздел переживает обновление страницы в этой вкладке; новая вкладка открывается на чатах
const SECTION_KEY = 'parvane:section';
const SECTIONS: ParvaneSection[] = ['messenger', 'planner', 'cloud'];

function readSection(): ParvaneSection {
  try {
    const saved = sessionStorage.getItem(SECTION_KEY) as ParvaneSection | null;
    return saved && SECTIONS.includes(saved) ? saved : 'messenger';
  } catch {
    return 'messenger';
  }
}

const [getParvaneSection, setSignal] = createSignal<ParvaneSection>(readSection());
// Запрос «новая запись»: окно ввода текстом «Плана». `text` — заготовка строки; `isInPlace` — окно
// показывает раздел, из которого пришёл запрос («Знания»), и после записи пользователь остаётся в нём.
// Запрос забирает тот, кто показывает окно: «План» либо `PlannerQuickHost` открытого раздела
export type PlannerAddRequest = { text?: string; isInPlace?: boolean };
const [getPlannerAddRequest, setPlannerAddRequest] = createSignal<PlannerAddRequest | undefined>(undefined);

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

// Выбранный день «Плана» и вид календаря — в сигналах, а не в состоянии раздела: при переключении разделов
// раздел размонтируется, и при возврате открывается на том же дне и виде. Нет значения — «сегодня» и
// сохранённый на устройстве вид (их знает сам раздел)
const [getPlannerPickedDay, setPlannerPickedDaySignal] = createSignal<string | undefined>(undefined);
const [getPlannerCalendarView, setPlannerCalendarViewSignal] = createSignal<PlannerCalendarView | undefined>(
  undefined,
);

export {
  getParvaneSection, getPlannerAddRequest, getPlannerView, getPlannerPickedDay, getPlannerCalendarView,
};

export function setPlannerPickedDay(day: string) {
  setPlannerPickedDaySignal(day);
}

export function setPlannerCalendarView(view: PlannerCalendarView) {
  setPlannerCalendarViewSignal(view);
}

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
  try {
    sessionStorage.setItem(SECTION_KEY, section);
  } catch {
    // Раздел просто не запомнится
  }
}

/**
 * Открыть «План» с окном ввода текстом; `text` — заготовка строки. Функцию ставят и обработчиком нажатия
 * (тогда аргументом приходит событие), поэтому текстом считается только строка.
 */
export function requestPlannerAdd(text?: unknown) {
  setParvaneSection('planner');
  setPlannerAddRequest({ text: typeof text === 'string' ? text : undefined });
}

/**
 * Окно ввода текстом поверх раздела «Знания» («Запланировать» в заметке): раздел не меняется. Из раздела,
 * который окно не держит, запрос открывает «План», как `requestPlannerAdd`.
 */
export function requestPlannerAddInPlace(text: string) {
  if (getParvaneSection() !== 'cloud') {
    requestPlannerAdd(text);
    return;
  }
  setPlannerAddRequest({ text, isInPlace: true });
}

/** Окно ввода с готовой строкой («Записать сон» в общем поиске). */
export function requestPlannerAddText(text: string) {
  requestPlannerAdd(text);
}

/** Снять запрос новой записи. */
export function consumePlannerAddRequest() {
  setPlannerAddRequest(undefined);
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

// «Контакты», открытые из «Профиля»: «назад» возвращает в «Профиль», а не к списку чатов
let isContactsFromProfile = false;

export function markContactsFromProfile(isFromProfile: boolean) {
  isContactsFromProfile = isFromProfile;
}

export function getIsContactsFromProfile() {
  return isContactsFromProfile;
}
