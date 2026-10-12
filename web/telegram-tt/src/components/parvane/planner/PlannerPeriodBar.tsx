import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useState } from '../../../lib/teact/teact';

import type { PlannerLayer, PlannerLayers } from './plannerLayers';

import buildClassName from '../../../util/buildClassName';
import { formatMonthShort } from './plannerFormat';
import { fromDayKey, getYearMonths, shiftPeriod, toDayKey } from './plannerModel';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import PlannerLayerChips from './PlannerLayerChips';

import styles from './Planner.module.scss';

type OwnProps = {
  // Экран без периода («Сегодня»): вместо заголовка-кнопки, стрелок и слоёв — название экрана
  // (на телефоне — ничего), переключатель вида остаётся
  heading?: string;
  title: string;
  prevLabel: string;
  nextLabel: string;
  picked: string;
  today: string;
  // Телефон: стрелок и слоёв в шапке нет (дни листает жест, слои стоят над календарём)
  isNarrow: boolean;
  segments: { value: string; label: string }[];
  activeSegment: string;
  segmentsLabel: string;
  layers: PlannerLayers;
  // Справа от переключателя вида: настройки, новая запись
  trailing?: TeactNode;
  onPrev: NoneToVoidFunction;
  onNext: NoneToVoidFunction;
  onToday: NoneToVoidFunction;
  onPickDay: (day: string) => void;
  onSwitchSegment: (value: string) => void;
  onToggleLayer: (layer: PlannerLayer) => void;
};

// Шапка календаря: заголовок-кнопка с выбором месяца и года, стрелки, «Текущая дата», слои, переключатель
// вида («Сегодня» — первый его пункт)
const PlannerPeriodBar = ({
  heading, title, prevLabel, nextLabel, picked, today, isNarrow, segments, activeSegment, segmentsLabel, layers,
  trailing, onPrev, onNext, onToday, onPickDay, onSwitchSegment, onToggleLayer,
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
    // День месяца сохраняется, если он есть в выбранном месяце
    const anchor = toDayKey(new Date(pickerYear, month, 1));
    const sameDay = shiftPeriod('month', picked, (pickerYear - fromDayKey(picked).getFullYear()) * 12
      + month - fromDayKey(picked).getMonth());
    onPickDay(sameDay.slice(0, 7) === anchor.slice(0, 7) ? sameDay : anchor);
    closePicker();
  });

  const handleSegmentClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onSwitchSegment(e.currentTarget.dataset.value!);
  });

  const pickedDate = fromDayKey(picked);

  function renderSegments() {
    return (
      <div className={styles.seg} role="group" aria-label={segmentsLabel}>
        {segments.map((segment) => (
          <button
            key={segment.value}
            type="button"
            className={buildClassName(styles.segButton, segment.value === activeSegment && styles.segOn)}
            aria-pressed={segment.value === activeSegment}
            data-value={segment.value}
            onClick={handleSegmentClick}
          >
            {segment.label}
          </button>
        ))}
      </div>
    );
  }

  if (heading !== undefined) {
    return (
      <div className={buildClassName(styles.hdr, styles.calendarHdr)}>
        {!isNarrow && <h1 className={styles.hdrTitle}>{heading}</h1>}
        <span className={styles.grow} />
        {renderSegments()}
        {trailing}
      </div>
    );
  }

  return (
    <div className={buildClassName(styles.hdr, styles.calendarHdr)}>
      <div className={styles.periodNav}>
        <button
          type="button"
          className={styles.periodTitle}
          aria-haspopup="dialog"
          aria-expanded={isPickerOpen}
          title={lang('PlannerPickPeriod')}
          onClick={handleTitleClick}
        >
          {title}
        </button>
        {!isNarrow && (
          <>
            <button type="button" className={styles.ib} aria-label={prevLabel} onClick={onPrev}>
              <Icon name="previous" />
            </button>
            <button type="button" className={styles.ib} aria-label={nextLabel} onClick={onNext}>
              <Icon name="next" />
            </button>
          </>
        )}
        {(!isNarrow || picked !== today) && (
          <button type="button" className={styles.pill} onClick={onToday}>{lang('PlannerJumpToday')}</button>
        )}
        {isPickerOpen && (
          <div className={styles.periodPicker} role="dialog" aria-label={lang('PlannerPickPeriod')}>
            <div className={styles.periodPickerYear}>
              <button type="button" className={styles.ib} aria-label={lang('PlannerPrevYear')} onClick={handlePrevYear}>
                <Icon name="previous" />
              </button>
              <span className={styles.periodPickerYearValue}>{pickerYear}</span>
              <button type="button" className={styles.ib} aria-label={lang('PlannerNextYear')} onClick={handleNextYear}>
                <Icon name="next" />
              </button>
            </div>
            <div className={styles.periodPickerMonths}>
              {getYearMonths(pickerYear).map((month) => (
                <button
                  key={month.getMonth()}
                  type="button"
                  className={buildClassName(
                    styles.periodPickerMonth,
                    pickerYear === pickedDate.getFullYear() && month.getMonth() === pickedDate.getMonth()
                    && styles.periodPickerMonthActive,
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
      <span className={styles.grow} />
      {!isNarrow && <PlannerLayerChips layers={layers} onToggle={onToggleLayer} />}
      {renderSegments()}
      {trailing}
    </div>
  );
};

export default memo(PlannerPeriodBar);
