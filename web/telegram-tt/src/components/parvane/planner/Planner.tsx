import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';
import type { PlannerSlot } from './plannerModel';
import type { PlannerFormParams } from './PlannerTaskForm';

import buildClassName from '../../../util/buildClassName';
import { setParvaneSection } from '../../../util/parvaneSection';
import { formatDay, formatDayLong, formatMonth } from './plannerFormat';
import { fromDayKey, toDayKey } from './plannerModel';
import {
  getIsPlannerLoaded, getPlannerNotice, getPlannerSizeBytes, getPlannerState, getPlannerStatus, loadPlanner,
  undoPlanner, updatePlanner,
} from './plannerStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Loading from '../../ui/Loading';
import TabList from '../../ui/TabList';
import PlannerDay from './PlannerDay';
import PlannerMonth from './PlannerMonth';
import PlannerNutrition from './PlannerNutrition';
import PlannerSettings from './PlannerSettings';
import PlannerStatistics from './PlannerStatistics';
import PlannerTaskEditor from './PlannerTaskEditor';
import PlannerTaskForm from './PlannerTaskForm';
import PlannerTasks from './PlannerTasks';

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
const DAY_SCHEDULE = 0;
const DAY_NUTRITION = 1;

// Parvane (spec 009): раздел «План» — календарь с загрузкой дней, задачи по
// спискам, статистика времени и питания. Данные — запись устройства (plannerStore)
const Planner = ({ isMobile }: OwnProps) => {
  const lang = useLang();

  const state = useDerivedState(getPlannerState);
  const isLoaded = useDerivedState(getIsPlannerLoaded);
  const notice = useDerivedState(getPlannerNotice);
  const syncStatus = useDerivedState(getPlannerStatus);
  const sizeBytes = useDerivedState(getPlannerSizeBytes);

  const [today] = useState(() => toDayKey(new Date()));
  const [view, setView] = useState(VIEW_CALENDAR);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [picked, setPicked] = useState(today);
  const [editorId, setEditorId] = useState<string>();
  const [formParams, setFormParams] = useState<PlannerFormParams>();
  const [dayContent, setDayContent] = useState(DAY_SCHEDULE);
  const [foodAddRequest, setFoodAddRequest] = useState(0);
  const [selectedProject, setSelectedProject] = useState('');
  // Узкое окно: виден либо месяц, либо панель дня/задачи
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const currentUserId = useSelector(selectCurrentUserId);

  useEffect(() => {
    void loadPlanner(currentUserId);
  }, [currentUserId]);

  const pickDay = useLastCallback((day: string) => {
    const date = fromDayKey(day);
    setPicked(day);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
  });

  const handlePickDay = useLastCallback((day: string) => {
    pickDay(day);
    setEditorId(undefined);
    setIsPanelOpen(true);
  });

  const handleOpenTask = useLastCallback((taskId: string, day?: string) => {
    const task = state.tasks.find(({ id }) => id === taskId);
    const target = day || task?.day;
    if (target && view === VIEW_CALENDAR) pickDay(target);
    setEditorId(taskId);
    setIsPanelOpen(true);
  });

  const handleMoveTask = useLastCallback((taskId: string, day: string) => {
    const task = state.tasks.find(({ id }) => id === taskId);
    if (!task || task.day === day) return;
    updatePlanner((draft) => {
      draft.tasks.find(({ id }) => id === taskId)!.day = day;
    }, lang('PlannerNoticeMoved', { date: formatDay(lang, day), name: task.name }));
  });

  const handleCreateForDay = useLastCallback((day: string) => {
    pickDay(day);
    setFormParams({ day });
  });

  const handleCreateInDay = useLastCallback((slot?: PlannerSlot) => {
    setFormParams({ day: picked, slot: slot ? { ...slot, day: picked } : undefined });
  });

  const handleCreateInList = useLastCallback(() => {
    setFormParams({ project: selectedProject });
  });

  const handleAdd = useLastCallback(() => {
    if (view === VIEW_CALENDAR && dayContent === DAY_NUTRITION) {
      setEditorId(undefined);
      setIsPanelOpen(true);
      setFoodAddRequest(foodAddRequest + 1);
      return;
    }
    setFormParams(view === VIEW_TASKS ? { project: selectedProject } : { day: picked });
  });

  const handleCreated = useLastCallback((taskId?: string) => {
    setFormParams(undefined);
    if (taskId !== undefined) handleOpenTask(taskId);
    else setEditorId(undefined);
  });

  const handleCancelCreate = useLastCallback(() => {
    setFormParams(undefined);
  });

  const handleSwitchView = useLastCallback((index: number) => {
    setView(index);
    setFormParams(undefined);
    setEditorId(undefined);
    setIsPanelOpen(false);
    setIsSettingsOpen(false);
  });

  const handleOpenSettings = useLastCallback(() => {
    setFormParams(undefined);
    setIsSettingsOpen(true);
  });

  const handleCloseSettings = useLastCallback(() => {
    setIsSettingsOpen(false);
  });

  const changeMonth = useLastCallback((delta: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    setMonth(next);
    setPicked(toDayKey(next));
    setEditorId(undefined);
    setIsPanelOpen(false);
  });

  const handlePrevMonth = useLastCallback(() => changeMonth(-1));
  const handleNextMonth = useLastCallback(() => changeMonth(1));

  const handleToday = useLastCallback(() => {
    pickDay(today);
    setEditorId(undefined);
  });

  const handleCloseEditor = useLastCallback(() => {
    setEditorId(undefined);
  });

  const handleClosePanel = useLastCallback(() => {
    setEditorId(undefined);
    setIsPanelOpen(false);
  });

  const handleOpenFoodDay = useLastCallback((day: string) => {
    setView(VIEW_CALENDAR);
    pickDay(day);
    setEditorId(undefined);
    setDayContent(DAY_NUTRITION);
    setIsPanelOpen(true);
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

  const editedTask = editorId === undefined ? undefined : state.tasks.find(({ id }) => id === editorId);
  const isCreating = Boolean(formParams);
  // Форма создания и настройки занимают всё содержимое — кнопки месяца и добавления прячутся
  const isOverlay = isCreating || isSettingsOpen;
  const isFood = view === VIEW_CALENDAR && dayContent === DAY_NUTRITION;
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
  const dayTabs = [{ title: lang('PlannerDaySchedule') }, { title: lang('PlannerDayNutrition') }];
  const title = isSettingsOpen ? lang('PlannerSettings') : isCreating
    ? lang('PlannerTitleNew')
    : (view === VIEW_TASKS ? lang('PlannerViewTasks')
      : view === VIEW_STATISTICS ? lang('PlannerViewStatistics') : formatMonth(lang, month));

  return (
    <div
      id="ParvanePlanner"
      className={buildClassName(styles.root, isPanelOpen && styles.panelOpen)}
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
        <h1 className={styles.title}>{title}</h1>
        <TabList className={styles.viewTabs} tabs={viewTabs} activeTab={view} onSwitchTab={handleSwitchView} />
        <div className={styles.headerButtons}>
          {!isOverlay && (
            <Button
              round
              size="smaller"
              color="translucent"
              iconName="settings"
              ariaLabel={lang('PlannerSettings')}
              onClick={handleOpenSettings}
            />
          )}
          {!isOverlay && view !== VIEW_TASKS && (
            <>
              <Button
                round
                size="smaller"
                color="translucent"
                iconName="previous"
                ariaLabel={lang('PlannerPrevMonth')}
                onClick={handlePrevMonth}
              />
              <Button size="smaller" color="translucent" onClick={handleToday}>{lang('PlannerToday')}</Button>
              <Button
                round
                size="smaller"
                color="translucent"
                iconName="next"
                ariaLabel={lang('PlannerNextMonth')}
                onClick={handleNextMonth}
              />
            </>
          )}
          {!isOverlay && view !== VIEW_STATISTICS && (
            <Button size="smaller" disabled={isFood && picked > today} onClick={handleAdd}>
              {lang(isFood ? 'PlannerAddFood' : 'PlannerAddTask')}
            </Button>
          )}
        </div>
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
        {!isLoaded ? <Loading /> : isSettingsOpen ? (
          <PlannerSettings state={state} onBack={handleCloseSettings} />
        ) : isCreating ? (
          <PlannerTaskForm
            state={state}
            params={formParams}
            onCreated={handleCreated}
            onCancel={handleCancelCreate}
          />
        ) : view === VIEW_STATISTICS ? (
          <PlannerStatistics
            state={state}
            month={month}
            picked={picked}
            today={today}
            onPickDay={pickDay}
            onOpenFoodDay={handleOpenFoodDay}
          />
        ) : (
          <div className={styles.layout}>
            <div className={styles.main}>
              {view === VIEW_CALENDAR ? (
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
                <PlannerTasks
                  state={state}
                  selectedProject={state.projects.includes(selectedProject) ? selectedProject : ''}
                  onSelectProject={setSelectedProject}
                  onOpenTask={handleOpenTask}
                  onCreateTask={handleCreateInList}
                />
              )}
            </div>
            {(view === VIEW_CALENDAR || editedTask) && (
              <aside className={styles.panel}>
                <Button
                  isText
                  size="smaller"
                  className={styles.backToMain}
                  iconName="arrow-left"
                  onClick={handleClosePanel}
                >
                  {lang(view === VIEW_CALENDAR ? 'PlannerBackToMonth' : 'PlannerBackToTasks')}
                </Button>
                {editedTask ? (
                  <PlannerTaskEditor
                    key={editedTask.id}
                    state={state}
                    task={editedTask}
                    today={today}
                    picked={picked}
                    backLabel={lang(view === VIEW_TASKS ? 'PlannerBackToTasks' : 'PlannerBackToDay')}
                    onBack={handleCloseEditor}
                    onPickDay={pickDay}
                  />
                ) : (
                  <>
                    <h2 className={styles.panelTitle}>{formatDayLong(lang, picked)}</h2>
                    <TabList tabs={dayTabs} activeTab={dayContent} onSwitchTab={setDayContent} />
                    {dayContent === DAY_SCHEDULE ? (
                      <PlannerDay
                        state={state}
                        day={picked}
                        onOpenTask={handleOpenTask}
                        onCreateTask={handleCreateInDay}
                      />
                    ) : (
                      <PlannerNutrition state={state} day={picked} today={today} addRequest={foodAddRequest} />
                    )}
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
    </div>
  );
};

export default memo(Planner);
