import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { formatDuration, formatSpan } from './plannerFormat';

import useLang from '../../../hooks/useLang';

import styles from './PlannerPv.module.scss';

type OwnProps = {
  title: string;
  // Занято и бюджет дня, минуты
  minutes: number;
  budget: number;
  // Подпись раздела вместо заголовка (левая колонка компьютера)
  isCaption?: boolean;
  // Строка под полосой: сколько свободно либо на сколько день перегружен
  withFree?: boolean;
};

const PERCENT = 100;

// Загрузка дня по макету: заголовок, «2:30 из 8:00» и полоса; перегруз — красным
const PlannerLoad = ({
  title, minutes, budget, isCaption, withFree,
}: OwnProps) => {
  const lang = useLang();

  const isOver = minutes > budget;
  const share = budget ? Math.min(1, minutes / budget) * PERCENT : 0;

  return (
    <div className={styles.loadBlock}>
      <div className={styles.loadHead}>
        <span className={buildClassName(styles.loadTitle, isCaption && styles.loadTitleSmall)}>{title}</span>
        <span className={buildClassName(styles.loadValue, isOver && styles.loadOver)} data-day-plan>
          {lang('PlannerLoadOf', { planned: formatSpan(minutes), budget: formatSpan(budget) })}
        </span>
      </div>
      <span className={styles.loadBar} aria-hidden>
        <span className={buildClassName(styles.loadFill, isOver && styles.loadFillOver)} style={`width: ${share}%`} />
      </span>
      {withFree && (
        <span className={styles.loadSub}>
          {isOver
            ? lang('PlannerLoadOver', { value: formatDuration(lang, minutes - budget) })
            : lang('PlannerLoadFree', { value: formatDuration(lang, budget - minutes) })}
        </span>
      )}
    </div>
  );
};

export default memo(PlannerLoad);
