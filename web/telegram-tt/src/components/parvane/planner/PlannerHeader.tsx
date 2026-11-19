import { memo, useState } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { formatMonthShort } from './plannerFormat';
import { fromDayKey, getYearMonths, shiftPeriod, toDayKey } from './plannerModel';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import PvSegment from '../notes/PvSegment';

import styles from './PlannerPv.module.scss';

export type PlannerSegment = { value: string; label: string };

type OwnProps = {
  // Заголовок периода: день, неделя, месяц, год
  title: string;
  // Справа от переключателя на компьютере: загрузка дня («2:30 из 8:00») в виде «День»
  load?: string;
  picked: string;
  today: string;
  isNarrow: boolean;
  segments: PlannerSegment[];
  activeSegment: string;
  prevLabel: string;
  nextLabel: string;
  onPrev: NoneToVoidFunction;
  onNext: NoneToVoidFunction;
  onToday: NoneToVoidFunction;
  onPickDay: (day: string) => void;
  onSwitchSegment: (value: string) => void;
  onOpenQuick: NoneToVoidFunction;
  onOpenSearch: NoneToVoidFunction;
  // Экран «Задачи» (по срокам, без даты, группы)
  onOpenTasks: NoneToVoidFunction;
  onOpenSettings: NoneToVoidFunction;
};

const MONTHS_IN_YEAR = 12;

// Шапка «Плана» по макету. Телефон: название модуля и виды чипами (доска `PhonePlan`). Компьютер: период
// со стрелками, переключатель вида и поле «Запись строкой» (доска `DeskPlan`)
const PlannerHeader = ({
  title, load, picked, today, isNarrow, segments, activeSegment, prevLabel, nextLabel,
  onPrev, onNext, onToday, onPickDay, onSwitchSegment, onOpenQuick, onOpenSearch, onOpenTasks, onOpenSettings,
}: OwnProps) => {
  const lang = useLang();

  const [isPickerOpen, openPicker, closePicker] = useFlag();
  const [pickerYear, setPickerYear] = useState(() => fromDayKey(picked).getFullYear());

  const handleTitleClick = useLastCallback(() => {
    if (isPickerOpen) {
      closePicker();
      return;
    }
    setPickerYear(fromDayKey(picked).getFullYear());
    openPicker();
  });

  const handlePrevYear = useLastCallback(() => setPickerYear(pickerYear - 1));
  const handleNextYear = useLastCallback(() => setPickerYear(pickerYear + 1));

  const handleMonthClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const month = Number(e.currentTarget.dataset.month);
    const pickedDate = fromDayKey(picked);
    // День месяца сохраняется, если он есть в выбранном месяце
    const anchor = toDayKey(new Date(pickerYear, month, 1));
    const sameDay = shiftPeriod(
      'month', picked, (pickerYear - pickedDate.getFullYear()) * MONTHS_IN_YEAR + month - pickedDate.getMonth(),
    );
    onPickDay(sameDay.slice(0, 7) === anchor.slice(0, 7) ? sameDay : anchor);
    closePicker();
  });

  const handleViewClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onSwitchSegment(e.currentTarget.dataset.value!);
  });

  const settingsButton = (
    <button type="button" className={styles.navButton} aria-label={lang('PlannerSettings')} onClick={onOpenSettings}>
      <Icon name="settings" />
    </button>
  );

  const searchButton = (
    <button
      type="button"
      className={styles.navButton}
      aria-label={lang('PlannerSearchTitle')}
      data-planner-search-open
      onClick={onOpenSearch}
    >
      <Icon name="search" />
    </button>
  );

  const tasksButton = (
    <button
      type="button"
      className={styles.navButton}
      aria-label={lang('PlannerTasksTitle')}
      data-planner-tasks-open
      onClick={onOpenTasks}
    >
      <Icon name="check" />
    </button>
  );

  if (isNarrow) {
    return (
      <header className={styles.header}>
        <h1 className={styles.title}>{lang('ParvaneSectionPlanner')}</h1>
        <div className={styles.views} role="group" aria-label={lang('PlannerCalView')}>
          {segments.map((segment) => (
            <button
              key={segment.value}
              type="button"
              className={buildClassName(styles.view, segment.value === activeSegment && styles.viewOn)}
              aria-pressed={segment.value === activeSegment}
              data-value={segment.value}
              onClick={handleViewClick}
            >
              {segment.label}
            </button>
          ))}
        </div>
        {searchButton}
        {tasksButton}
        {settingsButton}
      </header>
    );
  }

  const pickedDate = fromDayKey(picked);

  return (
    <header className={styles.header}>
      <div className={styles.nav}>
        <h1 className={styles.title}>
          <button
            type="button"
            className={styles.titleButton}
            aria-haspopup="dialog"
            aria-expanded={isPickerOpen}
            title={lang('PlannerPickPeriod')}
            onClick={handleTitleClick}
          >
            {title}
          </button>
        </h1>
        <button type="button" className={styles.navButton} aria-label={prevLabel} onClick={onPrev}>
          <Icon name="previous" />
        </button>
        <button type="button" className={styles.navButton} aria-label={nextLabel} onClick={onNext}>
          <Icon name="next" />
        </button>
        <button type="button" className={styles.today} onClick={onToday}>
          {lang('PlannerJumpToday')}
        </button>
        {isPickerOpen && (
          <div className={styles.picker} role="dialog" aria-label={lang('PlannerPickPeriod')}>
            <div className={styles.pickerYear}>
              <button
                type="button"
                className={styles.navButton}
                aria-label={lang('PlannerPrevYear')}
                onClick={handlePrevYear}
              >
                <Icon name="previous" />
              </button>
              <span>{pickerYear}</span>
              <button
                type="button"
                className={styles.navButton}
                aria-label={lang('PlannerNextYear')}
                onClick={handleNextYear}
              >
                <Icon name="next" />
              </button>
            </div>
            <div className={styles.pickerMonths}>
              {getYearMonths(pickerYear).map((month) => (
                <button
                  key={month.getMonth()}
                  type="button"
                  className={buildClassName(
                    styles.pickerMonth,
                    pickerYear === pickedDate.getFullYear() && month.getMonth() === pickedDate.getMonth()
                    && styles.pickerMonthOn,
                  )}
                  data-month={month.getMonth()}
                  onClick={handleMonthClick}
                >
                  {formatMonthShort(lang, month)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <PvSegment
        className={styles.segment}
        items={segments}
        value={activeSegment}
        label={lang('PlannerCalView')}
        onChange={onSwitchSegment}
      />
      {load !== undefined && <span className={styles.load}>{load}</span>}
      <button type="button" className={styles.quick} aria-label={lang('PlannerAddEntry')} onClick={onOpenQuick}>
        <span className={styles.quickText}>{lang('PlannerQuickField')}</span>
        <span className={styles.quickKey}>Enter</span>
      </button>
      {searchButton}
      {tasksButton}
      {settingsButton}
    </header>
  );
};

export default memo(PlannerHeader);
