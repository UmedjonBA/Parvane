import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { PlannerCalendarView, PlannerSlot } from './plannerModel';
import type { PlannerFormParams } from './PlannerTaskForm';

import buildClassName from '../../../util/buildClassName';
import { setParvaneSection } from '../../../util/parvaneSection';
import { formatDay, formatDayLong, formatPeriod } from './plannerFormat';
import {
  detachInstance, eventInstance, fromDayKey, getWeekKeys, PLANNER_CALENDAR_VIEWS, shiftPeriod, taskInstance,
  toDayKey,
} from './plannerModel';
import {
  getIsPlannerLoaded, getPlannerNotice, getPlannerSizeBytes, getPlannerState, getPlannerStatus, loadPlanner,
  undoPlanner, updatePlanner,
} from './plannerStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import Button from '../../ui/Button';
import Loading from '../../ui/Loading';
import TabList from '../../ui/TabList';
import PlannerAgenda from './PlannerAgenda';
import PlannerDay from './PlannerDay';
import PlannerEventEditor from './PlannerEventEditor';
import PlannerMonth from './PlannerMonth';
import PlannerPeriodBar from './PlannerPeriodBar';
import PlannerSettings from './PlannerSettings';
import PlannerStatistics from './PlannerStatistics';
import PlannerTaskEditor from './PlannerTaskEditor';
import PlannerTaskForm from './PlannerTaskForm';
import PlannerTasks from './PlannerTasks';
import PlannerWeek from './PlannerWeek';
import PlannerYear from './PlannerYear';

import styles from './Planner.module.scss';

