import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { PlannerLayer } from './plannerLayers';
import type { PlannerCalendarView } from './plannerModel';
import type { SwipePoint } from './plannerSwipe';
import type { PlannerFormParams } from './PlannerTaskForm';

import buildClassName from '../../../util/buildClassName';
import {
  consumePlannerAddRequest, consumePlannerSettingsRequest, getPlannerAddRequest, getPlannerSettingsRequest,
  getPlannerView, setPlannerView, showPlannerCalendar,
} from '../../../util/parvaneSection';
import { consumePlannerDayRequest, getPlannerDayRequest } from '../taskOffer/taskOfferOpen';
import {
  formatDay, formatDayLabel, formatPeriod, formatWeekRange,
} from './plannerFormat';
import { readLayers, saveLayers } from './plannerLayers';
import {
  addDays, detachInstance, eventInstance, fromDayKey, getWeekKeys, hasInstanceOn, PLANNER_CALENDAR_VIEWS, shiftPeriod,
  taskInstance, toDayKey,
} from './plannerModel';
import {
  getHasQuickLines, getIsPlannerLoaded, getPlannerNotice, getPlannerSizeBytes, getPlannerState, getPlannerStatus,
  loadPlanner, undoPlanner, updatePlanner,
} from './plannerStore';
import { getSwipeDelta, isSwipeBlocked } from './plannerSwipe';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import Icon from '../../common/icons/Icon';
import Loading from '../../ui/Loading';
import TabList from '../../ui/TabList';
import PlannerAgenda from './PlannerAgenda';
import PlannerDateNav from './PlannerDateNav';
import PlannerDayPanel from './PlannerDayPanel';
import PlannerDayStrip from './PlannerDayStrip';
import PlannerEventEditor from './PlannerEventEditor';
import PlannerHealth from './PlannerHealth';
import PlannerLayerChips from './PlannerLayerChips';
import PlannerMonth from './PlannerMonth';
import PlannerPeriodBar from './PlannerPeriodBar';
import PlannerQuickInput from './PlannerQuickInput';
import PlannerSettings from './PlannerSettings';
import PlannerTaskEditor from './PlannerTaskEditor';
import PlannerTaskForm from './PlannerTaskForm';
import PlannerToday from './PlannerToday';
import PlannerWeek from './PlannerWeek';
import PlannerYear from './PlannerYear';

import styles from './Planner.module.scss';

type SwipePeriod = 'day' | 'week' | 'month';

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// 75 % потолка открытого текста снимка контейнера (1 МиБ, spec 010 R5)
const NEW_NAME_ID = 'planner-new-name';
const FORM_FOCUS_DELAY_MS = 250;
const SNAPSHOT_WARN_BYTES = 786432;
// Вкладки раздела на телефоне: «Сегодня» — первый вид календаря, своей вкладки у него нет
const TAB_CALENDAR = 0;
const TAB_HEALTH = 1;
// Пункт «Сегодня» в переключателе вида календаря
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

// Parvane (spec 009): раздел «План» — календарь с загрузкой дней («Сегодня» — первый его вид, выбирается
// в том же переключателе, что неделя, месяц, год и список) и «Здоровье». Данные — запись устройства
// (plannerStore). Раскладка — острова: страница раздела и справа день календаря либо карточка
// записи; на телефоне карточка и настройки выезжают снизу
// Курсор ставится в поле названия, только если человек ещё не начал заполнять форму сам
function focusNewName() {
  const field = document.getElementById(NEW_NAME_ID);
  if (!field || field.closest('[data-planner-side]')?.contains(document.activeElement)) return;
  field.focus();
}

