import { memo } from '../../../lib/teact/teact';

import type { HealthEntry, HealthRegimeState, HealthView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatNumber, MOOD_KIND } from './healthFormat';
import { shiftDay } from './healthPeriods';
import useHealthLabels from './useHealthLabels';

import HealthEntries from './HealthEntries';
import HealthMoodScale from './HealthMoodScale';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  view: HealthView;
  isWide?: boolean;
  entries: HealthEntry[];
  onEdit: (entry: HealthEntry) => void;
};

const GRID_DAYS = 14;
const REGIME_KEYS: Record<HealthRegimeState, string> = {
  stable: 'HealthRegimeStable',
  floating: 'HealthRegimeFloating',
  off: 'HealthRegimeOff',
  few: 'HealthRegimeFew',
};

// Parvane (spec 041, доска `XpHealth`): самочувствие — шкала из пяти точек с заметкой, оценки за две недели
// клетками цветом оценки, вывод о связи со сном и режим сна недели. Связь со сном и режим считает движок
// (`moodSleep`, `sleep.stats.regime`)
const HealthMoodDetail = ({
  view, isWide, entries, onEdit,
}: OwnProps) => {
  const { lang, shortDuration } = useHealthLabels(view.today);
  const mood = view.metrics.find((metric) => metric.kind === MOOD_KIND);
  const days = Array.from({ length: GRID_DAYS }, (_item, index) => shiftDay(view.today, index - GRID_DAYS + 1));
  const { regime } = view.sleep.stats;
  const { delta } = view.moodSleep;

  function renderInsight() {
    if (delta === undefined || Math.abs(delta) < 0.5) return undefined;
    return (
      <div className={buildClassName(kit.muted, kit.small)} data-health-mood-insight>
        {lang(delta < 0 ? 'HealthMoodLowSleepLower' : 'HealthMoodLowSleepHigher', {
          value: formatNumber(Math.abs(delta), lang.code),
        })}
      </div>
    );
  }

  return (
    <div className={buildClassName(styles.detail, isWide && styles.detailMood)} data-health-card={MOOD_KIND}>
      <HealthMoodScale />
      <section className={buildClassName(kit.card, styles.card)}>
        <div className={kit.caps}>{lang('HealthMoodTwoWeeks')}</div>
        <div className={styles.moodGrid} data-health-mood-grid>
          {days.map((day) => {
            const point = mood?.series.find((item) => item.day === day);
            const score = point && Math.round(point.value);
            return (
              <span
                key={day}
                className={buildClassName(
                  styles.moodCell, score !== undefined && styles[`moodCell${score}` as 'moodCell1'],
                )}
                data-day={day}
                data-score={score}
              >
                {score ?? ''}
              </span>
            );
          })}
        </div>
        {renderInsight()}
      </section>
      <div className={kit.caps}>{lang('HealthSleepRegimeCaps')}</div>
      <section
        className={buildClassName(kit.card, styles.card, styles.regimeCard)}
        data-health-regime-state={regime.state}
      >
        <span className={buildClassName(styles.regimeDot, styles[`regime_${regime.state}`])} />
        <span className={styles.regimeText}>
          <span>{lang(REGIME_KEYS[regime.state] as 'HealthRegimeStable')}</span>
          {regime.state !== 'few' && regime.bedSpreadMin !== undefined && (
            <span className={buildClassName(kit.muted, kit.small)}>
              {lang('HealthRegimeSpread', { duration: shortDuration(regime.bedSpreadMin) })}
            </span>
          )}
        </span>
      </section>
      <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthRegimeLegend')}</div>
      <div className={kit.caps}>{lang('HealthEntriesTitle')}</div>
      <HealthEntries entries={entries} today={view.today} isWide={isWide} onEdit={onEdit} />
    </div>
  );
};

export default memo(HealthMoodDetail);
