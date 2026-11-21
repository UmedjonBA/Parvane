import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { PvSegmentItem } from '../notes/PvSegment';
import type { PlannerState } from './plannerModel';
import type { DeadlineSection } from './plannerTasksView';

import buildClassName from '../../../util/buildClassName';
import { formatDay } from './plannerFormat';
import {
  fromDayKey, getCompletedTasks, getListColor, getUndatedTasks, toDayKey,
} from './plannerModel';
import { updatePlanner } from './plannerStore';
import { getDeadlineSections } from './plannerTasksView';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useWindowSize from '../../../hooks/window/useWindowSize';

import CalendarModal from '../../common/CalendarModal';
import PvEmpty from '../notes/PvEmpty';
import PvIcon from '../notes/PvIcon';
import PvSegment from '../notes/PvSegment';
import PlannerGroupsPane from './PlannerGroupsPane';
import PlannerTaskRow from './PlannerTaskRow';

import kit from '../notes/PvKit.module.scss';
import styles from './PlannerMore.module.scss';

export type PlannerTasksTab = 'deadlines' | 'undated' | 'groups';

type OwnProps = {
  state: PlannerState;
  today: string;
  tab: PlannerTasksTab;
  isNarrow: boolean;
  onChangeTab: (tab: PlannerTasksTab) => void;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenSearch: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

const SECTION_KEYS = {
  overdue: 'PlannerTasksOverdue',
  today: 'PlannerTasksDueToday',
  week: 'PlannerTasksDueWeek',
  later: 'PlannerTasksDueLater',
} as const satisfies Record<DeadlineSection, string>;
const SECTIONS: DeadlineSection[] = ['overdue', 'today', 'week', 'later'];
const PHONE_WIDTH = 600;
const TAB_TITLE_KEYS = {
  deadlines: 'PlannerSectionDeadlines',
  undated: 'PlannerSectionUndated',
  groups: 'PlannerGroups',
} as const satisfies Record<PlannerTasksTab, string>;

// Экран «Задачи» (доски `PhPlanMore`, `DkPlanMore`): «По срокам», «Без даты», «Группы». Телефон — вкладками; на
// компьютере раздел выбирает колонка разделов, вкладок нет, заголовок — раздел («Без даты · 4»), у «Без даты»
// справа — группы. Задаче без даты — «На сегодня» и «Выбрать день»
const PlannerTasks = ({
  state, today, tab, isNarrow, onChangeTab, onOpenTask, onOpenSearch, onClose,
}: OwnProps) => {
  const lang = useLang();
  const isPhone = useWindowSize().width <= PHONE_WIDTH;
  // Задача, для которой выбирается день
  const [pickingId, setPickingId] = useState<string>();

  const undated = useMemo(() => getUndatedTasks(state), [state]);
  const completed = useMemo(() => getCompletedTasks(state), [state]);
  const deadlines = useMemo(() => getDeadlineSections(state, today), [state, today]);

  const segments: PvSegmentItem<PlannerTasksTab>[] = [
    { value: 'deadlines', label: lang('PlannerTasksByDue') },
    { value: 'undated', label: lang('PlannerUndated', { count: undated.length }) },
    { value: 'groups', label: lang('PlannerGroups') },
  ];

  const assignDay = useLastCallback((taskId: string, day: string) => {
    const task = state.tasks.find(({ id }) => id === taskId)!;
    updatePlanner((draft) => {
      draft.tasks.find(({ id }) => id === taskId)!.day = day;
    }, lang('PlannerNoticeMoved', { date: formatDay(lang, day), name: task.name }));
  });

  const handleToday = useLastCallback((taskId: string) => {
    assignDay(taskId, today);
  });

  const handlePick = useLastCallback((taskId: string) => {
    setPickingId(taskId);
  });

  const handlePickClose = useLastCallback(() => {
    setPickingId(undefined);
  });

  const handlePickSubmit = useLastCallback((date: Date) => {
    const taskId = pickingId;
    setPickingId(undefined);
    if (taskId) assignDay(taskId, toDayKey(date));
  });

  function renderDeadlines() {
    if (!deadlines.size) {
      return <PvEmpty title={lang('PlannerTasksNoDue')} text={lang('PlannerTasksNoDueText')} data-tasks-empty />;
    }
    return SECTIONS.filter((section) => deadlines.has(section)).map((section) => (
      <section key={section} data-due-section={section}>
        <h3 className={kit.grp}>{lang(SECTION_KEYS[section])}</h3>
        <div className={styles.list}>
          {deadlines.get(section)!.map((task) => (
            <PlannerTaskRow
              key={task.id}
              task={task}
              context="all"
              color={getListColor(state, task.project)}
              onOpen={onOpenTask}
            />
          ))}
        </div>
      </section>
    ));
  }

  function renderUndated() {
    return (
      <>
        <p className={styles.hint}>{lang('PlannerTasksActiveHint')}</p>
        {isNarrow && <h3 className={kit.grp}>{lang('PlannerUndatedShort')}</h3>}
        {undated.length ? (
          <div className={styles.list} data-planner-undated>
            {undated.map((task) => (
              <PlannerTaskRow
                key={task.id}
                task={task}
                context="all"
                color={getListColor(state, task.project)}
                assignLabel={lang('PlannerTasksForToday')}
                assignTitle={lang('PlannerUndatedAssign', { date: formatDay(lang, today), name: task.name })}
                onAssign={handleToday}
                pickLabel={isPhone ? undefined : lang('PlannerTasksPickDay')}
                isCheckFirst={isPhone}
                onPick={handlePick}
                onOpen={onOpenTask}
              />
            ))}
          </div>
        ) : <p className={styles.hint} data-planner-undated>{lang('PlannerUndatedEmpty')}</p>}
        {Boolean(completed.length) && (
          <details className={styles.fold}>
            <summary className={styles.foldSummary}>{lang('PlannerCompleted', { count: completed.length })}</summary>
            <div className={styles.list}>
              {completed.map((task) => (
                <PlannerTaskRow
                  key={task.id}
                  task={task}
                  context="all"
                  color={getListColor(state, task.project)}
                  onOpen={onOpenTask}
                />
              ))}
            </div>
          </details>
        )}
        {isNarrow && <PlannerGroupsPane state={state} today={today} />}
      </>
    );
  }

  const hasSidePane = !isNarrow && tab === 'undated';
  const title = isNarrow ? lang('PlannerTasksTitle')
    : tab === 'undated' ? lang('PlannerUndated', { count: undated.length }) : lang(TAB_TITLE_KEYS[tab]);

  return (
    <div className={styles.screen} data-planner-tasks={tab}>
      <header className={styles.head}>
        {isNarrow && (
          <button type="button" className={kit.ib} aria-label={lang('Back')} onClick={onClose}>
            <PvIcon name="left" />
          </button>
        )}
        <h2 className={styles.title} data-tasks-title>{title}</h2>
        <button type="button" className={kit.ib} aria-label={lang('PlannerSearchTitle')} onClick={onOpenSearch}>
          <PvIcon name="search" />
        </button>
      </header>
      {isNarrow && (
        <div className={styles.segmentBar}>
          <PvSegment items={segments} value={tab} label={lang('PlannerTasksTabs')} isTabs onChange={onChangeTab} />
        </div>
      )}
      <div className={styles.split}>
        <div className={buildClassName(styles.body, 'custom-scroll')}>
          {tab === 'deadlines' ? renderDeadlines()
            : tab === 'undated' ? renderUndated()
              : <PlannerGroupsPane state={state} today={today} isWide={!isNarrow} />}
        </div>
        {hasSidePane && (
          <aside className={buildClassName(styles.sidePane, 'custom-scroll')}>
            <PlannerGroupsPane state={state} today={today} isWide />
          </aside>
        )}
      </div>
      <CalendarModal
        isOpen={Boolean(pickingId)}
        isFutureMode
        minAt={fromDayKey(today).getTime()}
        selectedAt={fromDayKey(today).getTime()}
        submitButtonLabel={lang('PlannerTasksPickDaySubmit')}
        onClose={handlePickClose}
        onSubmit={handlePickSubmit}
      />
    </div>
  );
};

export default memo(PlannerTasks);