const Planner = () => {
  const lang = useLang();

  const state = useDerivedState(getPlannerState);
  const isLoaded = useDerivedState(getIsPlannerLoaded);
  const notice = useDerivedState(getPlannerNotice);
  const syncStatus = useDerivedState(getPlannerStatus);
  const sizeBytes = useDerivedState(getPlannerSizeBytes);
  const hasQuickLines = useDerivedState(getHasQuickLines);
  // «План» загружен и принимает правки: словарь правок и история ввода текстом читаются из него
  const isSynced = isLoaded && (syncStatus === 'ready' || syncStatus === 'offline');

  const [today, setToday] = useState(() => toDayKey(new Date()));
  // Экран раздела общий с боковой панелью (`util/parvaneSection.ts`)
  const view = useDerivedState(getPlannerView);
  const [calendarView, setCalendarView] = useState(readCalendarView);
  const [layers, setLayers] = useState(readLayers);
  // Якорь периода: выбранный день; месяц, неделя и год берутся от него
  const [picked, setPicked] = useState(today);
  // Редактор задачи: id и день экземпляра ряда (spec 011); редактор события — то же
  const [editor, setEditor] = useState<{ id: string; day?: string }>();
  const [eventEditor, setEventEditor] = useState<{ id: string; day: string }>();
  const [formParams, setFormParams] = useState<PlannerFormParams>();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // Начатый жест листания (телефон): что листается и где палец коснулся экрана
  const swipeRef = useRef<{ period: SwipePeriod; start: SwipePoint }>();

  const currentUserId = useSelector(selectCurrentUserId);
  const { width: windowWidth } = useWindowSize();
  const isNarrow = windowWidth <= NARROW_WIDTH;

  useEffect(() => {
    void loadPlanner(currentUserId);
  }, [currentUserId]);

  // Смена суток при открытом «Плане»: «сегодня» и завершённость вчерашнего дня обновляются сами
  useEffect(() => {
    const timer = window.setTimeout(() => setToday(toDayKey(new Date())), msUntilTomorrow());
    return () => window.clearTimeout(timer);
  }, [today]);

  const pickDay = useLastCallback((day: string) => {
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
    setIsSettingsOpen(false);
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
    setIsSettingsOpen(false);
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
    setIsSettingsOpen(false);
    setFormParams(params);
  });

  const handleCreateForDay = useLastCallback((day: string) => {
    setPicked(day);
    openForm({ day });
  });

  // Нажатие на свободное время в сетке дня: новое дело с этого времени на час
  const handleCreateAt = useLastCallback((day: string, start: number) => {
    setPicked(day);
    openForm({ day, slot: { day, start, end: start + MINUTES_IN_HOUR } });
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

  const handleSwitchTab = useLastCallback((index: number) => {
    if (index === TAB_HEALTH) setPlannerView('health');
    else showPlannerCalendar();
  });

  const handleOpenCalendar = useLastCallback(() => {
    setPlannerView('calendar');
  });

  const handleOpenHealth = useLastCallback(() => {
    setPlannerView('health');
  });

  const handleOpenSettings = useLastCallback(() => {
    setIsSettingsOpen(true);
  });

  const changePeriod = useLastCallback((delta: number) => {
    pickDay(shiftPeriod(view === 'calendar' ? calendarView : 'day', picked, delta));
  });

  const handlePrevPeriod = useLastCallback(() => changePeriod(-1));
  const handleNextPeriod = useLastCallback(() => changePeriod(1));

  const handleShiftDay = useLastCallback((delta: number) => {
    pickDay(addDays(picked, delta));
  });

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
    setCalendarView(next);
    saveCalendarView(next);
  });

  // Переключатель вида: «Сегодня» — экран дня, остальные пункты — виды календаря
  const handleSwitchSegment = useLastCallback((next: string) => {
    if (next === SEGMENT_TODAY) setPlannerView('today');
    else handleSwitchCalendarView(next as PlannerCalendarView);
  });

  const handleToggleLayer = useLastCallback((layer: PlannerLayer) => {
    const next = { ...layers, [layer]: !layers[layer] };
    setLayers(next);
    saveLayers(next);
  });

  // Нажатие на день в виде «Год» открывает месяц этого дня
  const handleOpenMonth = useLastCallback((day: string) => {
    pickDay(day);
    handleSwitchCalendarView('month');
  });

  const handleCloseSide = useLastCallback(() => {
    setIsSettingsOpen(false);
    setFormParams(undefined);
    closeEditors();
  });

  const handleScrimClick = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) handleCloseSide();
  });

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
  // Настройки — окно поверх раздела; форма и карточка записи — справа на месте дня (телефон — шторка снизу)
  const side = !isLoaded ? undefined
    : isSettingsOpen ? 'settings' : formParams ? 'form' : editedTask ? 'task' : editedEvent ? 'event' : undefined;
  const isSheet = side === 'settings' || (Boolean(side) && isNarrow);
  const month = new Date(fromDayKey(picked).getFullYear(), fromDayKey(picked).getMonth(), 1);
  // spec 010: строка состояния синхронизации — только когда есть что сказать
  const syncNoticeKey = syncStatus === 'needs-linking' ? 'PlannerNeedsLinking'
    : syncStatus === 'offline' ? 'PlannerSyncUnavailable'
      : syncStatus === 'no-key' ? 'PlannerSyncPending'
        : sizeBytes > SNAPSHOT_WARN_BYTES ? 'PlannerNearLimit' : undefined;
  const viewTabs = [
    { title: lang('PlannerViewCalendar') },
    { title: lang('PlannerHealth') },
  ];
  const isToday = view === 'today';
  const isHealth = view === 'health';
  const isCalendar = view === 'calendar';
  const isMonthView = calendarView === 'month';
  const isWeekView = calendarView === 'week';
  // Сетка недели на компьютере листается сама, а шапки дней стоят на месте; на телефоне под полосой дней
  // листается день
  const isFlush = isCalendar && isWeekView && isLoaded;
  const calendarSegments = [
    { value: SEGMENT_TODAY, label: lang('PlannerToday') },
    ...PLANNER_CALENDAR_VIEWS.map((item) => ({
      value: item,
      // На телефоне «Неделя» показывает один день с полосой дней недели и называется «День»
      label: lang(isNarrow && item === 'week' ? CALENDAR_VIEW_LABELS.day
        : isNarrow && item === 'month' ? 'PlannerCalMonthShort' : CALENDAR_VIEW_LABELS[item]),
    })),
  ];
  const pickedDays = useMemo(() => [picked], [picked]);
  const weekDays = useMemo(() => getWeekKeys(picked), [picked]);
  const periodTitle = isWeekView && !isNarrow ? formatWeekRange(lang, picked)
    : formatPeriod(lang, isWeekView ? 'month' : calendarView, picked);

  // Кнопка «+» нижней панели телефона и «+ Запись» в шапке: запись одной строкой (spec 017).
  // Полная форма — по «Подробнее» в окне ввода, по «Добавить на этот день» и по нажатию на свободное время
  const [isQuickOpen, openQuick, closeQuick] = useFlag();
  const addRequest = useDerivedState(getPlannerAddRequest);
  useEffect(() => {
    if (!addRequest || !isLoaded) return;
    consumePlannerAddRequest();
    handleQuickText(addRequest.text || '');
  }, [addRequest, isLoaded]);

  // «Настройки плана» в профиле
  const settingsRequest = useDerivedState(getPlannerSettingsRequest);
  useEffect(() => {
    if (!settingsRequest || !isLoaded) return;
    consumePlannerSettingsRequest();
    handleOpenSettings();
  }, [settingsRequest, isLoaded]);

  // «В плане · открыть» на карточке в чате: «План» открывается на дне записи
  const dayRequest = useDerivedState(getPlannerDayRequest);
  useEffect(() => {
    if (!dayRequest) return;
    consumePlannerDayRequest();
    pickDay(dayRequest);
  }, [dayRequest]);

  const [quickText, setQuickText] = useState('');

  const handleOpenQuick = useLastCallback(() => {
    setQuickText('');
    openQuick();
  });

  // Пример на экране «Здоровье», «+» у задач и «Еда» у расписания открывают ввод с готовой строкой
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

  const settingsButton = (
    <button type="button" className={styles.ib} aria-label={lang('PlannerSettings')} onClick={handleOpenSettings}>
      <Icon name="settings" />
    </button>
  );

  function renderHeader() {
    // «Сегодня» — вид календаря: шапка та же, переключатель вида остаётся на месте
    if (!isHealth) {
      return (
        <PlannerPeriodBar
          heading={isToday ? lang('PlannerToday') : undefined}
          title={periodTitle}
          prevLabel={lang(isMonthView ? 'PlannerPrevMonth' : 'PlannerPrevPeriod')}
          nextLabel={lang(isMonthView ? 'PlannerNextMonth' : 'PlannerNextPeriod')}
          picked={picked}
          today={today}
          isNarrow={isNarrow}
          segments={calendarSegments}
          activeSegment={isToday ? SEGMENT_TODAY : calendarView}
          segmentsLabel={lang('PlannerCalView')}
          layers={layers}
          trailing={(
            <>
              {settingsButton}
              {!isNarrow && (
                <button
                  type="button"
                  className={buildClassName(styles.ib, styles.ibAccent)}
                  aria-label={lang('PlannerAddEntry')}
                  onClick={handleOpenQuick}
                >
                  <Icon name="add" />
                </button>
              )}
            </>
          )}
          onPrev={handlePrevPeriod}
          onNext={handleNextPeriod}
          onToday={handleToday}
          onPickDay={pickDay}
          onSwitchSegment={handleSwitchSegment}
          onToggleLayer={handleToggleLayer}
        />
      );
    }
    // Телефон: шапки у «Здоровья» нет — вкладки сверху, запись добавляет «+» нижней панели
    if (isNarrow) return undefined;
    return (
      <div className={styles.hdr}>
        <h1 className={styles.hdrTitle}>{lang('PlannerHealth')}</h1>
        <span className={styles.grow} />
        {settingsButton}
        <button type="button" className={buildClassName(styles.pill, styles.pillAccent)} onClick={handleOpenQuick}>
          {lang('PlannerAddEntry')}
        </button>
      </div>
    );
  }

  function renderCalendar() {
    if (calendarView === 'agenda') {
      return (
        <div data-swipe="day">
          <PlannerAgenda
            state={state}
            day={picked}
            today={today}
            onPickDay={pickDay}
            onOpenTask={handleOpenTask}
            onOpenEvent={handleOpenEvent}
          />
        </div>
      );
    }
    if (calendarView === 'year') {
      return (
        <PlannerYear
          state={state}
          year={month.getFullYear()}
          picked={picked}
          today={today}
          onOpenMonth={handleOpenMonth}
        />
      );
    }
    if (isMonthView) {
      return (
        <>
          {isNarrow && (
            <div className={styles.layerRow}><PlannerLayerChips layers={layers} onToggle={handleToggleLayer} /></div>
          )}
          <div data-swipe="month">
            <PlannerMonth
              state={state}
              month={month}
              picked={picked}
              today={today}
              layers={layers}
              onPickDay={pickDay}
              onCreateForDay={handleCreateForDay}
              onOpenTask={handleOpenTask}
              onMoveTask={handleMoveTask}
            />
          </div>
          {isNarrow && (
            <div className={styles.monthDay}>
              <PlannerDayPanel
                state={state}
                day={picked}
                today={today}
                layers={layers}
                variant="card"
                onAdd={handleAddToDay}
                onOpenTask={handleOpenTask}
                onOpenEvent={handleOpenEvent}
              />
            </div>
          )}
        </>
      );
    }
    if (isNarrow) {
      // Телефон: неделя — полоса дней и сетка выбранного дня под ней
      return (
        <div className={styles.phoneWeek} data-planner-view="week">
          <div className={styles.stripBar}>
            <PlannerDayStrip state={state} days={weekDays} picked={picked} today={today} onPickDay={pickDay} />
          </div>
          <div className={buildClassName(styles.content, styles.phoneWeekDay, 'custom-scroll')} data-swipe="day">
            <div className={styles.layerRow}><PlannerLayerChips layers={layers} onToggle={handleToggleLayer} /></div>
            <PlannerDayPanel
              state={state}
              day={picked}
              today={today}
              layers={layers}
              variant="summary"
              onOpenTask={handleOpenTask}
              onOpenEvent={handleOpenEvent}
            />
            <PlannerWeek
              state={state}
              days={pickedDays}
              picked={picked}
              today={today}
              layers={layers}
              onPickDay={pickDay}
              onCreateForDay={handleCreateForDay}
              onCreateAt={handleCreateAt}
              onOpenTask={handleOpenTask}
              onOpenEvent={handleOpenEvent}
            />
          </div>
        </div>
      );
    }
    return (
      <PlannerWeek
        state={state}
        days={weekDays}
        picked={picked}
        today={today}
        layers={layers}
        onPickDay={pickDay}
        onCreateForDay={handleCreateForDay}
        onCreateAt={handleCreateAt}
        onOpenTask={handleOpenTask}
        onOpenEvent={handleOpenEvent}
      />
    );
  }

  function renderSide() {
    const sideDay = side === 'task' ? editedTask!.instanceDay || editedTask!.day
      : side === 'event' ? eventEditor!.day : undefined;
    return (
      <aside
        className={buildClassName(
          styles.side, isSheet && styles.sheetPane, side === 'settings' && styles.sheetPaneCentered,
        )}
        data-planner-side={side}
      >
        {isNarrow && <span className={styles.grab} />}
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
            <h2 className={styles.sideTitle}>{lang(side === 'settings' ? 'PlannerSettings' : 'PlannerTitleNew')}</h2>
          )}
          <span className={styles.grow} />
          <button type="button" className={styles.ib} aria-label={lang('Close')} onClick={handleCloseSide}>
            <Icon name="close" />
          </button>
        </div>
        <div className={buildClassName(styles.content, styles.sideContent, 'custom-scroll')}>
          {side === 'settings' ? (
            <PlannerSettings state={state} userId={currentUserId} />
          ) : side === 'form' ? (
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
            />
          )}
        </div>
      </aside>
    );
  }

  return (
    <div
      id="ParvanePlanner"
      className={buildClassName(styles.root, side && !isSheet && styles.withSide)}
      data-sync-status={syncStatus}
      data-loaded={isLoaded ? '1' : '0'}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.body}>
        <main className={styles.page}>
          {/* Компьютер: экраны «Плана» — кнопки боковой панели, вкладок в шапке нет */}
          {isNarrow && (
            <header className={styles.mtabs}>
              <TabList
                className={styles.viewTabs}
                tabs={viewTabs}
                activeTab={isHealth ? TAB_HEALTH : TAB_CALENDAR}
                onSwitchTab={handleSwitchTab}
              />
            </header>
          )}
          {renderHeader()}
          {syncNoticeKey && (
            <div
              className={buildClassName(styles.syncNotice, syncStatus === 'needs-linking' && styles.syncNoticeBlocking)}
              role="status"
            >
              {lang(syncNoticeKey)}
            </div>
          )}
          <div
            className={buildClassName(styles.content, isFlush && styles.contentFlush, 'custom-scroll')}
            data-swipe={isNarrow && !isCalendar ? 'day' : undefined}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {!isLoaded ? <Loading /> : isCalendar ? renderCalendar() : (
              <>
                <PlannerDateNav
                  day={picked}
                  today={today}
                  onPrev={handlePrevPeriod}
                  onNext={handleNextPeriod}
                  onToday={handleToday}
                />
                {isHealth ? (
                  <PlannerHealth
                    state={state}
                    day={picked}
                    today={today}
                    onExample={handleQuickText}
                    onOpenSettings={handleOpenSettings}
                  />
                ) : (
                  <PlannerToday
                    state={state}
                    day={picked}
                    today={today}
                    isNarrow={isNarrow}
                    onOpenTask={handleOpenTask}
                    onOpenEvent={handleOpenEvent}
                    onOpenCalendar={handleOpenCalendar}
                    onOpenHealth={handleOpenHealth}
                    onQuick={handleQuickText}
                  />
                )}
              </>
            )}
          </div>
        </main>
        {side && !isSheet && renderSide()}
        {isLoaded && isCalendar && !isNarrow && !(side && !isSheet) && (
          <PlannerDayPanel
            state={state}
            day={picked}
            today={today}
            layers={layers}
            variant="island"
            onShiftDay={handleShiftDay}
            onAdd={handleAddToDay}
            onOpenTask={handleOpenTask}
            onOpenEvent={handleOpenEvent}
          />
        )}
      </div>
      {side && isSheet && (
        <div
          className={buildClassName(styles.scrim, side === 'settings' && styles.scrimCentered)}
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
