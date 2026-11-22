import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { PlannerCalendarView } from './plannerModel';
import type { PlannerMenuTarget } from './PlannerRecordMenu';
import type { PlannerSection } from './PlannerSections';
import type { SwipePoint } from './plannerSwipe';
import type { PlannerFormParams } from './PlannerTaskForm';
import type { PlannerTasksTab } from './PlannerTasks';

import buildClassName from '../../../util/buildClassName';
import captureKeyboardListeners from '../../../util/captureKeyboardListeners';
import {
  consumePlannerAddRequest, consumePlannerImportRequest, getIsParvaneScreenShown, getParvaneSection,
  getPlannerAddRequest, getPlannerCalendarView, getPlannerImportRequest, getPlannerPickedDay, getPlannerView,
  setParvaneNavCovered, setParvaneSection, setPlannerCalendarView, setPlannerPickedDay, setPlannerView,
} from '../../../util/parvaneSection';
import { getHealthDays, watchHealthDays } from '../health/healthStore';
import { consumePlannerRecordRequest, getPlannerRecordRequest } from '../palette/paletteOpen';
import { consumePlannerDayRequest, getPlannerDayRequest } from '../taskOffer/taskOfferOpen';
import {
  formatDay, formatDayHeading, formatDayLabel, formatMonth, formatPeriod, formatSpan, formatWeekRange,
} from './plannerFormat';
import { getDayBudget } from './plannerHealth';
import { withHealthDays } from './plannerHealthDays';
import {
  applyLayers, getEffectiveLayers, getPlannerLayerPrefs,
} from './plannerLayers';
import { getMenuTarget } from './plannerMenuTarget';
import {
  detachInstance, eventInstance, fromDayKey, getDayEntry, getUndatedTasks, getWeekKeys, hasInstanceOn,
  instanceKey, PLANNER_CALENDAR_VIEWS, shiftPeriod, taskInstance, toDayKey,
} from './plannerModel';
import { findRecord, moveRecord } from './plannerRecordActions';
import { openPlannerSettingsPage } from './plannerSettingsOpen';
import {
  getHasQuickLines, getIsPlannerCached, getIsPlannerLoaded, getPlannerNotice, getPlannerSizeBytes, getPlannerState,
  getPlannerStatus,
  loadPlanner, retryPlanner, setPlannerActive, undoPlanner, updatePlanner,
} from './plannerStore';
import { getSwipeDelta, isSwipeBlocked } from './plannerSwipe';
import usePlannerHotkeys from './usePlannerHotkeys';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';
import useWindowSize from '../../../hooks/window/useWindowSize';

import Icon from '../../common/icons/Icon';
import PvLoading from '../notes/PvLoading';
import PvOfflineBar from '../notes/PvOfflineBar';
import PvResizer, { PLANNER_SIDE_MAX, PLANNER_SIDE_MIN } from '../notes/PvResizer';
import SectionHistoryBack from '../SectionHistoryBack';
import PlannerAgenda from './PlannerAgenda';
import { PLANNER_SIDE_FORM_ID } from './PlannerCardRow';
import PlannerDay from './PlannerDay';
import PlannerDayPanel from './PlannerDayPanel';
import PlannerDayStrip from './PlannerDayStrip';
import PlannerEditorDay from './PlannerEditorDay';
import PlannerEventEditor from './PlannerEventEditor';
import PlannerHeader from './PlannerHeader';
import PlannerImport from './PlannerImport';
import PlannerLayersColumn from './PlannerLayersColumn';
import PlannerMonth from './PlannerMonth';
import PlannerQuickInput from './PlannerQuickInput';
import PlannerRail from './PlannerRail';
import PlannerRecordMenu from './PlannerRecordMenu';
import PlannerSearch from './PlannerSearch';
import PlannerSections from './PlannerSections';
import PlannerTaskEditor from './PlannerTaskEditor';
import PlannerTaskForm from './PlannerTaskForm';
import PlannerTasks from './PlannerTasks';
import PlannerWeek from './PlannerWeek';
import PlannerWeekList from './PlannerWeekList';
import PlannerYear from './PlannerYear';

import pvStates from '../notes/PvStates.module.scss';
import styles from './Planner.module.scss';
import pv from './PlannerPv.module.scss';

type SwipePeriod = 'day' | 'week' | 'month';
// Экраны поверх видов: «Задачи», поиск по «Плану», «Расписание на неделю»
type PlannerScreen = 'tasks' | 'search' | 'import';

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// 75 % потолка открытого текста снимка контейнера (1 МиБ, spec 010 R5)
const NEW_NAME_ID = 'planner-new-name';
const FORM_FOCUS_DELAY_MS = 250;
const SNAPSHOT_WARN_BYTES = 786432;
// Пункт «День» в переключателе вида: экран дня (в сигналах раздела он зовётся `today`)
const SEGMENT_TODAY = 'today';
const CALENDAR_VIEW_KEY = 'parvane:planner-view';
const CALENDAR_VIEW_LABELS = {
  year: 'PlannerCalYear',
  month: 'PlannerCalMonth',
  week: 'PlannerCalWeek',
  day: 'PlannerCalDay',
  agenda: 'PlannerCalAgenda',
} as const satisfies Record<PlannerCalendarView, string>;
const MS_IN_SECOND = 1000;
const MINUTES_IN_HOUR = 60;
// Ширина, до которой раскладка — одна колонка (`Planner.module.scss`, 925px)
const NARROW_WIDTH = 925;
const PHONE_WIDTH = 600;

