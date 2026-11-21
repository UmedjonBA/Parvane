import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { PlannerEvent } from './plannerModel';
import type { ParsedSchedule, ScheduleItem, ScheduleProblem } from './plannerTools';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatRepeatShort, formatWeekday, joinCaption,
} from './plannerFormat';
import {
  fromDayKey, newId, toDayKey, validateRepeat,
} from './plannerModel';
import { showPlannerNotice, updatePlanner } from './plannerStore';
import { parseScheduleText } from './plannerTools';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';
import PlannerField from './PlannerField';

import kit from '../notes/PvKit.module.scss';
import styles from './PlannerMore.module.scss';

type OwnProps = {
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

// Строка разбора: событие либо непонятый кусок — по порядку текста
type ParsedRow = { item: ScheduleItem; problem?: undefined } | { item?: undefined; problem: ScheduleProblem };

// «Расписание на неделю» (доски `ZpPlanX`, `XdPlan`): текст → еженедельные события. Текст разбирает движок
// (`plannerScheduleParse`); непонятое — красным, на своём месте по порядку текста и не добавляется. Телефон — экран
// на весь экран, компьютер — текст слева и разбор справа строками «пн | 10:00–11:00 | Созвон». Группы у расписания
// нет (ни одна доска её не показывает), срок — чипами (доска `ZpPlanX`, новее `XdPlan`)
const PlannerImport = ({
  today, isNarrow, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [text, setText] = useState('');
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
  const rows = useMemo(() => [
    ...parsed.items.map((item): ParsedRow => ({ item })),
    ...parsed.problems.map((problem): ParsedRow => ({ problem })),
  ].sort((a, b) => (a.item || a.problem).order - (b.item || b.problem).order), [parsed]);

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
    const events = buildScheduleEvents(parsed.items, today, endDay);
    updatePlanner((draft) => {
      draft.events.push(...events);
    }, lang('PlannerNoticeScheduleAdded', { count: events.length }));
    onClose();
  });

  function renderItem(item: ScheduleItem) {
    const repeat = {
      kind: 'weekly' as const, interval: 1, weekdays: [item.weekday], startDay: today,
    };
    const time = `${item.start}–${item.end}`;
    const className = buildClassName(styles.importRow, item.isEndGuessed && styles.importGuessed);
    if (!isNarrow) {
      return (
        <div key={`i${item.order}`} className={className} data-import-item>
          <span className={buildClassName(kit.mono, kit.sub, styles.importDay)}>{weekdayOf(item.weekday)}</span>
          <span className={buildClassName(kit.mono, styles.importTime)}>{time}</span>
          <span className={kit.rowText}>
            <span className={kit.ttl}>{item.name}</span>
            {item.isEndGuessed && <span className={kit.sub}>{lang('PlannerImportGuessedEnd')}</span>}
          </span>
        </div>
      );
    }
    return (
      <div key={`i${item.order}`} className={className} data-import-item>
        <span className={styles.groupDot} />
        <span className={kit.rowText}>
          <span className={kit.ttl}>{item.name}</span>
          <span className={kit.sub}>
            {item.isEndGuessed ? lang('PlannerImportGuessedEnd') : formatRepeatShort(lang, repeat)}
          </span>
        </span>
        <span className={buildClassName(kit.mono, kit.sub)}>{time}</span>
      </div>
    );
  }

  function renderProblem(problem: ScheduleProblem) {
    return (
      <div
        key={`p${problem.order}`}
        className={buildClassName(styles.importRow, styles.importProblem)}
        data-import-problem
      >
        {isNarrow ? <span className={styles.groupDot} /> : (
          <>
            <span className={buildClassName(kit.mono, kit.sub, styles.importDay)}>
              {problem.weekday !== undefined ? weekdayOf(problem.weekday) : '—'}
            </span>
            <span className={buildClassName(kit.mono, styles.importTime)}>—</span>
          </>
        )}
        <span className={buildClassName(kit.rowText, kit.ttl)}>
          {isNarrow || problem.weekday === undefined ? problem.text : problem.rest || problem.text}
        </span>
        <span className={styles.problemMark}>{lang('PlannerImportNotUnderstood')}</span>
      </div>
    );
  }

  function weekdayOf(weekday: number) {
    return formatWeekday(lang, (weekday + 6) % 7).toLowerCase();
  }

  // «Понято: 5 событий · до 31 декабря»; без срока на телефоне — «· без конца» (доска `ZpPlanX`)
  const eventsText = lang('PlannerImportEvents', { count }, { pluralValue: count });
  const summary = joinCaption([
    lang('PlannerImportUnderstoodCount', { events: eventsText }),
    endDay ? lang('PlannerImportUntilDate', { date: formatDay(lang, endDay) })
      : isNarrow ? lang('PlannerImportNoEnd').toLowerCase() : undefined,
  ]);
  const problems = parsed.problems;
  // Компьютер: подсказка называет непонятую строку (доска `XdPlan`); телефон — общая, всегда под сроком
  const problemHint = !problems.length ? undefined : problems.length === 1
    ? lang('PlannerImportProblemLine', { text: problems[0].text })
    : lang('PlannerImportProblemLines', { text: problems[0].text, count: problems.length - 1 });

  function renderParsed() {
    return (
      <>
        <h3 className={kit.grp} data-import-summary>{summary}</h3>
        <div className={styles.list}>
          {rows.map((row) => (row.item ? renderItem(row.item) : renderProblem(row.problem)))}
        </div>
        {!isNarrow && Boolean(problemHint) && <p className={styles.hint} data-import-hint>{problemHint}</p>}
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
        {isNarrow && <p className={styles.hint} data-import-hint>{lang('PlannerImportProblemsHint')}</p>}
      </>
    );
  }

  const addLabel = isNarrow ? lang('PlannerImportAdd') : lang('PlannerImportAddEvents', { events: eventsText });

  return (
    <div className={styles.screen} data-planner-import>
      <header className={styles.head}>
        {isNarrow && (
          <button type="button" className={kit.ib} aria-label={lang('Close')} onClick={onClose}>
            <PvIcon name="x" />
          </button>
        )}
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

/** События расписания: каждое — еженедельный ряд в свой день с `startDay` (по `endDay` включительно). */
function buildScheduleEvents(items: ScheduleItem[], startDay: string, endDay?: string) {
  return items.map((item): PlannerEvent => ({
    id: newId(),
    name: item.name,
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
