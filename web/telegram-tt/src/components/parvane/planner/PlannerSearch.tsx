import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';
import type { PlannerSearchFilter, PlannerSearchItem, PlannerSearchResult } from './plannerTools';

import buildClassName from '../../../util/buildClassName';
import {
  formatDay, formatDuration, formatRelativeDay, formatRepeat, listColorStyle,
} from './plannerFormat';
import { getListColor, toTime } from './plannerModel';
import { buildSearchItems, searchPlanner } from './plannerTools';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';

import kit from '../notes/PvKit.module.scss';
import styles from './PlannerMore.module.scss';

type OwnProps = {
  state: PlannerState;
  today: string;
  isNarrow: boolean;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
  onClose: NoneToVoidFunction;
};

const FILTERS: { value: PlannerSearchFilter; key: 'PlannerSearchAll' | 'PlannerSearchEvents' | 'PlannerSearchTasks'
  | 'PlannerSearchDone'; }[] = [
  { value: 'all', key: 'PlannerSearchAll' },
  { value: 'events', key: 'PlannerSearchEvents' },
  { value: 'tasks', key: 'PlannerSearchTasks' },
  { value: 'done', key: 'PlannerSearchDone' },
];
const AHEAD_LIMIT = 30;
const PAST_FIRST = 3;
const PAST_STEP = 10;
const MINUTES_IN_HOUR = 60;
const EMPTY_RESULT: PlannerSearchResult = {
  ahead: [], past: [], aheadTotal: 0, pastTotal: 0,
};

