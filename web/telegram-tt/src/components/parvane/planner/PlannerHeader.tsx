import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerLearnedWord, PlannerSettings } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatMonthShort } from './plannerFormat';
import { fromDayKey, getYearMonths, shiftPeriod, toDayKey } from './plannerModel';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import CloudMenu from '../cloud/CloudMenu';
import PvSegment from '../notes/PvSegment';
import PlannerQuickField from './PlannerQuickField';
import { PlannerYearLegend } from './PlannerYear';

import styles from './PlannerPv.module.scss';

export type PlannerSegment = { value: string; label: string };

type OwnProps = {
  // Заголовок периода: день, неделя, месяц, год
  title: string;
  // Справа от переключателя на компьютере: загрузка дня («2:30 из 8:00») в виде «День»
  load?: string;
  // Вид «Год» на компьютере: легенда ступеней загрузки справа от переключателя (доска `XdPlan`)
  isYear?: boolean;
  picked: string;
  today: string;
  isNarrow: boolean;
  // Телефон: три чипа вида и меню «⋯»
  isPhone?: boolean;
  segments: PlannerSegment[];
  activeSegment: string;
  prevLabel: string;
  nextLabel: string;
  onPrev: NoneToVoidFunction;
  onNext: NoneToVoidFunction;
  onToday: NoneToVoidFunction;
  onPickDay: (day: string) => void;
  onSwitchSegment: (value: string) => void;
  // Поле «Запись строкой» на компьютере: разбор по настройкам дня и словарю правок
  settings: PlannerSettings;
  learnedWords: PlannerLearnedWord[];
  // Окно ввода текстом: пустое («+ Запись») либо со строкой из поля
  onOpenQuick: NoneToVoidFunction;
  onQuickMore: (text: string) => void;
  onQuickCreated: (day?: string) => void;
  onOpenSearch: NoneToVoidFunction;
  // Экран «Задачи» (по срокам, без даты, группы)
  onOpenTasks: NoneToVoidFunction;
  onOpenSettings: NoneToVoidFunction;
};

const MONTHS_IN_YEAR = 12;
// Чипы вида в шапке телефона (доска `PhonePlan`); «Список» и «Год» — в меню «⋯»
const PHONE_SEGMENTS = ['today', 'week', 'month'];

// Шапка «Плана» по макету. Телефон: название модуля и виды чипами (доска `PhonePlan`). Компьютер: период
// со стрелками, переключатель вида и поле «Запись строкой» с разбором (доска `DeskPlan`); «+ Запись» рядом —
// окно ввода с подробностями. Поиск, «Задачи» и настройки — функции сверх доски, остаются
const PlannerHeader = ({
  title, load, isYear, picked, today, isNarrow, isPhone, segments, activeSegment, prevLabel, nextLabel, settings,
  learnedWords,
  onPrev, onNext, onToday, onPickDay, onSwitchSegment, onOpenQuick, onQuickMore, onQuickCreated, onOpenSearch,
  onOpenTasks, onOpenSettings,
}: OwnProps) => {
  const lang = useLang();

  const [isPickerOpen, openPicker, closePicker] = useFlag();
  const [isMoreOpen, openMore, closeMore] = useFlag();
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

  const handleMorePick = useLastCallback((key: string) => {
    closeMore();
    if (key === 'search') onOpenSearch();
    else if (key === 'tasks') onOpenTasks();
    else if (key === 'settings') onOpenSettings();
    else onSwitchSegment(key);
  });

  const handleYearBack = useLastCallback(() => onSwitchSegment('month'));

  const label = (value: string) => segments.find((segment) => segment.value === value)!.label;
  const moreActions = !isPhone ? [] : [
    ...(activeSegment === 'today' || activeSegment === 'week' || activeSegment === 'month' ? ['agenda', 'year']
      : ['week', 'month', activeSegment === 'year' ? 'agenda' : 'year'])
      .map((value) => ({ key: value, title: label(value) })),
    { key: 'search', title: lang('PlannerSearchTitle') },
    { key: 'tasks', title: lang('PlannerTasksTitle') },
    { key: 'settings', title: lang('PlannerSettings') },
  ];
  const moreButton = (
    <>
      <button
        type="button"
        className={styles.backButton}
        aria-label={lang('MenuMore')}
        aria-haspopup="menu"
        data-planner-more
        onClick={openMore}
      >
        <Icon name="more" />
      </button>
      <CloudMenu isOpen={isMoreOpen} actions={moreActions} onPick={handleMorePick} onClose={closeMore} />
    </>
  );

  if (isPhone && activeSegment === 'year') {
    return (
      <header className={buildClassName(styles.header, styles.headerBack)}>
        <button type="button" className={styles.backButton} aria-label={lang('Back')} onClick={handleYearBack}>
          <Icon name="arrow-left" />
        </button>
        <h1 className={buildClassName(styles.title, styles.titleGrow)}>{title}</h1>
        <button type="button" className={styles.backButton} aria-label={prevLabel} onClick={onPrev}>
          <Icon name="previous" />
        </button>
        <button type="button" className={styles.backButton} aria-label={nextLabel} onClick={onNext}>
          <Icon name="next" />
        </button>
        {moreButton}
      </header>
    );
  }

  if (isPhone) {
    const shown = activeSegment === 'agenda' ? ['today', 'agenda'] : PHONE_SEGMENTS;
    return (
      <header className={styles.header}>
        <h1 className={buildClassName(styles.title, styles.titleGrow)}>{lang('ParvaneSectionPlanner')}</h1>
        <div className={styles.viewsEnd} role="group" aria-label={lang('PlannerCalView')}>
          {shown.map((value) => (
            <button
              key={value}
              type="button"
              className={buildClassName(styles.view, value === activeSegment && styles.viewOn)}
              aria-pressed={value === activeSegment}
              data-value={value}
              onClick={handleViewClick}
            >
              {label(value)}
            </button>
          ))}
        </div>
        {moreButton}
      </header>
    );
  }

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
        {/* «Текущая дата» — только когда выбран другой день: иначе шапка не помещается в одну строку (доска `DeskPlan`) */}
        {picked !== today && (
          <button type="button" className={styles.today} onClick={onToday}>
            {lang('PlannerJumpToday')}
          </button>
        )}
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
      {isYear && <PlannerYearLegend />}
      <PlannerQuickField
        today={today}
        settings={settings}
        learnedWords={learnedWords}
        onMore={onQuickMore}
        onCreated={onQuickCreated}
      />
      <button
        type="button"
        className={styles.navButton}
        aria-label={lang('PlannerAddEntry')}
        title={lang('PlannerQuickMoreTitle')}
        onClick={onOpenQuick}
      >
        <Icon name="add" />
      </button>
      {searchButton}
      {tasksButton}
      {settingsButton}
    </header>
  );
};

export default memo(PlannerHeader);
