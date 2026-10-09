import { memo, useState } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { formatMonthShort } from './plannerFormat';
import { fromDayKey, getYearMonths, shiftPeriod, toDayKey } from './plannerModel';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';

import styles from './Planner.module.scss';

type OwnProps = {
  title: string;
  prevLabel: string;
  nextLabel: string;
  picked: string;
  segments: { value: string; label: string }[];
  activeSegment: string;
  segmentsLabel: string;
  onPrev: NoneToVoidFunction;
  onNext: NoneToVoidFunction;
  onToday: NoneToVoidFunction;
  onPickDay: (day: string) => void;
  onSwitchSegment: (value: string) => void;
};

// Панель периода: заголовок-кнопка с выбором месяца и года, стрелки, «Сегодня», переключатель
const PlannerPeriodBar = ({
  title, prevLabel, nextLabel, picked, segments, activeSegment, segmentsLabel,
  onPrev, onNext, onToday, onPickDay, onSwitchSegment,
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

  return (
    <div className={styles.periodBar}>
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
        <Button round size="tiny" color="translucent" iconName="previous" ariaLabel={prevLabel} onClick={onPrev} />
        <Button size="tiny" color="translucent" onClick={onToday}>{lang('PlannerToday')}</Button>
        <Button round size="tiny" color="translucent" iconName="next" ariaLabel={nextLabel} onClick={onNext} />
        {isPickerOpen && (
          <div className={styles.periodPicker} role="dialog" aria-label={lang('PlannerPickPeriod')}>
            <div className={styles.periodPickerYear}>
              <Button
                round
                size="tiny"
                color="translucent"
                iconName="previous"
                ariaLabel={lang('PlannerPrevYear')}
                onClick={handlePrevYear}
              />
              <span className={styles.periodPickerYearValue}>{pickerYear}</span>
              <Button
                round
                size="tiny"
                color="translucent"
                iconName="next"
                ariaLabel={lang('PlannerNextYear')}
                onClick={handleNextYear}
              />
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
      <div className={styles.segments} role="group" aria-label={segmentsLabel}>
        {segments.map((segment) => (
          <button
            key={segment.value}
            type="button"
            className={buildClassName(styles.segment, segment.value === activeSegment && styles.segmentActive)}
            aria-pressed={segment.value === activeSegment}
            data-value={segment.value}
            onClick={handleSegmentClick}
          >
            {segment.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default memo(PlannerPeriodBar);