type OwnProps = {
  isMobile?: boolean;
};

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// 75 % потолка открытого текста снимка контейнера (1 МиБ, spec 010 R5)
const SNAPSHOT_WARN_BYTES = 786432;
const VIEW_CALENDAR = 0;
const VIEW_TASKS = 1;
const VIEW_STATISTICS = 2;
const CALENDAR_VIEW_KEY = 'parvane:planner-view';
const CALENDAR_VIEW_LABELS = {
  year: 'PlannerCalYear',
  month: 'PlannerCalMonth',
  week: 'PlannerCalWeek',
  day: 'PlannerCalDay',
  agenda: 'PlannerCalAgenda',
} as const satisfies Record<PlannerCalendarView, string>;
const MS_IN_SECOND = 1000;
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
const Planner = ({ isMobile }: OwnProps) => {
  const lang = useLang();

  const state = useDerivedState(getPlannerState);
  const isLoaded = useDerivedState(getIsPlannerLoaded);
  const notice = useDerivedState(getPlannerNotice);
  const syncStatus = useDerivedState(getPlannerStatus);
  const sizeBytes = useDerivedState(getPlannerSizeBytes);

  const [today, setToday] = useState(() => toDayKey(new Date()));
  const [view, setView] = useState(VIEW_CALENDAR);
  const [calendarView, setCalendarView] = useState(readCalendarView);
  // Якорь периода: выбранный день; месяц, неделя и год берутся от него
  const [picked, setPicked] = useState(today);
  // Редактор задачи: id и день экземпляра ряда (spec 011); редактор события — то же
  const [editor, setEditor] = useState<{ id: string; day?: string }>();
  const [eventEditor, setEventEditor] = useState<{ id: string; day: string }>();
  const [formParams, setFormParams] = useState<PlannerFormParams>();
  const [selectedProject, setSelectedProject] = useState('');
  // Узкое окно: виден либо месяц, либо панель дня/задачи
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

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
    if (target && view === VIEW_CALENDAR) pickDay(target);
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

  const handleCreateInDay = useLastCallback((slot?: PlannerSlot) => {
    openForm({ day: picked, slot: slot ? { ...slot, day: picked } : undefined });
  });

  const handleCreateInList = useLastCallback(() => {
    openForm({ project: selectedProject });
  });

  const handleAdd = useLastCallback(() => {
    openForm(view === VIEW_TASKS ? { project: selectedProject } : { day: picked });
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
    setView(index);
    setIsPanelOpen(false);
  });

  const handleOpenSettings = useLastCallback(() => {
    setIsSettingsOpen(true);
  });

  const changePeriod = useLastCallback((delta: number) => {
    pickDay(shiftPeriod(view === VIEW_STATISTICS ? 'month' : calendarView, picked, delta));
    setIsPanelOpen(false);
  });

  const handlePrevPeriod = useLastCallback(() => changePeriod(-1));
  const handleNextPeriod = useLastCallback(() => changePeriod(1));

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

  const handleBackToMessenger = useLastCallback(() => {
    setParvaneSection('messenger');
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
  const isInlineForm = isCreating && isNarrow && view === VIEW_CALENDAR && !isSettingsOpen;
  // Левая колонка: настройки, форма создания либо редактор; календарь и панель дня остаются на месте
  const side = !isLoaded ? undefined
    : isSettingsOpen ? 'settings' : isCreating && !isInlineForm ? 'form' : editedTask ? 'task'
      : editedEvent ? 'event' : undefined;
  const isCalendar = view === VIEW_CALENDAR;
  const month = new Date(fromDayKey(picked).getFullYear(), fromDayKey(picked).getMonth(), 1);
  // spec 010: строка состояния синхронизации — только когда есть что сказать
  const syncNoticeKey = syncStatus === 'needs-linking' ? 'PlannerNeedsLinking'
    : syncStatus === 'offline' ? 'PlannerSyncUnavailable'
      : syncStatus === 'no-key' ? 'PlannerSyncPending'
        : sizeBytes > SNAPSHOT_WARN_BYTES ? 'PlannerNearLimit' : undefined;
  const viewTabs = [
    { title: lang('PlannerViewCalendar') },
    { title: lang('PlannerViewTasks') },
    { title: lang('PlannerViewStatistics') },
  ];
  const title = view === VIEW_TASKS ? lang('PlannerViewTasks')
    : view === VIEW_STATISTICS ? lang('PlannerViewStatistics') : lang('ParvaneSectionPlanner');
  const sideTitle = side === 'settings' ? lang('PlannerSettings') : side === 'form' ? lang('PlannerTitleNew')
    : side === 'task' ? lang('PlannerTitleTask') : lang('PlannerTitleEvent');
  const calendarSegments = PLANNER_CALENDAR_VIEWS
    .map((item) => ({ value: item, label: lang(CALENDAR_VIEW_LABELS[item]) }));
  const isMonthView = calendarView === 'month';
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
        {isMobile && (
          <Button
            round
            size="smaller"
            color="translucent"
            iconName="arrow-left"
            ariaLabel={lang('ParvaneSectionMessenger')}
            onClick={handleBackToMessenger}
          />
        )}
        {/* Узкий экран: заголовка и кнопки добавления нет — вкладки стоят в строке со стрелкой,
            шестерёнка — в строке периода, задача добавляется из расписания дня */}
        {!isNarrow && <h1 className={styles.title}>{title}</h1>}
        <TabList className={styles.viewTabs} tabs={viewTabs} activeTab={view} onSwitchTab={handleSwitchView} />
        {(!isNarrow || view === VIEW_TASKS) && (
          <div className={styles.headerButtons}>
            {settingsButton}
            {!isNarrow && view !== VIEW_STATISTICS && (
              <Button size="smaller" onClick={handleAdd}>{lang('PlannerAddTask')}</Button>
            )}
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
              styles.layout, side && styles.layoutWithSide, !isCalendar && styles.layoutNoPanel,
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
            <div className={styles.main}>
              {isCalendar && (
                <PlannerPeriodBar
                  title={formatPeriod(lang, calendarView, picked)}
                  prevLabel={lang(isMonthView ? 'PlannerPrevMonth' : 'PlannerPrevPeriod')}
                  nextLabel={lang(isMonthView ? 'PlannerNextMonth' : 'PlannerNextPeriod')}
                  picked={picked}
                  segments={isNarrow ? undefined : calendarSegments}
                  activeSegment={calendarView}
                  segmentsLabel={lang('PlannerCalView')}
                  trailing={isNarrow ? settingsButton : undefined}
                  onPrev={handlePrevPeriod}
                  onNext={handleNextPeriod}
                  onToday={handleToday}
                  onPickDay={pickDay}
                  onSwitchSegment={handleSwitchCalendarView}
                />
              )}
              {view === VIEW_STATISTICS ? (
                <PlannerStatistics
                  state={state}
                  picked={picked}
                  today={today}
                  trailing={isNarrow ? settingsButton : undefined}
                  onPickDay={pickDay}
                />
              ) : view === VIEW_TASKS ? (
                <PlannerTasks
                  state={state}
                  today={today}
                  selectedProject={state.projects.includes(selectedProject) ? selectedProject : ''}
                  onSelectProject={setSelectedProject}
                  onOpenTask={handleOpenTask}
                  onCreateTask={handleCreateInList}
                />
              ) : calendarView === 'year' ? (
                <PlannerYear
                  state={state}
                  year={month.getFullYear()}
                  picked={picked}
                  today={today}
                  onOpenMonth={handleOpenMonth}
                />
              ) : calendarView === 'agenda' ? (
                <PlannerAgenda
                  state={state}
                  fromDay={picked}
                  today={today}
                  onPickDay={handlePickDay}
                  onOpenTask={handleOpenTask}
                  onOpenEvent={handleOpenEvent}
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
              ) : (
                <PlannerWeek
                  state={state}
                  days={calendarView === 'week' ? getWeekKeys(picked) : [picked]}
                  picked={picked}
                  today={today}
                  onPickDay={handlePickDay}
                  onCreateForDay={handleCreateForDay}
                  onOpenTask={handleOpenTask}
                  onOpenEvent={handleOpenEvent}
                />
              )}
            </div>
            {isCalendar && (
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
                {!isNarrow && <h2 className={styles.panelTitle}>{formatDayLong(lang, picked)}</h2>}
                <PlannerDay
                  state={state}
                  day={picked}
                  isStrip={isNarrow}
                  inlineForm={isInlineForm ? (
                    <PlannerTaskForm
                      state={state}
                      params={formParams}
                      onCreated={handleCreatedInline}
                      onCancel={handleCancelCreate}
                    />
                  ) : undefined}
                  inlineFormStart={isInlineForm ? formParams.slot?.start : undefined}
                  onOpenTask={handleOpenTask}
                  onOpenEvent={handleOpenEvent}
                  onCreateTask={handleCreateInDay}
                />
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
    </div>
  );
};

export default memo(Planner);
