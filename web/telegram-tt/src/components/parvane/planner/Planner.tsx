import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { PlannerCalendarView } from './plannerModel';
import type { SwipePoint } from './plannerSwipe';
import type { PlannerFormParams } from './PlannerTaskForm';

import buildClassName from '../../../util/buildClassName';
import {
  consumePlannerAddRequest, getPlannerAddRequest, getPlannerView, setPlannerView,
} from '../../../util/parvaneSection';
import { consumePlannerDayRequest, getPlannerDayRequest } from '../taskOffer/taskOfferOpen';
import {
  buildDaySummary, formatDay, formatDayLong, formatPeriod,
} from './plannerFormat';
import {
  detachInstance, eventInstance, fromDayKey, getWeekKeys, PLANNER_CALENDAR_VIEWS, shiftPeriod, taskInstance,
  toDayKey,
} from './plannerModel';
import {
  getIsPlannerLoaded, getPlannerNotice, getPlannerSizeBytes, getPlannerState, getPlannerStatus, loadPlanner,
  undoPlanner, updatePlanner,
} from './plannerStore';
import { getSwipeDelta, isSwipeBlocked } from './plannerSwipe';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import Button from '../../ui/Button';
import Loading from '../../ui/Loading';
import TabList from '../../ui/TabList';
import PlannerAgenda from './PlannerAgenda';
import PlannerDayStrip from './PlannerDayStrip';
import PlannerEventEditor from './PlannerEventEditor';
import PlannerHealth from './PlannerHealth';
import PlannerMonth from './PlannerMonth';
import PlannerPeriodBar from './PlannerPeriodBar';
import PlannerQuickInput from './PlannerQuickInput';
import PlannerSettings from './PlannerSettings';
import PlannerTaskEditor from './PlannerTaskEditor';
import PlannerTaskForm from './PlannerTaskForm';
import PlannerTimeline from './PlannerTimeline';
import PlannerToday from './PlannerToday';
import PlannerWeek from './PlannerWeek';
import PlannerYear from './PlannerYear';

import styles from './Planner.module.scss';

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// 75 % потолка открытого текста снимка контейнера (1 МиБ, spec 010 R5)
const SNAPSHOT_WARN_BYTES = 786432;
const VIEW_TODAY = 0;
const VIEW_CALENDAR = 1;
const VIEW_HEALTH = 2;
const PLANNER_VIEWS = ['today', 'calendar', 'health'] as const;
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