// Поиск по «Плану» (доски `RpPlan`, `ZdPlanX`): строка, чипы «Всё / События / Задачи / Выполненные», «Впереди» и
// «Прошло». Совпадения и порядок решает движок (`plannerSearch`); стрелки ходят по результатам, Enter открывает
const PlannerSearch = ({
  state, today, isNarrow, onOpenTask, onOpenEvent, onClose,
}: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const listRef = useRef<HTMLDivElement>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PlannerSearchFilter>('all');
  const [pastLimit, setPastLimit] = useState(PAST_FIRST);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo(() => buildSearchItems(state, today), [state, today]);
  const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);

  const result = useMemo(() => {
    if (!query.trim()) return EMPTY_RESULT;
    const now = new Date();
    try {
      return searchPlanner({
        items,
        query,
        filter,
        today,
        nowMinute: now.getHours() * MINUTES_IN_HOUR + now.getMinutes(),
        aheadLimit: AHEAD_LIMIT,
        pastLimit,
      });
    } catch (err) {
      // Движок ещё не поднялся: результатов просто нет
      return EMPTY_RESULT;
    }
  }, [items, query, filter, today, pastLimit]);

  const handleInput = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
    setPastLimit(PAST_FIRST);
  });

  const handleReset = useLastCallback(() => {
    setQuery('');
    inputRef.current?.focus();
  });

  const handleFilter = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setFilter(e.currentTarget.dataset.filter as PlannerSearchFilter);
    setPastLimit(PAST_FIRST);
  });

  const handleMore = useLastCallback(() => {
    setPastLimit((current) => current + PAST_STEP);
  });

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const item = byKey.get(e.currentTarget.dataset.key!);
    if (!item) return;
    if (item.task) onOpenTask(item.task.id, item.task.repeat ? item.day : undefined);
    else if (item.event && item.day) onOpenEvent(item.event.id, item.day);
  });

  // Стрелки — по строкам результатов (из поля — на первую), Enter на строке её открывает, Escape — назад
  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-key]') || []);
    if (!rows.length) return;
    e.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : index - 1;
    if (next < 0) inputRef.current?.focus();
    else rows[next].focus();
  });

  function describe(item: PlannerSearchItem, isPast: boolean) {
    const parts: string[] = [];
    const day = item.day || item.due;
    if (item.kind === 'task') {
      parts.push(lang('PlannerSearchTask'));
      if (item.due && !item.day) parts.push(lang('PlannerSearchDue', { date: formatDay(lang, item.due) }));
    }
    if (item.day) {
      const date = isPast ? formatDay(lang, item.day) : formatRelativeDay(lang, item.day, today).toLowerCase();
      parts.push(item.start !== undefined ? `${date}, ${toTime(item.start)}` : date);
    }
    if (isPast && item.start !== undefined && item.end !== undefined) {
      parts.push(formatDuration(lang, item.end - item.start));
    }
    const repeat = item.task?.repeat || item.event?.repeat;
    if (repeat && !isPast) parts.push(formatRepeat(lang, repeat).toLowerCase());
    if (isPast && item.kind === 'task') parts.push(lang(item.isDone ? 'PlannerSearchWasDone' : 'PlannerSearchMissed'));
    if (!day) parts.push(lang('PlannerUndatedShort').toLowerCase());
    return parts.join(' · ');
  }

  function renderRows(keys: string[], isPast: boolean) {
    return keys.map((key) => {
      const item = byKey.get(key);
      if (!item) return undefined;
      return (
        <button
          key={key}
          type="button"
          className={buildClassName(kit.row, styles.resultRow, isPast && styles.resultPast)}
          style={listColorStyle(getListColor(state, item.group || ''))}
          data-key={key}
          data-kind={item.kind}
          onClick={handleOpen}
        >
          <span className={styles.groupDot} />
          <span className={kit.rowText}>
            <span className={kit.ttl}>{item.name}</span>
            <span className={kit.sub}>{describe(item, isPast)}</span>
          </span>
        </button>
      );
    });
  }

  const total = result.aheadTotal + result.pastTotal;
  const hasQuery = Boolean(query.trim());

  return (
    <div className={styles.screen} data-planner-search onKeyDown={handleKeyDown}>
      <header className={styles.head}>
        <button type="button" className={kit.ib} aria-label={lang('Back')} onClick={onClose}>
          <PvIcon name="left" />
        </button>
        {!isNarrow && (
          <div className={styles.titleBlock}>
            <h2 className={styles.title}>{lang('PlannerSearchTitle')}</h2>
            {hasQuery && <span className={kit.sub}>{lang('PlannerSearchFound', { count: total })}</span>}
          </div>
        )}
        <input
          ref={inputRef}
          className={buildClassName(kit.input, styles.searchInput)}
          type="search"
          value={query}
          aria-label={lang('PlannerSearchTitle')}
          placeholder={lang('PlannerSearchPlaceholder')}
          data-planner-search-input
          onChange={handleInput}
        />
        {hasQuery && (
          <button type="button" className={kit.btn} onClick={handleReset}>{lang('PlannerSearchReset')}</button>
        )}
      </header>
      <div className={buildClassName(kit.chips, styles.segmentBar)} role="group" aria-label={lang('PlannerSearchShow')}>
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={buildClassName(kit.chip, filter === item.value && kit.chipOn)}
            aria-pressed={filter === item.value}
            data-filter={item.value}
            onClick={handleFilter}
          >
            {lang(item.key)}
          </button>
        ))}
      </div>
      <div ref={listRef} className={buildClassName(styles.body, 'custom-scroll')} aria-live="polite">
        {hasQuery && !total && <p className={styles.hint} data-search-none>{lang('PlannerSearchNone')}</p>}
        {Boolean(result.aheadTotal) && (
          <section data-search-section="ahead">
            <h3 className={kit.grp}>{lang('PlannerSearchAhead', { count: result.aheadTotal })}</h3>
            <div className={styles.list}>{renderRows(result.ahead, false)}</div>
          </section>
        )}
        {Boolean(result.pastTotal) && (
          <section data-search-section="past">
            <h3 className={kit.grp}>{lang('PlannerSearchPast', { count: result.pastTotal })}</h3>
            <div className={styles.list}>{renderRows(result.past, true)}</div>
            {result.pastTotal > result.past.length && (
              <button type="button" className={buildClassName(kit.plain, styles.more)} onClick={handleMore}>
                {lang('PlannerSearchMore', { count: result.pastTotal - result.past.length })}
              </button>
            )}
          </section>
        )}
        {!isNarrow && hasQuery && <p className={styles.hint}>{lang('PlannerSearchKeysHint')}</p>}
      </div>
    </div>
  );
};

export default memo(PlannerSearch);
