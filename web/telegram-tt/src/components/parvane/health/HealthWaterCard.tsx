import { memo } from '../../../lib/teact/teact';

import type { HealthMetricView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatNumber, WATER_KIND } from './healthFormat';
import { addHealthEntries } from './healthStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  // Показателя нет, пока нет ни записей, ни цели
  metric?: HealthMetricView;
  onOpen: (kind: string) => void;
};

const GLASS_ML = 250;
const BOTTLE_ML = 500;

// Parvane (spec 041, доска `XdHealth`): блок «Вода» — выпито за день, цель и прибавка стаканом либо бутылкой.
// Прибавка — отдельная запись, сумму дня считает движок
const HealthWaterCard = ({ metric, onOpen }: OwnProps) => {
  const lang = useLang();
  const today = metric?.today ?? 0;
  const goal = metric?.goal;
  const share = goal ? Math.min(1, today / goal) : 0;

  const handleOpen = useLastCallback(() => onOpen(WATER_KIND));

  const handleAdd = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void addHealthEntries([{
      kind: WATER_KIND,
      atMs: Date.now(),
      endMs: 0,
      tzMin: -new Date().getTimezoneOffset(),
      value: Number(e.currentTarget.dataset.ml),
      value2: 0,
      unit: 'ml',
      source: 'button',
    }]);
  });

  return (
    <section className={buildClassName(kit.card, styles.card)} data-health-card={WATER_KIND}>
      <button type="button" className={styles.waterHead} onClick={handleOpen}>
        <span className={buildClassName(kit.caps, kit.grow)}>{lang('HealthKindWater')}</span>
        <span>
          <span className={buildClassName(kit.mono, styles.metricValue)} data-health-value>
            {formatNumber(today, lang.code)}
          </span>
          <span className={kit.muted}>
            {goal !== undefined
              ? ` ${lang('HealthWaterOfGoal', { goal: formatNumber(goal, lang.code) })}`
              : ` ${lang('HealthUnitMl')}`}
          </span>
        </span>
      </button>
      {goal !== undefined && (
        <span className={styles.waterTrack} aria-hidden>
          <span className={styles.waterFill} style={`width: ${share * 100}%`} />
        </span>
      )}
      <div className={styles.cardButtons}>
        <button type="button" className={kit.btn} data-ml={GLASS_ML} data-health-action="glass" onClick={handleAdd}>
          {lang('HealthWaterGlass', { ml: GLASS_ML })}
        </button>
        <button type="button" className={kit.btn} data-ml={BOTTLE_ML} data-health-action="bottle" onClick={handleAdd}>
          {lang('HealthWaterBottle', { ml: BOTTLE_ML })}
        </button>
      </div>
    </section>
  );
};

export default memo(HealthWaterCard);
