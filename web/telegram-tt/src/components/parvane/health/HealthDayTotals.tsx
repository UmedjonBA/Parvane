import { memo, useState } from '../../../lib/teact/teact';

import type { HealthDayTotal, HealthEntry } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatNumber } from './healthFormat';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import HealthEntries from './HealthEntries';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  days: HealthDayTotal[];
  // Записи-прибавки: показываются по раскрытию дня
  entries: HealthEntry[];
  today: string;
  isWide?: boolean;
  onEdit: (entry: HealthEntry) => void;
};

// Parvane (spec 041; доски `RpHealth`, `RdHealth`): записи шагов и воды — итог дня, на компьютере с оценкой
// самочувствия дня и заметкой к ней; нажатие раскрывает прибавки дня. Итоги считает движок (`healthEntries.days`)
const HealthDayTotals = ({
  days, entries, today, isWide, onEdit,
}: OwnProps) => {
  const { lang, dayWord } = useHealthLabels(today);
  const [openDay, setOpenDay] = useState<string>();

  const handleToggle = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { day } = e.currentTarget.dataset;
    setOpenDay(openDay === day ? undefined : day);
  });

  if (!days.length) return <div className={buildClassName(kit.muted, styles.empty)}>{lang('HealthNoEntries')}</div>;

  return (
    <ul className={buildClassName(styles.entries, !isWide && styles.entriesNarrow)} data-health-day-totals>
      {days.map((total) => (
        <li key={total.day} className={styles.entryDay} data-day={total.day}>
          <button
            type="button"
            className={styles.entryMain}
            aria-expanded={openDay === total.day}
            data-day={total.day}
            data-health-day-total
            onClick={handleToggle}
          >
            <span className={styles.entryKind}>{dayWord(total.day)}</span>
            <span className={buildClassName(kit.mono, styles.entryValue)} data-health-value>
              {formatNumber(total.value, lang.code)}
            </span>
            {isWide && total.mood !== undefined && (
              <span className={buildClassName(kit.muted, kit.small, styles.entryNote)}>
                {[`${lang('HealthKindMood').toLowerCase()} ${Math.round(total.mood)}`, total.moodNote]
                  .filter(Boolean).join(' · ')}
              </span>
            )}
          </button>
          {openDay === total.day && (
            <HealthEntries
              entries={entries.filter((entry) => entry.day === total.day)}
              today={today}
              isWide={isWide}
              onEdit={onEdit}
            />
          )}
        </li>
      ))}
    </ul>
  );
};

export default memo(HealthDayTotals);