// Parvane (spec 009): раздел «План» — календарь с загрузкой дней, задачи по
// спискам, статистика времени и питания. Данные — запись устройства (plannerStore)
const Planner = () => {
  const lang = useLang();

  const state = useDerivedState(getPlannerState);
  const isLoaded = useDerivedState(getIsPlannerLoaded);
  const notice = useDerivedState(getPlannerNotice);
  const syncStatus = useDerivedState(getPlannerStatus);
  const sizeBytes = useDerivedState(getPlannerSizeBytes);

  const [today, setToday] = useState(() => toDayKey(new Date()));
  // Экран раздела общий с боковой панелью (`util/parvaneSection.ts`)
  const view = PLANNER_VIEWS.indexOf(useDerivedState(getPlannerView));
  const [calendarView, setCalendarView] = useState(readCalendarView);
  // Якорь периода: выбранный день; месяц, неделя и год берутся от него
  const [picked, setPicked] = useState(today);
  // Редактор задачи: id и день экземпляра ряда (spec 011); редактор события — то же
  const [editor, setEditor] = useState<{ id: string; day?: string }>();
  const [eventEditor, setEventEditor] = useState<{ id: string; day: string }>();
  const [formParams, setFormParams] = useState<PlannerFormParams>();
  // Узкое окно: виден либо месяц, либо панель дня/задачи
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // Начатый жест листания (телефон): что листается и где палец коснулся экрана
  const swipeRef = useRef<{ period: 'day' | 'week'; start: SwipePoint }>();

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

  const handlePickDay = useLastCallback((day: string) => {
    pickDay(day);
    setIsPanelOpen(true);
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
    // Узкий экран: форма раскрывается в расписании дня, а не на весь экран
    if (isNarrow && view === VIEW_CALENDAR) setIsPanelOpen(true);
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

  const handleCreated = useLastCallback((taskId?: string, day?: string) => {
    setFormParams(undefined);
    if (taskId !== undefined) handleOpenTask(taskId, day);
    else closeEditors();
  });

  // После создания из расписания редактор не открывается: задача сразу видна в расписании
  const handleCreatedInline = useLastCallback(() => {
    setFormParams(undefined);
  });

  const handleCancelCreate = useLastCallback(() => {
    setFormParams(undefined);
  });

  const handleSwitchView = useLastCallback((index: number) => {
    setPlannerView(PLANNER_VIEWS[index]);
    setIsPanelOpen(false);
  });

  const handleOpenCalendar = useLastCallback(() => {
    handleSwitchView(VIEW_CALENDAR);
  });

  const handleOpenHealth = useLastCallback(() => {
    handleSwitchView(VIEW_HEALTH);
  });

  const handleOpenSettings = useLastCallback(() => {
    setIsSettingsOpen(true);
  });

  const changePeriod = useLastCallback((delta: number) => {
    pickDay(shiftPeriod(view === VIEW_CALENDAR ? calendarView : 'day', picked, delta));
    setIsPanelOpen(false);
  });

  const handlePrevPeriod = useLastCallback(() => changePeriod(-1));
  const handleNextPeriod = useLastCallback(() => changePeriod(1));

  // Телефон: горизонтальный свайп листает то, что названо в `data-swipe` под пальцем, — дни либо недели
  const handleTouchStart = useLastCallback((e: React.TouchEvent<HTMLDivElement>) => {
    swipeRef.current = undefined;
    const target = e.target as HTMLElement;
    const period = target.closest<HTMLElement>('[data-swipe]')?.dataset.swipe as 'day' | 'week' | undefined;
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

  const handleSwitchCalendarView = useLastCallback((next: string) => {
    setCalendarView(next as PlannerCalendarView);
    saveCalendarView(next as PlannerCalendarView);
    setIsPanelOpen(false);
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

  const handleCloseEditor = useLastCallback(() => {
    closeEditors();
  });

  const handleClosePanel = useLastCallback(() => {
    setIsPanelOpen(false);
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
  const isCreating = Boolean(formParams);
  // На телефоне трёх колонок нет: новая задача из календаря пишется прямо в расписании дня (на месте
  // свободного окна), а не на отдельном экране
  // Телефон, вид «Неделя»: день стоит под полосой дней недели — панель дня не показывается
  const isNarrowWeek = isNarrow && view === VIEW_CALENDAR && calendarView === 'week';
  const isInlineForm = isCreating && isNarrow && !isSettingsOpen && !isNarrowWeek;
  // Левая колонка: настройки, форма создания либо редактор; календарь и панель дня остаются на месте
  const side = !isLoaded ? undefined
    : isSettingsOpen ? 'settings' : isCreating && !isInlineForm ? 'form' : editedTask ? 'task'
      : editedEvent ? 'event' : undefined;
  const month = new Date(fromDayKey(picked).getFullYear(), fromDayKey(picked).getMonth(), 1);
  // spec 010: строка состояния синхронизации — только когда есть что сказать
  const syncNoticeKey = syncStatus === 'needs-linking' ? 'PlannerNeedsLinking'
    : syncStatus === 'offline' ? 'PlannerSyncUnavailable'
      : syncStatus === 'no-key' ? 'PlannerSyncPending'
        : sizeBytes > SNAPSHOT_WARN_BYTES ? 'PlannerNearLimit' : undefined;
  const viewTabs = [
    { title: lang('PlannerToday') },
    { title: lang('PlannerViewCalendar') },
    { title: lang('PlannerHealth') },
  ];
  const isToday = view === VIEW_TODAY;
  const isHealth = view === VIEW_HEALTH;
  // «Сегодня» и «Здоровье» листаются по дням
  const isDayView = isToday || isHealth;
  const title = lang(isToday ? 'PlannerToday' : isHealth ? 'PlannerHealth' : 'PlannerViewCalendar');
  // «Сегодня» на узком экране: расписание дня стоит внутри экрана, отдельной панели нет
  const hasPanel = isHealth ? false : isToday ? !isNarrow : !isNarrowWeek;
  const sideTitle = side === 'settings' ? lang('PlannerSettings') : side === 'form' ? lang('PlannerTitleNew')
    : side === 'task' ? lang('PlannerTitleTask') : lang('PlannerTitleEvent');
  const calendarSegments = PLANNER_CALENDAR_VIEWS
    // На телефоне «Неделя» показывает один день с полосой дней недели и называется «День»
    .map((item) => ({ value: item, label: lang(CALENDAR_VIEW_LABELS[isNarrow && item === 'week' ? 'day' : item]) }));
  const isMonthView = calendarView === 'month';
  const daySummary = buildDaySummary(lang, state, picked);
  const pickedDays = useMemo(() => [picked], [picked]);

  // Кнопка «+» нижней панели телефона и «+ Запись» в шапке: запись одной строкой (spec 017).
  // Полная форма — по «Подробнее» в окне ввода, по «+» у дня и по нажатию на свободное время сетки
  const [isQuickOpen, openQuick, closeQuick] = useFlag();
  const addRequest = useDerivedState(getPlannerAddRequest);
  useEffect(() => {
    if (!addRequest || !isLoaded) return;
    consumePlannerAddRequest();
    handleOpenQuick();
  }, [addRequest, isLoaded]);

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

  // Пример на экране «Здоровье» открывает ввод с готовой строкой
  const handleExample = useLastCallback((text: string) => {
    setQuickText(text);
    openQuick();
  });

  const handleQuickCreated = useLastCallback((day?: string) => {
    closeQuick();
    if (day) pickDay(day);
  });

  const handleQuickMore = useLastCallback(() => {
    closeQuick();
    handleAddToDay();
  });
  const dayTimeline = (
    <PlannerTimeline
      state={state}
      day={picked}
      inlineForm={isInlineForm ? (
        <PlannerTaskForm
          state={state}
          params={formParams}
          onCreated={handleCreatedInline}
          onCancel={handleCancelCreate}
        />
      ) : undefined}
      onAdd={handleAddToDay}
      onCreateAt={handleCreateAt}
      onOpenTask={handleOpenTask}
      onOpenEvent={handleOpenEvent}
    />
  );
  const settingsButton = (
    <Button
      round
      size="smaller"
      color="translucent"
      iconName="settings"
      ariaLabel={lang('PlannerSettings')}
      onClick={handleOpenSettings}
    />
  );

  return (
    <div
      id="ParvanePlanner"
      className={buildClassName(styles.root, isPanelOpen && styles.panelOpen, side && styles.sideOpen)}
      data-sync-status={syncStatus}
      data-loaded={isLoaded ? '1' : '0'}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <header className={styles.header}>
        {/* Узкий экран: заголовка и кнопки добавления нет — вкладки стоят в строке со стрелкой,
            шестерёнка — в строке периода, задача добавляется из расписания дня */}
        {!isNarrow && <h1 className={styles.title}>{title}</h1>}
        {/* Компьютер: экраны «Плана» — кнопки боковой панели, вкладок в шапке нет */}
        {isNarrow && (
          <TabList className={styles.viewTabs} tabs={viewTabs} activeTab={view} onSwitchTab={handleSwitchView} />
        )}
        {!isNarrow && (
          <div className={styles.headerButtons}>
            {settingsButton}
            <Button size="smaller" onClick={handleOpenQuick}>{lang('PlannerAddEntry')}</Button>
          </div>
        )}
      </header>
      {syncNoticeKey && (
        <div
          className={buildClassName(styles.syncNotice, syncStatus === 'needs-linking' && styles.syncNoticeBlocking)}
          role="status"
        >
          {lang(syncNoticeKey)}
        </div>
      )}
      <div className={buildClassName(styles.content, 'custom-scroll')}>
        {!isLoaded ? <Loading /> : (
          <div
            className={buildClassName(
              styles.layout, side && styles.layoutWithSide, !hasPanel && styles.layoutNoPanel,
              isNarrowWeek && styles.layoutWeek,
            )}
          >
            {side && (
              <aside className={styles.side} data-planner-side={side}>
                <div className={styles.sideHead}>
                  <h2 className={styles.panelTitle}>{sideTitle}</h2>
                  <Button
                    round
                    size="tiny"
                    color="translucent"
                    iconName="close"
                    ariaLabel={lang('Close')}
                    onClick={handleCloseSide}
                  />
                </div>
                {side === 'settings' ? (
                  <PlannerSettings
                    state={state}
                    viewOptions={isNarrow ? calendarSegments : undefined}
                    activeView={calendarView}
                    onSwitchView={handleSwitchCalendarView}
                    onBack={handleCloseSide}
                  />
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
                    backLabel={lang('Close')}
                    onBack={handleCloseEditor}
                    onPickDay={pickDay}
                    onOpenTask={handleOpenTask}
                  />
                ) : (
                  <PlannerEventEditor
                    key={`${editedEvent!.id}@${editedEvent!.instanceDay || ''}`}
                    state={state}
                    event={editedEvent!}
                    backLabel={lang('Close')}
                    onBack={handleCloseEditor}
                  />
                )}
              </aside>
            )}
            <div
              className={styles.main}
              data-swipe={isNarrow && isDayView ? 'day' : undefined}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              <PlannerPeriodBar
                title={formatPeriod(lang, isDayView ? 'day' : calendarView, picked)}
                prevLabel={lang(isMonthView && !isDayView ? 'PlannerPrevMonth' : 'PlannerPrevPeriod')}
                nextLabel={lang(isMonthView && !isDayView ? 'PlannerNextMonth' : 'PlannerNextPeriod')}
                picked={picked}
                segments={isNarrow || isDayView ? undefined : calendarSegments}
                activeSegment={calendarView}
                segmentsLabel={lang('PlannerCalView')}
                trailing={isNarrow ? settingsButton : undefined}
                onPrev={handlePrevPeriod}
                onNext={handleNextPeriod}
                onToday={handleToday}
                onPickDay={pickDay}
                onSwitchSegment={handleSwitchCalendarView}
              />
              {isHealth ? (
                <PlannerHealth state={state} day={picked} today={today} onExample={handleExample} />
              ) : isToday ? (
                <PlannerToday
                  state={state}
                  day={picked}
                  today={today}
                  schedule={isNarrow ? dayTimeline : undefined}
                  onOpenTask={handleOpenTask}
                  onOpenCalendar={handleOpenCalendar}
                  onOpenHealth={handleOpenHealth}
                />
              ) : calendarView === 'agenda' ? (
                <PlannerAgenda
                  state={state}
                  day={picked}
                  today={today}
                  onPickDay={handlePickDay}
                  onOpenTask={handleOpenTask}
                  onOpenEvent={handleOpenEvent}
                />
              ) : calendarView === 'year' ? (
                <PlannerYear
                  state={state}
                  year={month.getFullYear()}
                  picked={picked}
                  today={today}
                  onOpenMonth={handleOpenMonth}
                />
              ) : isMonthView ? (
                <PlannerMonth
                  state={state}
                  month={month}
                  picked={picked}
                  today={today}
                  onPickDay={handlePickDay}
                  onCreateForDay={handleCreateForDay}
                  onOpenTask={handleOpenTask}
                  onMoveTask={handleMoveTask}
                />
              ) : isNarrow ? (
                // Телефон: неделя — полоса дней и сетка выбранного дня под ней
                <div className={styles.phoneWeek} data-planner-view="week">
                  <PlannerDayStrip
                    state={state}
                    days={getWeekKeys(picked)}
                    picked={picked}
                    today={today}
                    onPickDay={pickDay}
                  />
                  <p className={buildClassName(styles.summary, daySummary.isOver && styles.warning)}>
                    {daySummary.text}
                  </p>
                  <div className={styles.phoneWeekDay} data-swipe="day">
                    <PlannerWeek
                      state={state}
                      days={pickedDays}
                      picked={picked}
                      today={today}
                      isPanel
                      onPickDay={pickDay}
                      onCreateForDay={handleCreateForDay}
                      onCreateAt={handleCreateAt}
                      onOpenTask={handleOpenTask}
                      onOpenEvent={handleOpenEvent}
                    />
                  </div>
                </div>
              ) : (
                <PlannerWeek
                  state={state}
                  days={getWeekKeys(picked)}
                  picked={picked}
                  today={today}
                  isTapCreate
                  onCreateAt={handleCreateAt}
                  onPickDay={handlePickDay}
                  onCreateForDay={handleCreateForDay}
                  onOpenTask={handleOpenTask}
                  onOpenEvent={handleOpenEvent}
                />
              )}
            </div>
            {hasPanel && (
              <aside className={styles.panel} data-planner-day={picked}>
                <Button
                  isText
                  size="smaller"
                  className={styles.backToMain}
                  iconName="arrow-left"
                  onClick={handleClosePanel}
                >
                  {lang('PlannerBackToCalendar')}
                </Button>
                {isNarrow ? (
                  dayTimeline
                ) : (
                  <>
                    <div className={styles.panelHead}>
                      <h2 className={styles.panelTitle}>{formatDayLong(lang, picked)}</h2>
                      <Button
                        round
                        size="tiny"
                        color="translucent"
                        className={styles.panelAdd}
                        iconName="add"
                        ariaLabel={lang('PlannerAddTaskForDay')}
                        onClick={handleAddToDay}
                      />
                    </div>
                    <p className={buildClassName(styles.summary, daySummary.isOver && styles.warning)}>
                      {daySummary.text}
                    </p>
                    <PlannerWeek
                      state={state}
                      days={pickedDays}
                      picked={picked}
                      today={today}
                      isPanel
                      onPickDay={pickDay}
                      onCreateForDay={handleCreateForDay}
                      onCreateAt={handleCreateAt}
                      onOpenTask={handleOpenTask}
                      onOpenEvent={handleOpenEvent}
                    />
                  </>
                )}
              </aside>
            )}
          </div>
        )}
      </div>
      {notice && (
        <div className={styles.notice} role="status">
          <span>{notice.text}</span>
          {notice.canUndo && <Button isText size="tiny" onClick={handleUndo}>{lang('PlannerUndo')}</Button>}
        </div>
      )}
      <PlannerQuickInput
        isOpen={isQuickOpen}
        initialText={quickText}
        today={today}
        settings={state.settings}
        onCreated={handleQuickCreated}
        onMore={handleQuickMore}
        onClose={closeQuick}
      />
    </div>
  );
};

export default memo(Planner);
