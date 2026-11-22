import {
  memo, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';
import type { PlannerSearchFilter, PlannerSearchItem, PlannerSearchResult } from './plannerTools';

import buildClassName from '../../../util/buildClassName';
import {
  formatDayInline, formatDayLabel, formatDuration, formatKind, formatRepeat, formatRepeatShort, formatWeekdayDay,
  joinCaption, listColorStyle,
} from './plannerFormat';
import { getPlannerLayerPrefs } from './plannerLayers';
import { getListColor, toTime } from './plannerModel';
import { buildSearchItems, searchPlanner } from './plannerTools';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';
import PlannerLayersColumn from './PlannerLayersColumn';

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

// Поиск по «Плану». Телефон (доска `RpPlan`): строка, чипы «Всё / События / Задачи / Выполненные», «Впереди · N» и
// «Прошло · N». Компьютер (доска `ZdPlanX`): слева колонка «Слои / Что показывать» (выключенные группы в выдачу не
// попадают), строки в три колонки, «Впереди» и «Прошедшее». Совпадения и порядок решает движок (`plannerSearch`);
// стрелки ходят по результатам, Enter открывает
const PlannerSearch = ({
  state, today, isNarrow, onOpenTask, onOpenEvent, onClose,
}: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const listRef = useRef<HTMLDivElement>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PlannerSearchFilter>('all');
  const [pastLimit, setPastLimit] = useState(PAST_FIRST);
  const layerPrefs = useDerivedState(getPlannerLayerPrefs);
  // Слои-группы и «Что показывать» — только на компьютере, где их видно в колонке
  const hiddenGroups = isNarrow ? undefined : layerPrefs.groupsOff;
  const show = isNarrow ? undefined : layerPrefs.searchShow;

  // Курсор — в поле в кадре появления экрана: набранное сразу не теряется
  useLayoutEffect(() => {
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
        show,
        hiddenGroups,
        today,
        nowMinute: now.getHours() * MINUTES_IN_HOUR + now.getMinutes(),
        aheadLimit: AHEAD_LIMIT,
        pastLimit,
      });
    } catch (err) {
      // Движок ещё не поднялся: результатов просто нет
      return EMPTY_RESULT;
    }
  }, [items, query, filter, show, hiddenGroups, today, pastLimit]);

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

  // Телефон: «ср, 18 ноября, 18:30 · каждую неделю», прошедшее — «ср, 11 ноября · 1 ч 30 мин · выполнено»
  function describe(item: PlannerSearchItem, isPast: boolean) {
    const parts: string[] = [];
    const day = item.day || item.due;
    if (item.kind === 'task') {
      parts.push(lang('PlannerSearchTask'));
      if (item.due && !item.day) parts.push(lang('PlannerSearchDue', { date: formatWeekdayDay(lang, item.due) }));
    }
    if (item.day) {
      const date = item.day === today ? formatDayInline(lang, item.day, today) : formatDayLabel(lang, item.day)
        .toLowerCase();
      parts.push(item.start !== undefined ? `${date}, ${toTime(item.start)}` : date);
    }
    if (isPast && item.start !== undefined && item.end !== undefined) {
      parts.push(formatDuration(lang, item.end - item.start));
    }
    const repeat = item.task?.repeat || item.event?.repeat;
    if (repeat && !isPast) parts.push(formatRepeat(lang, repeat, item.day).toLowerCase());
    if (isPast && item.kind === 'task') parts.push(lang(item.isDone ? 'PlannerSearchWasDone' : 'PlannerSearchMissed'));
    if (!day) parts.push(lang('PlannerUndatedShort').toLowerCase());
    return parts.join(' · ');
  }

  // Компьютер, середина строки: «Спорт · каждую среду», «Личное · задача», «Спорт · выполнено»
  function describeWide(item: PlannerSearchItem, isPast: boolean) {
    const repeat = item.task?.repeat || item.event?.repeat;
    const outcome = isPast && item.kind === 'task'
      ? lang(item.isDone ? 'PlannerSearchWasDone' : 'PlannerSearchMissed') : undefined;
    const kind = item.kind === 'task' ? formatKind(lang, 'task').toLowerCase() : undefined;
    const series = repeat && !isPast ? formatRepeatShort(lang, repeat) : undefined;
    return joinCaption([item.group || lang('PlannerNoList'), outcome || series || kind]);
  }

  // Компьютер, справа: «сегодня · 18:00–19:30», «ср 18 ноября · 18:00», у задачи со сроком — «до пт 20 ноября»
  function describeWhen(item: PlannerSearchItem) {
    if (!item.day) {
      return item.due ? lang('PlannerSearchUntil', { date: formatWeekdayDay(lang, item.due) }) : '';
    }
    const isSpan = item.start !== undefined && item.end !== undefined && item.kind === 'event';
    const time = item.start === undefined ? undefined
      : isSpan ? `${toTime(item.start)}–${toTime(item.end!)}` : toTime(item.start);
    return joinCaption([formatDayInline(lang, item.day, today), time]);
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
          {isNarrow ? (
            <span className={kit.rowText}>
              <span className={kit.ttl}>{item.name}</span>
              <span className={kit.sub}>{describe(item, isPast)}</span>
            </span>
          ) : (
            <>
              <span className={buildClassName(kit.ttl, styles.resultName)}>{item.name}</span>
              <span className={buildClassName(kit.sub, styles.resultMeta)} data-result-meta>
                {describeWide(item, isPast)}
              </span>
              <span className={buildClassName(kit.sub, kit.mono, styles.resultWhen)} data-result-when>
                {describeWhen(item)}
              </span>
            </>
          )}
        </button>
      );
    });
  }

  const total = result.aheadTotal + result.pastTotal;
  const hasQuery = Boolean(query.trim());
  // Названия выключенных слоёв-групп — в подписи и подсказке компьютера
  const offNames = (hiddenGroups || []).map((name) => name || lang('PlannerNoList'));
  const offHint = !offNames.length ? undefined
    : offNames.length === 1 ? lang('PlannerSearchLayerOff', { name: offNames[0] })
      : lang('PlannerSearchLayersOff', { names: offNames.map((name) => `«${name}»`).join(', ') });

  function renderList() {
    return (
      <div ref={listRef} className={buildClassName(styles.body, 'custom-scroll')} aria-live="polite">
        {hasQuery && !total && <p className={styles.hint} data-search-none>{lang('PlannerSearchNone')}</p>}
        {Boolean(result.aheadTotal) && (
          <section data-search-section="ahead">
            <h3 className={kit.grp}>
              {isNarrow ? lang('PlannerSearchAhead', { count: result.aheadTotal }) : lang('PlannerSearchAheadWide')}
            </h3>
            <div className={styles.list}>{renderRows(result.ahead, false)}</div>
          </section>
        )}
        {Boolean(result.pastTotal) && (
          <section data-search-section="past">
            <h3 className={kit.grp}>
              {isNarrow ? lang('PlannerSearchPast', { count: result.pastTotal }) : lang('PlannerSearchPastWide')}
            </h3>
            <div className={styles.list}>{renderRows(result.past, true)}</div>
            {result.pastTotal > result.past.length && (
              <button type="button" className={buildClassName(kit.plain, styles.more)} onClick={handleMore}>
                {lang('PlannerSearchMore', { count: result.pastTotal - result.past.length })}
              </button>
            )}
          </section>
        )}
        {!isNarrow && hasQuery && (
          <p className={styles.hint} data-search-hint>
            {offHint ? `${offHint} ${lang('PlannerSearchKeysHint')}` : lang('PlannerSearchKeysHint')}
          </p>
        )}
      </div>
    );
  }

  if (!isNarrow) {
    return (
      <div className={styles.screenRow} data-planner-search onKeyDown={handleKeyDown}>
        <PlannerLayersColumn state={state} variant="search" />
        <div className={styles.screen}>
          <header className={buildClassName(styles.head, styles.headBare)}>
            <div className={styles.titleBlock}>
              <h2 className={styles.title}>{lang('PlannerSearchTitle')}</h2>
              {hasQuery && (
                <span className={kit.sub} data-search-found>
                  {offNames.length ? lang('PlannerSearchFoundLayers', { count: total })
                    : lang('PlannerSearchFoundCount', { count: total })}
                </span>
              )}
            </div>
            <input
              ref={inputRef}
              className={buildClassName(kit.input, styles.searchInput)}
              type="search"
              value={query}
              aria-label={lang('PlannerSearchTitle')}
              placeholder={lang('PlannerSearchPlaceholderShort')}
              data-planner-search-input
              onChange={handleInput}
            />
            <button type="button" className={kit.btn} disabled={!hasQuery} onClick={handleReset}>
              {lang('PlannerSearchReset')}
            </button>
          </header>
          {renderList()}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen} data-planner-search onKeyDown={handleKeyDown}>
      <header className={styles.head}>
        <button type="button" className={kit.ib} aria-label={lang('Back')} onClick={onClose}>
          <PvIcon name="left" />
        </button>
        <input
          ref={inputRef}
          className={buildClassName(kit.input, styles.searchInput)}
          type="search"
          value={query}
          aria-label={lang('PlannerSearchTitle')}
          placeholder={lang('PlannerSearchPlaceholderShort')}
          data-planner-search-input
          onChange={handleInput}
        />
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
      {renderList()}
    </div>
  );
};

export default memo(PlannerSearch);
