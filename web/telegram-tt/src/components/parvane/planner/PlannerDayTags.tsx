import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { PlannerLayers } from './plannerLayers';
import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatHours, formatSpan } from './plannerFormat';
import { getDailyRecord, getDayBudget, isShortSleep } from './plannerHealth';
import { formatPlainName } from './plannerLinks';
import { getDayEntry, getNutrientTotal } from './plannerModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';

import styles from './Planner.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
  layers: PlannerLayers;
  onOpenTask: (taskId: string, day?: string) => void;
};

function stopPropagation(e: React.PointerEvent) {
  e.stopPropagation();
}

// Метки дня под полосой загрузки: дела без оценки, сон (недосып — красная метка с подсказкой по нажатию),
// калории и сроки задач. Пустой день меток не показывает
const PlannerDayTags = ({
  state, day, layers, onOpenTask,
}: OwnProps) => {
  const lang = useLang();
  const [isSleepHintShown, setIsSleepHintShown] = useState(false);

  // Подсказка закрывается при смене дня и нажатием в любом месте
  useEffect(() => {
    setIsSleepHintShown(false);
  }, [day]);
  useEffect(() => {
    if (!isSleepHintShown) return undefined;
    const close = () => setIsSleepHintShown(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [isSleepHintShown]);

  const handleSleepClick = useLastCallback(() => setIsSleepHintShown((shown) => !shown));

  const handleDeadlineClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenTask(e.currentTarget.dataset.id!);
  });

  const entry = getDayEntry(state, day);
  const sleep = layers.sleep ? getDailyRecord(state, 'sleep', day) : undefined;
  const isShort = isShortSleep(state, day);
  const kcal = layers.food ? Math.round(getNutrientTotal(state, day, 'kcal').value) : 0;
  const deadlines = layers.work ? entry.deadlines : [];

  if (!entry.unrated && !sleep && !kcal && !deadlines.length) return undefined;

  return (
    <>
      <div className={styles.sumRow} data-day-summary={day}>
        {Boolean(entry.unrated) && (
          <span className={buildClassName(styles.tag, styles.tagLarge, styles.kindMuted)}>
            {lang('PlannerDayUnrated', { count: entry.unrated })}
          </span>
        )}
        {sleep && (isShort ? (
          <button
            type="button"
            className={buildClassName(styles.tag, styles.tagLarge, styles.tagButton, styles.kindDue)}
            aria-expanded={isSleepHintShown}
            data-sleep-short={day}
            onPointerDown={stopPropagation}
            onClick={handleSleepClick}
          >
            <Icon name="darkmode" />
            {formatSpan(sleep.value)}
          </button>
        ) : (
          <span className={buildClassName(styles.tag, styles.tagLarge, styles.kindSleep)}>
            <Icon name="darkmode" />
            {formatSpan(sleep.value)}
          </span>
        ))}
        {Boolean(kcal) && (
          <span className={buildClassName(styles.tag, styles.tagLarge, styles.kindFood)}>
            <Icon name="eats" />
            {lang('PlannerHealthKcal', { value: lang.number(kcal) })}
          </span>
        )}
        {deadlines.map((task) => (
          <button
            key={task.id}
            type="button"
            className={buildClassName(styles.tag, styles.tagLarge, styles.tagButton, styles.kindDue)}
            data-id={task.id}
            onClick={handleDeadlineClick}
          >
            <Icon name="flag" />
            {lang('PlannerDeadlinePreview', { name: formatPlainName(task.name) })}
          </button>
        ))}
      </div>
      {sleep && isShort && isSleepHintShown && (
        <div className={styles.sleepHint} role="tooltip" data-sleep-hint>
          {lang('PlannerSleepWarn', {
            sleep: formatSpan(sleep.value), budget: formatHours(lang, getDayBudget(state, day)),
          })}
        </div>
      )}
    </>
  );
};

export default memo(PlannerDayTags);
