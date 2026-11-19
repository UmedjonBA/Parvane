import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { PlannerEvent, PlannerState } from './plannerModel';
import type { ParsedSchedule, ScheduleItem } from './plannerTools';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatRepeat, formatWeekday, listColorStyle,
} from './plannerFormat';
import {
  fromDayKey, getListColor, newId, toDayKey, validateRepeat,
} from './plannerModel';
import { showPlannerNotice, updatePlanner } from './plannerStore';
import { parseScheduleText } from './plannerTools';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';
import PlannerField from './PlannerField';
import PlannerListPicker from './PlannerListPicker';

import kit from '../notes/PvKit.module.scss';
import styles from './PlannerMore.module.scss';

type OwnProps = {
  state: PlannerState;
  today: string;
  isNarrow: boolean;
  onClose: NoneToVoidFunction;
};

type Until = 'none' | 'month' | 'date';

const UNTIL_KEYS = {
  none: 'PlannerImportNoEnd',
  month: 'PlannerImportMonthEnd',
  date: 'PlannerImportPickDate',
} as const satisfies Record<Until, string>;
const EMPTY_SCHEDULE: ParsedSchedule = { items: [], problems: [] };

// «Расписание на неделю» (доски `ZpPlanX`, `XdPlan`): текст → еженедельные события. Текст разбирает движок
// (`plannerScheduleParse`); непонятое — красным и не добавляется. Телефон — экран на весь экран, компьютер — текст
// слева и разбор справа
const PlannerImport = ({
  state, today, isNarrow, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [text, setText] = useState('');
  const [group, setGroup] = useState('');
  // Выбор срока; `date` без выбранной даты берёт срок из текста
  const [untilMode, setUntilMode] = useState<Until>();
  const [pickedDate, setPickedDate] = useState<string>();

  const parsed = useMemo(() => {
    if (!text.trim()) return EMPTY_SCHEDULE;
    try {
      return parseScheduleText(text, today);
    } catch (err) {
      // Движок ещё не поднялся: разбора нет, добавить нечего
      return EMPTY_SCHEDULE;
    }
  }, [text, today]);

  const mode: Until = untilMode || (parsed.until ? 'date' : 'none');
  const endDay = mode === 'none' ? undefined
    : mode === 'month' ? monthEnd(today)
      : pickedDate || parsed.until;
  const count = parsed.items.length;
  const color = getListColor(state, group);

  const handleText = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.currentTarget.value);
  });

  const handleUntil = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setUntilMode(e.currentTarget.dataset.until as Until);
  });

  // Каждая строка — еженедельный ряд с сегодняшнего дня
  const handleAdd = useLastCallback(() => {
    if (!count) {
      showPlannerNotice(lang('PlannerErrorScheduleEmpty'));
      return;
    }
    if (mode === 'date' && (!endDay || endDay < today)) {
      showPlannerNotice(lang('PlannerErrorScheduleUntil'));
      return;
    }
    const events = buildScheduleEvents(parsed.items, today, endDay, group);
    updatePlanner((draft) => {
      draft.events.push(...events);
    }, lang('PlannerNoticeScheduleAdded', { count: events.length }));
    onClose();
  });

  function renderItem(item: ScheduleItem, index: number) {
    const repeat = {
      kind: 'weekly' as const, interval: 1, weekdays: [item.weekday], startDay: today,
    };
    return (
      <div key={index} className={styles.importRow} style={listColorStyle(color)} data-import-item>
        <span className={styles.groupDot} />
        <span className={kit.rowText}>
          <span className={kit.ttl}>{item.name}</span>
          <span className={kit.sub}>
            {item.isEndGuessed ? lang('PlannerImportGuessedEnd') : formatRepeat(lang, repeat)}
          </span>
        </span>
        <span className={buildClassName(kit.mono, kit.sub)}>{`${item.start}–${item.end}`}</span>
      </div>
    );
  }

  function renderParsed() {
    const summary = endDay
      ? lang('PlannerImportUnderstoodUntil', { count, date: formatDay(lang, endDay) })
      : lang('PlannerImportUnderstood', { count });
    return (
      <>
        <h3 className={kit.grp} data-import-summary>{summary}</h3>
        <div className={styles.list}>
          {parsed.items.map(renderItem)}
          {parsed.problems.map((problem, index) => (
            <div
              key={`p${index}`}
              className={buildClassName(styles.importRow, styles.importProblem)}
              data-import-problem
            >
              <span className={styles.groupDot} />
              {problem.weekday !== undefined && (
                <span className={buildClassName(kit.mono, kit.sub)}>
                  {formatWeekday(lang, (problem.weekday + 6) % 7)}
                </span>
              )}
              <span className={buildClassName(kit.rowText, kit.ttl)}>{problem.text}</span>
              <span className={styles.problemMark}>{lang('PlannerImportNotUnderstood')}</span>
            </div>
          ))}
        </div>
        {Boolean(parsed.problems.length) && <p className={styles.hint}>{lang('PlannerImportProblemsHint')}</p>}
      </>
    );
  }

  function renderOptions() {
    return (
      <>
        <h3 className={kit.grp}>{lang('PlannerImportUntil')}</h3>
        <div className={kit.chips} role="group" aria-label={lang('PlannerImportUntil')}>
          {(Object.keys(UNTIL_KEYS) as Until[]).map((value) => (
            <button
              key={value}
              type="button"
              className={buildClassName(kit.chip, mode === value && kit.chipOn)}
              aria-pressed={mode === value}
              data-until={value}
              onClick={handleUntil}
            >
              {lang(UNTIL_KEYS[value])}
            </button>
          ))}
        </div>
        {mode === 'date' && (
          <PlannerField label={lang('PlannerScheduleUntil')} type="date" value={endDay} onCommit={setPickedDate} />
        )}
        <PlannerListPicker id="planner-schedule-list" state={state} value={group} onChange={setGroup} />
      </>
    );
  }

  const addLabel = isNarrow ? lang('PlannerImportAdd') : lang('PlannerImportAddCount', { count });

  return (
    <div className={styles.screen} data-planner-import>
      <header className={styles.head}>
        <button type="button" className={kit.ib} aria-label={lang('Close')} onClick={onClose}>
          <PvIcon name="x" />
        </button>
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>{lang('PlannerScheduleTitle')}</h2>
          {!isNarrow && <span className={kit.sub}>{lang('PlannerImportIntro')}</span>}
        </div>
        {isNarrow && (
          <button type="button" className={styles.headAction} disabled={!count} data-schedule-add onClick={handleAdd}>
            {addLabel}
          </button>
        )}
      </header>
      <div className={buildClassName(styles.importBody, 'custom-scroll')}>
        <div className={styles.importText}>
          {isNarrow && <p className={styles.lead}>{lang('PlannerImportIntro')}</p>}
          <label className={styles.fieldLabel}>
            {lang('PlannerImportText')}
            <textarea
              className={buildClassName(kit.textarea, kit.mono, styles.importInput)}
              value={text}
              placeholder={lang('PlannerImportPlaceholder')}
              data-schedule-input
              onChange={handleText}
            />
          </label>
          {!isNarrow && renderOptions()}
        </div>
        <div className={styles.importParsed}>
          {Boolean(count || parsed.problems.length) && renderParsed()}
          {isNarrow && renderOptions()}
        </div>
      </div>
      {!isNarrow && (
        <footer className={styles.foot}>
          <button type="button" className={kit.btn} onClick={onClose}>{lang('Cancel')}</button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            disabled={!count}
            data-schedule-add
            onClick={handleAdd}
          >
            {addLabel}
          </button>
        </footer>
      )}
    </div>
  );
};

/** События расписания: каждое — еженедельный ряд в свой день с `startDay` (по `endDay` включительно), в группе. */
function buildScheduleEvents(items: ScheduleItem[], startDay: string, endDay?: string, project?: string) {
  return items.map((item): PlannerEvent => ({
    id: newId(),
    name: item.name,
    project: project || undefined,
    description: item.description,
    start: item.start,
    end: item.end,
    repeat: {
      kind: 'weekly', interval: 1, weekdays: [item.weekday], startDay, endDay,
    },
    occurrences: [],
  })).filter((event) => !validateRepeat(event.repeat!));
}

function monthEnd(today: string) {
  const date = fromDayKey(today);
  return toDayKey(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

export default memo(PlannerImport);
