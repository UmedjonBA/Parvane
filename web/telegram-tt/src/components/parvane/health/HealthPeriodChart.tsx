import { memo, useState } from '../../../lib/teact/teact';

import type { HealthPeriod } from './healthPeriods';
import type { HealthMetricView, HealthSleepView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { barShares } from './healthDayFormat';
import { buildSparkline } from './healthFormat';
import {
  metricPoints, PERIOD_KEYS, PERIODS, sleepPoints,
} from './healthPeriods';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  // Показатель либо сон: у сна неделю показывает его карточка, здесь — месяц и год столбиками
  metric?: HealthMetricView;
  sleep?: HealthSleepView;
  today: string;
};

const CHART_WIDTH = 480;
const CHART_HEIGHT = 120;

// Parvane (spec 041 B3; доски `HealthWeight`, `DeskHealthDetail`): график подробного экрана с периодом
// «Неделя / Месяц / Год». Ряды — из движка; показатели-суммы и сон — столбиками, остальные — линией
const HealthPeriodChart = ({ metric, sleep, today }: OwnProps) => {
  const lang = useLang();
  const [period, setPeriod] = useState<HealthPeriod>(sleep ? 'week' : 'month');

  const handlePeriod = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPeriod(e.currentTarget.dataset.healthPeriod as HealthPeriod);
  });

  const isBars = Boolean(sleep) || Boolean(metric?.isSum);
  const values = sleep ? sleepPoints(sleep, period) : metric ? metricPoints(metric, period, today) : [];
  const known = values.filter((value): value is number => value !== undefined);
  const shares = isBars ? barShares(values) : [];

  return (
    <div className={styles.periodChart} data-health-chart={period} data-health-chart-points={known.length}>
      <div className={kit.seg} role="tablist">
        {PERIODS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={item === period}
            className={buildClassName(kit.segItem, item === period && kit.segItemOn)}
            data-health-period={item}
            onClick={handlePeriod}
          >
            {lang(PERIOD_KEYS[item])}
          </button>
        ))}
      </div>
      {isBars ? Boolean(values.length) && (
        <div className={styles.bars} role="img" aria-label={lang(PERIOD_KEYS[period])}>
          {values.map((_value, index) => (
            <span key={index} className={styles.barColumn}>
              <span className={styles.barTrack}>
                <span
                  className={buildClassName(styles.bar, styles.barFull)}
                  style={`height: ${shares[index] * 100}%`}
                />
              </span>
            </span>
          ))}
        </div>
      ) : (
        <svg
          className={styles.chart}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label={lang(PERIOD_KEYS[period])}
        >
          {known.length > 1 && (
            <polyline className={styles.sparkLine} points={buildSparkline(known, CHART_WIDTH, CHART_HEIGHT, 6)} />
          )}
        </svg>
      )}
    </div>
  );
};

export default memo(HealthPeriodChart);