// Вид календаря — настройка устройства; хранилище может быть недоступно
function readCalendarView(): PlannerCalendarView {
  try {
    const saved = localStorage.getItem(CALENDAR_VIEW_KEY) as PlannerCalendarView;
    return PLANNER_CALENDAR_VIEWS.includes(saved) ? saved : 'month';
  } catch (err) {
    return 'month';
  }
}

function saveCalendarView(view: PlannerCalendarView) {
  try {
    localStorage.setItem(CALENDAR_VIEW_KEY, view);
  } catch (err) {
    // Вид просто не запомнится
  }
}

function msUntilTomorrow() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + MS_IN_SECOND;
}

// Parvane: модуль «План» по макету spec 041 — виды «День / Неделя / Месяц / Год / Список» в одном переключателе.
// Компьютер: слева колонка с месяцем и делами выбранного дня (неделя и месяц), справа карточка записи;
// телефон: одна колонка, карточка записи и настройки — на весь экран поверх ленты модулей
// Курсор ставится в поле названия, только если человек ещё не начал заполнять форму сам
function focusNewName() {
  const field = document.getElementById(NEW_NAME_ID);
  if (!field || field.closest('[data-planner-side]')?.contains(document.activeElement)) return;
  field.focus();
}

const Planner = () => {
  const lang = useLang();

  const ownState = useDerivedState(getPlannerState);
  // Сон, еда и тренировки в календаре — из модуля «Здоровье» (spec 041 B4); без модуля «План» их не показывает
  const healthDays = useDerivedState(getHealthDays);
  const { enabled: enabledModules, prefs: modulePrefs } = useParvaneModules();
  const isHealthOn = enabledModules.includes('health');
  const state = useMemo(
    () => withHealthDays(ownState, isHealthOn ? healthDays : undefined),
    [ownState, healthDays, isHealthOn],
  );
  useEffect(() => {
    if (isHealthOn) watchHealthDays();
  }, [isHealthOn]);
  const isLoaded = useDerivedState(getIsPlannerLoaded);
  // Снимок с устройства, пока движок не поднялся: показывается, правки ждут загрузки
  const isCached = useDerivedState(getIsPlannerCached);
  const hasContent = isLoaded || isCached;
  const notice = useDerivedState(getPlannerNotice);
  const syncStatus = useDerivedState(getPlannerStatus);
  const sizeBytes = useDerivedState(getPlannerSizeBytes);
  const hasQuickLines = useDerivedState(getHasQuickLines);
  // «План» загружен и принимает правки: словарь правок и история ввода текстом читаются из него
  const isSynced = isLoaded && (syncStatus === 'ready' || syncStatus === 'offline');

  const [today, setToday] = useState(() => toDayKey(new Date()));
  // Экран раздела общий с боковой панелью (`util/parvaneSection.ts`)
  const view = useDerivedState(getPlannerView);
  // Вид календаря и выбранный день живут в сигналах (`util/parvaneSection.ts`): раздел, размонтированный при
  // переключении, возвращается на то же место; до первого выбора — сохранённый вид и «сегодня»
  const [savedCalendarView] = useState(readCalendarView);
  const sessionCalendarView = useDerivedState(getPlannerCalendarView);
  const calendarView = sessionCalendarView || savedCalendarView;
  const layerPrefs = useDerivedState(getPlannerLayerPrefs);
  // Якорь периода: выбранный день; месяц, неделя и год берутся от него
  const pickedDay = useDerivedState(getPlannerPickedDay);
  const picked = pickedDay || today;
  const setPicked = setPlannerPickedDay;
  // Редактор задачи: id и день экземпляра ряда (spec 011); редактор события — то же
  const [editor, setEditor] = useState<{ id: string; day?: string }>();
  const [eventEditor, setEventEditor] = useState<{ id: string; day: string }>();
  const [formParams, setFormParams] = useState<PlannerFormParams>();
  const [screen, setScreen] = useState<PlannerScreen>();
  const [tasksTab, setTasksTab] = useState<PlannerTasksTab>('undated');
  // Меню по правой кнопке: запись либо пустое место шкалы (компьютер, доска `ZdPlanX`)
  const [menuTarget, setMenuTarget] = useState<PlannerMenuTarget>();
  // Начатый жест листания (телефон): что листается и где палец коснулся экрана
  const swipeRef = useRef<{ period: SwipePeriod; start: SwipePoint }>();
  const contentRef = useRef<HTMLDivElement>();

  const currentUserId = useSelector(selectCurrentUserId);
  const { width: windowWidth } = useWindowSize();
  const isNarrow = windowWidth <= NARROW_WIDTH;
  // Телефон: в шапке помещаются три чипа вида, остальное — в меню «⋯»; у «Года» шапка своя (доски `PhonePlan`,
  // `XpPlan`)
  const isPhone = windowWidth <= PHONE_WIDTH;
  // Слои календаря и выключенные группы: виды календаря показывают состояние без них
  const layers = useMemo(
    () => getEffectiveLayers(layerPrefs.layers, isHealthOn, modulePrefs.healthBlocks, isNarrow),
    [layerPrefs.layers, isHealthOn, modulePrefs.healthBlocks, isNarrow],
  );
  const calendarState = useMemo(
    () => applyLayers(state, layers, layerPrefs.groupsOff),
    [state, layers, layerPrefs.groupsOff],
  );

  useEffect(() => {
    void loadPlanner(currentUserId);
  }, [currentUserId]);

  // Раздел на экране: провайдер опрашивает движок чаще, скрыт — реже
  // Зависимости — сигналы раздела: по ним значение пересчитывается
  // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  const isShown = useDerivedState(() => getIsParvaneScreenShown('planner'), [getParvaneSection]);
  useEffect(() => {
    if (!isShown) return undefined;
    setPlannerActive(true);
    return () => setPlannerActive(false);
  }, [isShown]);

  // Смена суток при открытом «Плане»: «сегодня» и завершённость вчерашнего дня обновляются сами
  useEffect(() => {
    const timer = window.setTimeout(() => setToday(toDayKey(new Date())), msUntilTomorrow());
    return () => window.clearTimeout(timer);
  }, [today]);

  const pickDay = useLastCallback((day: string) => {
    // День из запроса снаружи (карточка задания в чате) мог прийти не датой — тогда выбор не меняется
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day)) return;
    setPicked(day);
    // Открытая форма создания следует за выбранным днём
    if (formParams) setFormParams({ ...formParams, day, slot: undefined });
  });

  const closeEditors = useLastCallback(() => {
    setEditor(undefined);
    setEventEditor(undefined);
  });

  const handleOpenTask = useLastCallback((taskId: string, day?: string) => {
    const task = state.tasks.find(({ id }) => id === taskId);
    const target = day || task?.day;
    if (target) pickDay(target);
    setEventEditor(undefined);
    setFormParams(undefined);
    setEditor({ id: taskId, day: task?.repeat ? day : undefined });
  });

  // Карточка после правки ряда переходит на запись, созданную этой же правкой (отделённый день, продолжение
  // ряда): в отрисованном состоянии её ещё нет — запись берётся из хранилища. Экземпляр открывается, только
  // если ряд даёт его в этот день, иначе — шаблон ряда
  const handleReopenTask = useLastCallback((taskId: string, day?: string) => {
    const task = getPlannerState().tasks.find(({ id }) => id === taskId);
    const instanceDay = task?.repeat && day && hasInstanceOn(task, day) ? day : undefined;
    const target = instanceDay || task?.day;
    if (target) pickDay(target);
    setEditor({ id: taskId, day: instanceDay });
  });

  const handleOpenEvent = useLastCallback((eventId: string, day: string) => {
    setEditor(undefined);
    setFormParams(undefined);
    setEventEditor({ id: eventId, day });
  });

  // Перетаскивание экземпляра ряда на другой день — «только это» (отделение)
  const handleMoveTask = useLastCallback((taskKey: string, day: string) => {
    const [taskId, fromDay] = taskKey.split('@');
    const task = state.tasks.find(({ id }) => id === taskId);
    if (!task || task.day === day || (task.repeat && !fromDay) || fromDay === day) return;
    updatePlanner((draft) => {
      if (task.repeat) detachInstance(draft, 'task', taskId, fromDay, { day });
      else draft.tasks.find(({ id }) => id === taskId)!.day = day;
    }, lang('PlannerNoticeMoved', { date: formatDay(lang, day), name: task.name }));
  });

  const openForm = useLastCallback((params: PlannerFormParams) => {
    closeEditors();
    setFormParams(params);
  });

  const handleCreateForDay = useLastCallback((day: string) => {
    setPicked(day);
    openForm({ day });
  });

  // Нажатие на свободное время в сетке дня: новое дело с этого времени на час (либо до `end`: окно из
  // «Найти свободное время» меню шкалы)
  const handleCreateAt = useLastCallback((day: string, start: number, end?: number) => {
    setPicked(day);
    openForm({ day, slot: { day, start, end: end ?? start + MINUTES_IN_HOUR } });
  });

  const handleContextMenu = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const element = e.target as HTMLElement;
    // Поля ввода и карточка записи оставляют меню браузера
    if (isNarrow || !isLoaded || element.closest('input, textarea, [data-planner-side]')) return;
    const target = getMenuTarget(element, e.clientX, e.clientY);
    if (!target) return;
    e.preventDefault();
    setMenuTarget(target);
  });

  const handleCloseMenu = useLastCallback(() => {
    setMenuTarget(undefined);
  });

  // Задача из колонки «Без времени» на шкале дня: день и время по месту броска
  const handlePlaceTask = useLastCallback((taskKey: string, day: string, minute: number) => {
    const [id, instanceDay] = taskKey.split('@');
    const record = findRecord(state, { kind: 'task', id, day: instanceDay });
    if (record) moveRecord(lang, record, today, 'place', day, minute);
  });

  const handleAddToDay = useLastCallback(() => {
    openForm({ day: picked });
  });

  // На компьютере после создания открывается карточка новой задачи; на телефоне шторка просто закрывается —
  // запись сразу видна в дне
  const handleCreated = useLastCallback((taskId?: string, day?: string) => {
    setFormParams(undefined);
    if (taskId !== undefined && !isNarrow) handleOpenTask(taskId, day);
    else closeEditors();
  });

  const handleCancelCreate = useLastCallback(() => {
    setFormParams(undefined);
  });

  // Значок сна в календаре ведёт в модуль «Здоровье»
  const handleOpenSleep = useLastCallback(() => {
    setPlannerView('health');
  });

  // Настройки «Плана» — страница «Профиль → Модули / План» (доски `RdPlanSet`, `PhModSettings`)
  const handleOpenSettings = useLastCallback(() => {
    openPlannerSettingsPage();
  });

  const changePeriod = useLastCallback((delta: number) => {
    pickDay(shiftPeriod(view === 'calendar' ? calendarView : 'day', picked, delta));
  });

  const handlePrevPeriod = useLastCallback(() => changePeriod(-1));
  const handleNextPeriod = useLastCallback(() => changePeriod(1));

  // Телефон: горизонтальный свайп листает то, что названо в `data-swipe` под пальцем, — дни, недели, месяцы
  const handleTouchStart = useLastCallback((e: React.TouchEvent<HTMLDivElement>) => {
    swipeRef.current = undefined;
    const target = e.target as HTMLElement;
    const period = target.closest<HTMLElement>('[data-swipe]')?.dataset.swipe as SwipePeriod | undefined;
    if (!isNarrow || !period || e.touches.length !== 1 || isSwipeBlocked(target, e.currentTarget)) return;
    swipeRef.current = { period, start: { x: e.touches[0].clientX, y: e.touches[0].clientY } };
  });

  const handleTouchEnd = useLastCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current;
    swipeRef.current = undefined;
    const touch = e.changedTouches[0];
    if (!swipe || !touch) return;
    const delta = getSwipeDelta(swipe.start, { x: touch.clientX, y: touch.clientY });
    if (delta) pickDay(shiftPeriod(swipe.period, picked, delta));
  });

  const handleToday = useLastCallback(() => {
    pickDay(today);
  });

  const handleSwitchCalendarView = useLastCallback((next: PlannerCalendarView) => {
    setPlannerView('calendar');
    setPlannerCalendarView(next);
    saveCalendarView(next);
  });

  // Переключатель вида: «Сегодня» — экран дня, остальные пункты — виды календаря
  const handleSwitchSegment = useLastCallback((next: string) => {
    if (next === SEGMENT_TODAY) setPlannerView('today');
    else handleSwitchCalendarView(next as PlannerCalendarView);
  });

  // Число дня в неделе телефона открывает этот день
  const handleOpenDay = useLastCallback((day: string) => {
    pickDay(day);
    setPlannerView('today');
  });

  // Нажатие на день в виде «Год» открывает месяц этого дня
  const handleOpenMonth = useLastCallback((day: string) => {
    pickDay(day);
    handleSwitchCalendarView('month');
  });

  const handleCloseSide = useLastCallback(() => {
    setFormParams(undefined);
    closeEditors();
  });

  const handleScrimClick = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) handleCloseSide();
  });

  // Другой вид открывается с начала: прокрутка прежнего вида на него не переносится
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [view, calendarView]);

  const handleUndo = useLastCallback(() => {
    undoPlanner(lang('PlannerNoticeUndone'));
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
      e.preventDefault();
      handleUndo();
    }
  });

  const editedTemplate = editor && state.tasks.find(({ id }) => id === editor.id);
  const editedTask = editedTemplate && editor.day && editedTemplate.repeat
    ? taskInstance(editedTemplate, editor.day) : editedTemplate;
  const editedEventTemplate = eventEditor && state.events.find(({ id }) => id === eventEditor.id);
  const editedEvent = editedEventTemplate && editedEventTemplate.repeat
    ? eventInstance(editedEventTemplate, eventEditor.day) : editedEventTemplate;
  // Форма и карточка записи — справа на месте дня (телефон — на весь экран)
  const side = !isLoaded ? undefined
    : formParams ? 'form' : editedTask ? 'task' : editedEvent ? 'event' : undefined;
  const isSheet = Boolean(side) && isNarrow;
  // Компьютер: карточка задачи и события — крупно на месте вида, слева дела её дня (доска `DkPlanMore`)
  const isWideEditor = !isNarrow && (side === 'task' || side === 'event');
  // Карточка записи на телефоне — на весь экран: ленты модулей и «+» под ними нет
  const isNavCovered = isShown && isNarrow && Boolean(side || screen);
  useEffect(() => {
    setParvaneNavCovered(isNavCovered);
    return () => setParvaneNavCovered(false);
  }, [isNavCovered]);
  // Месяц — один объект на месяц выбранного дня: иначе `memo` сетки месяца не срабатывал бы никогда
  const monthKey = picked.slice(0, 7);
  const month = useMemo(() => {
    const date = fromDayKey(picked);
    return new Date(date.getFullYear(), date.getMonth(), 1);
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [monthKey]);
  // spec 010: строка состояния синхронизации — только когда есть что сказать
  // Нет связи: показан снимок с устройства либо движок работает без сервера — общая полоса с «Повторить»
  const isOffline = (!isLoaded && isCached) || syncStatus === 'offline';
  const syncNoticeKey = isOffline ? undefined
    : syncStatus === 'needs-linking' ? 'PlannerNeedsLinking'
      : syncStatus === 'no-key' ? 'PlannerSyncPending'
        : sizeBytes > SNAPSHOT_WARN_BYTES ? 'PlannerNearLimit' : undefined;
  const isToday = view === 'today';
  const isCalendar = view === 'calendar';
  const isMonthView = calendarView === 'month';
  const isWeekView = calendarView === 'week';
  // Сетка недели на компьютере листается сама, а шапки дней стоят на месте; на телефоне под полосой дней
  // листается день
  const isFlush = hasContent && !isNarrow && (isToday || (isCalendar && isWeekView));
  const calendarSegments = useMemo(() => [
    { value: SEGMENT_TODAY, label: lang('PlannerCalDay') },
    ...PLANNER_CALENDAR_VIEWS.map((item) => ({ value: item, label: lang(CALENDAR_VIEW_LABELS[item]) })),
  ], [lang]);
  const weekDays = useMemo(() => getWeekKeys(picked), [picked]);
  const periodTitle = isToday
    ? formatDayHeading(lang, picked, today)
    : isWeekView ? formatWeekRange(lang, picked) : formatPeriod(lang, calendarView, picked);
  // Загрузка выбранного дня в шапке вида «День» на компьютере
  const dayLoad = isToday && hasContent && !isNarrow ? lang('PlannerLoadOf', {
    planned: formatSpan(getDayEntry(state, picked).minutes), budget: formatSpan(getDayBudget(state, picked)),
  }) : undefined;
  // Колонка с месяцем — у недели; «Месяц» на компьютере — сетка на всю ширину (доска `RdPlan`)
  const isRailShown = hasContent && !isNarrow && !screen && isCalendar && isWeekView;

  // «Без даты» в левой колонке и в виде «День» открывает экран «Задачи» на этом разделе
  const openUndated = useLastCallback(() => {
    setTasksTab('undated');
    setScreen('tasks');
  });

  const handleOpenTasks = useLastCallback(() => {
    setScreen('tasks');
  });

  const handleOpenSearch = useLastCallback(() => {
    setScreen('search');
  });

  const handleCloseScreen = useLastCallback(() => {
    setScreen(undefined);
  });

  // Колонка разделов на компьютере: «Сегодня» и «Календарь» — к видам, остальное — экраны. У «Расписания» колонки
  // нет (доска `XdPlan`)
  const isSectionsShown = hasContent && !isNarrow && screen === 'tasks';
  // Колонка «Слои / Что показывать» слева у вида «День» на компьютере (доска `ZdPlanX`); у поиска она своя
  const isLayersShown = hasContent && !isNarrow && !screen && isToday;
  const undatedCount = useMemo(() => (isSectionsShown ? getUndatedTasks(state).length : 0), [isSectionsShown, state]);

  const handleSelectSection = useLastCallback((section: PlannerSection) => {
    if (section === 'settings') {
      handleOpenSettings();
      return;
    }
    if (section === 'today' || section === 'calendar') {
      setScreen(undefined);
      if (section === 'today') setPlannerView('today');
      else handleSwitchCalendarView(calendarView);
      return;
    }
    if (section === 'import') {
      setScreen('import');
      return;
    }
    setTasksTab(section);
    setScreen('tasks');
  });

  // Escape закрывает экран, если «План» на экране, поверх нет окна (закрывающееся не в счёт) и нажатие не в
  // карточке записи. Обработчик стоит в общей очереди Escape (`captureKeyboardListeners`) последним: слушатели
  // других модулей, оставшиеся смонтированными, раньше перехватывали клавишу, и экран не закрывался
  const handleScreenEscape = useLastCallback((e: KeyboardEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : undefined;
    if (!getIsParvaneScreenShown('planner') || document.querySelector('.Modal:not(.closing)')
      || target?.closest('[data-planner-side]')) {
      return false;
    }
    setScreen(undefined);
    return undefined;
  });
  // Слушатель встаёт в кадре появления экрана: поставленный обычным эффектом, он пропускал Escape, нажатый сразу
  useLayoutEffect(() => (screen ? captureKeyboardListeners({ onEsc: handleScreenEscape }) : undefined), [screen]);

  // Кнопка «+» нижней панели телефона и «+ Запись» в шапке: запись одной строкой (spec 017).
  // Полная форма — по «Подробнее» в окне ввода, по «Добавить на этот день» и по нажатию на свободное время
  const [isQuickOpen, openQuick, closeQuick] = useFlag();
  // Запрос «на месте» (`isInPlace`) — окно поверх «Знаний», его держит `PlannerQuickHost`; раздел его не
  // трогает, иначе оба смонтированных раздела открыли бы окно разом (E1)
  const addRequest = useDerivedState(getPlannerAddRequest);
  useEffect(() => {
    if (!addRequest || addRequest.isInPlace || !isLoaded) return;
    consumePlannerAddRequest();
    // «Подробнее» окна поверх другого модуля — сразу полная форма
    if (addRequest.isMore) {
      handleQuickMore();
      return;
    }
    handleQuickText(addRequest.text || '');
  }, [addRequest, isLoaded]);

  // «Расписание на неделю» со страницы «Модули / План» на телефоне: экран импорта на месте видов
  const importRequest = useDerivedState(getPlannerImportRequest);
  useEffect(() => {
    if (!importRequest || !isLoaded) return;
    consumePlannerImportRequest();
    handleCloseSide();
    setScreen('import');
  }, [importRequest, isLoaded]);

  // «В плане · открыть» на карточке в чате: «План» открывается на дне записи
  const dayRequest = useDerivedState(getPlannerDayRequest);
  useEffect(() => {
    if (!dayRequest) return;
    consumePlannerDayRequest();
    pickDay(dayRequest);
  }, [dayRequest]);

  // Запись, выбранная в общем поиске (Ctrl+K): её день и карточка
  const recordRequest = useDerivedState(getPlannerRecordRequest);
  useEffect(() => {
    if (!recordRequest || !isLoaded) return;
    consumePlannerRecordRequest();
    const { kind, id, day } = recordRequest;
    if (kind === 'task') {
      handleOpenTask(id, day);
      return;
    }
    if (day) pickDay(day);
    if (kind === 'event' && day) handleOpenEvent(id, day);
  }, [recordRequest, isLoaded]);

  const [quickText, setQuickText] = useState('');

  const handleOpenQuick = useLastCallback(() => {
    setQuickText('');
    openQuick();
  });

  // N, T, ← →, Пробел (доска `ZdNav`) — пока открыт вид без карточки, формы, экрана и окна ввода
  usePlannerHotkeys(isShown && isLoaded && !side && !screen && !isQuickOpen, {
    onNew: handleOpenQuick, onToday: handleToday, onPrev: handlePrevPeriod, onNext: handleNextPeriod,
  });

  // «+» у задач и «Еда» у расписания открывают ввод с началом строки
  const handleQuickText = useLastCallback((text: string) => {
    setQuickText(text);
    openQuick();
  });

  const handleQuickCreated = useLastCallback((day?: string) => {
    closeQuick();
    if (day) pickDay(day);
  });

  // Полная форма открывается сбоку на месте дня: курсор уходит в её первое поле, а панель коротко
  // подсвечивается — иначе кажется, что окно ввода просто закрылось
  const handleQuickMore = useLastCallback(() => {
    closeQuick();
    handleAddToDay();
    window.setTimeout(focusNewName, FORM_FOCUS_DELAY_MS);
  });

  function renderHeader() {
    return (
      <PlannerHeader
        title={periodTitle}
        load={dayLoad}
        isYear={isCalendar && calendarView === 'year'}
        picked={picked}
        today={today}
        isNarrow={isNarrow}
        isPhone={isPhone}
        segments={calendarSegments}
        activeSegment={isToday ? SEGMENT_TODAY : calendarView}
        prevLabel={lang(isMonthView && isCalendar ? 'PlannerPrevMonth' : 'PlannerPrevPeriod')}
        nextLabel={lang(isMonthView && isCalendar ? 'PlannerNextMonth' : 'PlannerNextPeriod')}
        onPrev={handlePrevPeriod}
        onNext={handleNextPeriod}
        onToday={handleToday}
        onPickDay={pickDay}
        onSwitchSegment={handleSwitchSegment}
        settings={state.settings}
        learnedWords={state.learned}
        onOpenQuick={handleOpenQuick}
        onQuickMore={handleQuickText}
        onQuickCreated={handleQuickCreated}
        onOpenSearch={handleOpenSearch}
        onOpenTasks={handleOpenTasks}
        onOpenSettings={handleOpenSettings}
      />
    );
  }

  // Телефон: строка периода под шапкой — месяц либо год со стрелками и «Текущая дата»
  function renderPeriod() {
    return (
      <div className={pv.period}>
        <span className={pv.periodTitle}>
          {isMonthView ? formatMonth(lang, month) : String(month.getFullYear())}
        </span>
        {picked !== today && (
          <button type="button" className={pv.today} onClick={handleToday}>{lang('PlannerJumpToday')}</button>
        )}
        <button
          type="button"
          className={pv.navButton}
          aria-label={lang(isMonthView ? 'PlannerPrevMonth' : 'PlannerPrevYear')}
          onClick={handlePrevPeriod}
        >
          <Icon name="previous" />
        </button>
        <button
          type="button"
          className={pv.navButton}
          aria-label={lang(isMonthView ? 'PlannerNextMonth' : 'PlannerNextYear')}
          onClick={handleNextPeriod}
        >
          <Icon name="next" />
        </button>
      </div>
    );
  }

  function renderCalendar() {
    if (calendarView === 'agenda') {
      return (
        <PlannerAgenda
          state={calendarState}
          day={isNarrow ? today : picked}
          today={today}
          isNarrow={isNarrow}
          onPickDay={pickDay}
          onOpenTask={handleOpenTask}
          onOpenEvent={handleOpenEvent}
        />
      );
    }
    if (calendarView === 'year') {
      return (
        <PlannerYear
          state={calendarState}
          year={month.getFullYear()}
          picked={picked}
          today={today}
          isNarrow={isNarrow}
          onOpenMonth={handleOpenMonth}
        />
      );
    }
    if (isMonthView) {
      return (
        <>
          <div data-swipe="month">
            <PlannerMonth
              state={calendarState}
              month={month}
              picked={picked}
              today={today}
              layers={layers}
              isNarrow={isNarrow}
              onPickDay={pickDay}
              onCreateForDay={handleCreateForDay}
              onOpenTask={handleOpenTask}
              onMoveTask={handleMoveTask}
            />
          </div>
          {isNarrow && (
            <>
              <p className={styles.monthHint}>{lang('PlannerMonthLoadHint')}</p>
              <div className={styles.monthDay}>
                <PlannerDayPanel
                  state={calendarState}
                  day={picked}
                  today={today}
                  layers={layers}
                  variant="list"
                  onOpenTask={handleOpenTask}
                  onOpenEvent={handleOpenEvent}
                />
              </div>
            </>
          )}
        </>
      );
    }
    if (isNarrow) {
      return (
        <div data-swipe="week">
          <PlannerWeekList
            state={calendarState}
            days={weekDays}
            picked={picked}
            today={today}
            onOpenDay={handleOpenDay}
            onOpenTask={handleOpenTask}
            onOpenEvent={handleOpenEvent}
          />
        </div>
      );
    }
    return (
      <PlannerWeek
        state={calendarState}
        days={weekDays}
        picked={picked}
        today={today}
        layers={layers}
        onPickDay={pickDay}
        onCreateForDay={handleCreateForDay}
        onCreateAt={handleCreateAt}
        onOpenTask={handleOpenTask}
        onOpenEvent={handleOpenEvent}
        onOpenSleep={handleOpenSleep}
        onPlaceTask={handlePlaceTask}
      />
    );
  }

  // Экран вместо видов: «Задачи», поиск, «Расписание на неделю»
  function renderScreen() {
    return (
      <main className={styles.page} data-planner-screen={screen}>
        {screen === 'tasks' ? (
          <PlannerTasks
            state={state}
            today={today}
            tab={tasksTab}
            isNarrow={isNarrow}
            onChangeTab={setTasksTab}
            onOpenTask={handleOpenTask}
            onOpenSearch={handleOpenSearch}
            onClose={handleCloseScreen}
          />
        ) : screen === 'search' ? (
          <PlannerSearch
            state={state}
            today={today}
            isNarrow={isNarrow}
            onOpenTask={handleOpenTask}
            onOpenEvent={handleOpenEvent}
            onClose={handleCloseScreen}
          />
        ) : (
          <PlannerImport today={today} isNarrow={isNarrow} onClose={handleCloseScreen} />
        )}
      </main>
    );
  }

  // Телефон: карточка записи — строки настроек, в шапке «Запись» и «Сохранить» (доска `PhPlanMore`). Задача и
  // событие сохраняются по месту, «Сохранить» их закрывает; новая запись — отправка формы
  function renderPhoneSideHeader() {
    return (
      <div className={buildClassName(styles.hdr, styles.sideHdr)}>
        <button type="button" className={styles.ib} aria-label={lang('Close')} onClick={handleCloseSide}>
          <Icon name="close" />
        </button>
        <h2 className={styles.sideTitle}>{lang(side === 'form' ? 'PlannerTitleNew' : 'PlannerTitleRecord')}</h2>
        <span className={styles.grow} />
        {side === 'task' || side === 'event' ? (
          <button type="button" className={styles.sideSave} data-side-save onClick={handleCloseSide}>
            {lang('Save')}
          </button>
        ) : (
          <button type="submit" form={PLANNER_SIDE_FORM_ID} className={styles.sideSave} data-side-save>
            {lang(side === 'form' ? 'PlannerCreate' : 'Save')}
          </button>
        )}
      </div>
    );
  }

  // Дела дня открытой записи слева от крупной карточки (компьютер)
  function renderEditorDay() {
    const record = side === 'task' ? editedTask! : editedEvent!;
    const day = side === 'task' ? editedTask!.instanceDay || editedTask!.day || picked : eventEditor!.day;
    return (
      <PlannerEditorDay
        state={calendarState}
        day={day}
        today={today}
        selectedKey={instanceKey(record)}
        onOpenTask={handleOpenTask}
        onOpenEvent={handleOpenEvent}
      />
    );
  }

  function renderSide() {
    const sideDay = side === 'task' ? editedTask!.instanceDay || editedTask!.day
      : side === 'event' ? eventEditor!.day : undefined;
    const isRows = isNarrow;
    return (
      <aside
        className={buildClassName(
          styles.side, isSheet && styles.sheetPane, isWideEditor && styles.sideWide,
        )}
        data-planner-side={side}
      >
        {!isSheet && !isWideEditor && (
          <PvResizer panel="planner-side" edge="start" min={PLANNER_SIDE_MIN} max={PLANNER_SIDE_MAX} />
        )}
        {isRows ? renderPhoneSideHeader() : (
          <div className={buildClassName(styles.hdr, styles.sideHdr)}>
            {side === 'task' || side === 'event' ? (
              <>
                <span className={buildClassName(styles.typePill, side === 'task' ? styles.kindTask : styles.kindEvent)}>
                  <Icon name={side === 'task' ? 'check' : 'calendar'} />
                  {lang(side === 'task' ? 'PlannerTitleTask' : 'PlannerTitleEvent')}
                </span>
                <span className={styles.hdrOver}>
                  {sideDay ? formatDayLabel(lang, sideDay) : side === 'task' ? lang('PlannerUndatedShort') : ''}
                </span>
              </>
            ) : (
              <h2 className={styles.sideTitle}>
                {lang('PlannerTitleNew')}
              </h2>
            )}
            <span className={styles.grow} />
            <button type="button" className={styles.ib} aria-label={lang('Close')} onClick={handleCloseSide}>
              <Icon name="close" />
            </button>
          </div>
        )}
        <div
          className={buildClassName(styles.content, styles.sideContent, isRows && styles.sideRows, 'custom-scroll')}
        >
          {side === 'form' ? (
            <PlannerTaskForm
              state={state}
              params={formParams!}
              onCreated={handleCreated}
              onCancel={handleCancelCreate}
            />
          ) : side === 'task' ? (
            <PlannerTaskEditor
              key={`${editedTask!.id}@${editedTask!.instanceDay || ''}`}
              state={state}
              task={editedTask!}
              today={today}
              picked={picked}
              onBack={closeEditors}
              onPickDay={pickDay}
              onOpenTask={handleReopenTask}
            />
          ) : (
            <PlannerEventEditor
              key={`${editedEvent!.id}@${editedEvent!.instanceDay || ''}`}
              state={state}
              event={editedEvent!}
              onBack={closeEditors}
              onOpenEvent={handleOpenEvent}
            />
          )}
        </div>
      </aside>
    );
  }

  // Системное «назад»: открытая форма, карточка записи либо настройки — закрыть, иначе — к чатам
  const handleHistoryBack = useLastCallback(() => {
    if (!side && screen) {
      setScreen(undefined);
      return true;
    }
    if (!side) {
      setParvaneSection('messenger');
      return false;
    }
    handleCloseSide();
    return true;
  });

  return (
    <div
      id="ParvanePlanner"
      className={buildClassName(styles.root, side && !isSheet && styles.withSide)}
      data-sync-status={syncStatus}
      data-loaded={isLoaded ? '1' : '0'}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      {isShown && <SectionHistoryBack onBack={handleHistoryBack} />}
      <div className={styles.body}>
        {isSectionsShown && (
          <PlannerSections
            active={tasksTab}
            undatedCount={undatedCount}
            onSelect={handleSelectSection}
          />
        )}
        {isRailShown && !isWideEditor && (
          <PlannerRail
            state={calendarState}
            picked={picked}
            today={today}
            layers={layers}
            onPickDay={pickDay}
            onOpenTask={handleOpenTask}
            onOpenEvent={handleOpenEvent}
            onOpenUndated={openUndated}
          />
        )}
        {isLayersShown && <PlannerLayersColumn state={state} variant="day" />}
        {isWideEditor ? renderEditorDay() : hasContent && screen ? renderScreen() : (
          <main className={styles.page}>
            {renderHeader()}
            {isOffline && <PvOfflineBar text={lang('PvOfflinePlan')} onRetry={retryPlanner} />}
            {syncNoticeKey && (
              <div
                className={buildClassName(
                  styles.syncNotice, syncStatus === 'needs-linking' && styles.syncNoticeBlocking,
                )}
                role="status"
              >
                {lang(syncNoticeKey)}
              </div>
            )}
            {isNarrow && hasContent && isToday && (
              <div className={styles.stripBar}>
                <PlannerDayStrip
                  state={calendarState}
                  weekStart={weekDays[0]}
                  picked={picked}
                  today={today}
                  onPickDay={pickDay}
                />
              </div>
            )}
            {isNarrow && hasContent && isCalendar && (isMonthView || (calendarView === 'year' && !isPhone))
              && renderPeriod()}
            <div
              ref={contentRef}
              className={buildClassName(styles.content, isFlush && styles.contentFlush, 'custom-scroll')}
              data-swipe={isNarrow && !isCalendar ? 'day' : undefined}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              {!hasContent ? (
                <PvLoading className={pvStates.loadingFill} onRetry={retryPlanner} />
              ) : isCalendar ? renderCalendar() : (
                <PlannerDay
                  state={calendarState}
                  day={picked}
                  today={today}
                  layers={layers}
                  isNarrow={isNarrow}
                  noAside={Boolean(side) && !isSheet}
                  onPickDay={pickDay}
                  onCreateForDay={handleCreateForDay}
                  onCreateAt={handleCreateAt}
                  onOpenTask={handleOpenTask}
                  onOpenEvent={handleOpenEvent}
                  onOpenSleep={handleOpenSleep}
                  onOpenUndated={openUndated}
                  onQuick={handleQuickText}
                  onPlaceTask={handlePlaceTask}
                />
              )}
            </div>
          </main>
        )}
        {side && !isSheet && renderSide()}
      </div>
      {side && isSheet && (
        <div
          className={styles.scrim}
          onClick={handleScrimClick}
        >
          {renderSide()}
        </div>
      )}
      {notice && (
        <div className={styles.toast} role="status">
          <span>{notice.text}</span>
          {notice.canUndo && (
            <button type="button" className={styles.toastUndo} onClick={handleUndo}>{lang('PlannerUndo')}</button>
          )}
        </div>
      )}
      {menuTarget && (
        <PlannerRecordMenu
          state={state}
          today={today}
          target={menuTarget}
          onOpenTask={handleOpenTask}
          onOpenEvent={handleOpenEvent}
          onCreateAt={handleCreateAt}
          onClose={handleCloseMenu}
        />
      )}
      <PlannerQuickInput
        isOpen={isQuickOpen}
        initialText={quickText}
        today={today}
        settings={state.settings}
        userId={currentUserId}
        learnedWords={state.learned}
        isLearnedSynced={isSynced}
        quickLines={isSynced && hasQuickLines ? state.quickLines : undefined}
        tasks={state.tasks}
        events={state.events}
        onCreated={handleQuickCreated}
        onMore={handleQuickMore}
        onClose={closeQuick}
      />
    </div>
  );
};

export default memo(Planner);
