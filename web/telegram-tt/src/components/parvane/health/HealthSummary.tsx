import { memo } from '../../../lib/teact/teact';

import type { HealthBlockId } from '../../../util/parvaneModules';
import type { HealthEntry, HealthMetricView, HealthView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { formatDate } from '../planner/plannerFormat';
import {
  formatDelta, formatNumber, MOOD_KIND, WATER_KIND,
} from './healthFormat';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import HealthBlocksNote from './HealthBlocksNote';
import { HealthActivityCard, HealthNutritionCard } from './HealthDayCards';
import HealthEntries from './HealthEntries';
import HealthMetricCard from './HealthMetricCard';
import HealthPeriodChart from './HealthPeriodChart';
import HealthSleepCard from './HealthSleepCard';
import HealthWaterCard from './HealthWaterCard';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  view: HealthView;
  blocks: HealthBlockId[];
  // Плитки показателей тела по порядку, без выключенных блоков
  metrics: HealthMetricView[];
  recent: HealthEntry[];
  // До 925 px — раскладка телефона (доска `Health`), шире — компьютера (доска `DeskHealth`)
  isNarrow?: boolean;
  onOpen: (kind: string) => void;
  onBed: NoneToVoidFunction;
  onWake: NoneToVoidFunction;
  onEdit: (entry: HealthEntry) => void;
  onOpenBlocks: NoneToVoidFunction;
};

const RECENT_ON_SUMMARY = 8;
const DATE_FORMAT = { weekday: 'long', day: 'numeric', month: 'long' } as const;
const SCORE_KEYS = [
  'HealthMoodScore1', 'HealthMoodScore2', 'HealthMoodScore3', 'HealthMoodScore4', 'HealthMoodScore5',
] as const;

// Parvane (spec 038, 041; доски `Health`, `DeskHealth`): сводка «Здоровья». Телефон — «Сегодня» с датой, сон
// карточкой с мини-столбиками, показатели тела плитками с графиком, самочувствие словом и точками, подпись о
// выключенных блоках. Компьютер — сон с режимом недели слева; справа плитки в ряд, вес за месяц и последние записи
const HealthSummary = ({
  view, blocks, metrics, recent, isNarrow, onOpen, onBed, onWake, onEdit, onOpenBlocks,
}: OwnProps) => {
  const { lang, unitTitle } = useHealthLabels(view.today);
  const water = view.metrics.find((metric) => metric.kind === WATER_KIND);
  const mood = view.metrics.find((metric) => metric.kind === MOOD_KIND);
  const weight = metrics.find((metric) => metric.kind === 'weight');

  const handleOpenSleep = useLastCallback(() => onOpen('sleep'));
  const handleOpenMood = useLastCallback(() => onOpen(MOOD_KIND));
  const handleOpenWeight = useLastCallback(() => onOpen('weight'));

  const sleepCard = blocks.includes('sleep') && (
    <HealthSleepCard
      sleep={view.sleep}
      today={view.today}
      isPhone={isNarrow}
      onOpen={handleOpenSleep}
      onBed={onBed}
      onWake={onWake}
    />
  );
  const dayCards = (
    <>
      {blocks.includes('food') && <HealthNutritionCard nutrition={view.nutrition} onOpen={onOpen} />}
      {blocks.includes('water') && <HealthWaterCard metric={water} onOpen={onOpen} />}
      {blocks.includes('workouts') && <HealthActivityCard activity={view.activity} onOpen={onOpen} />}
    </>
  );

  function renderMood() {
    const score = mood?.last && Math.round(mood.last.value);
    return (
      <button
        type="button"
        className={buildClassName(kit.card, styles.mood)}
        data-health-card="mood"
        onClick={handleOpenMood}
      >
        <span className={kit.grow}>
          <span className={buildClassName(kit.muted, kit.small)}>{lang('HealthKindMood')}</span>
          <span className={styles.moodWord}>
            {score ? capitalize(lang(SCORE_KEYS[score - 1])) : lang('HealthMoodAsk')}
          </span>
        </span>
        {Boolean(score) && (
          <>
            <span className={styles.moodDots} aria-hidden>
              {SCORE_KEYS.map((key, index) => (
                <span
                  key={key}
                  className={buildClassName(styles.moodSmallDot, index < score && styles.moodSmallDotOn)}
                />
              ))}
            </span>
            <span className={buildClassName(kit.muted, kit.small)}>
              {lang('HealthMoodScore', { value: score })}
            </span>
          </>
        )}
      </button>
    );
  }

  if (isNarrow) {
    return (
      <div className={styles.summaryPhone}>
        <div className={styles.todayLine}>
          <b>{capitalize(lang('HealthToday'))}</b>
          <span className={kit.muted}>{formatDate(lang.code, new Date(`${view.today}T12:00:00`), DATE_FORMAT)}</span>
        </div>
        {sleepCard}
        {blocks.includes('body') && (
          <>
            <div className={kit.caps}>{lang('HealthBodyTitle')}</div>
            <div className={styles.metrics}>
              {metrics.map((metric) => (
                <HealthMetricCard key={metric.kind} metric={metric} today={view.today} onOpen={onOpen} />
              ))}
              {!metrics.length && <div className={kit.muted}>{lang('HealthBodyEmpty')}</div>}
            </div>
            {renderMood()}
          </>
        )}
        {dayCards}
        <HealthBlocksNote blocks={blocks} onOpenBlocks={onOpenBlocks} />
      </div>
    );
  }

  const unit = weight ? unitTitle(weight.unit) : '';

  return (
    <div className={styles.summaryWide}>
      <div className={styles.summaryLeft}>
        {sleepCard}
        {dayCards}
      </div>
      <div className={styles.summaryRight}>
        {blocks.includes('body') && (
          <div className={styles.tiles} data-health-body-tiles>
            {metrics.map((metric) => (
              <HealthMetricCard key={metric.kind} metric={metric} today={view.today} isCompact onOpen={onOpen} />
            ))}
            {!metrics.length && <div className={kit.muted}>{lang('HealthBodyEmpty')}</div>}
          </div>
        )}
        {weight && weight.series.length > 0 && (
          <button
            type="button"
            className={buildClassName(kit.card, styles.card, styles.cardButton)}
            data-health-weight-month
            onClick={handleOpenWeight}
          >
            <span className={styles.cardHead}>
              <span className={buildClassName(kit.caps, kit.grow)}>{lang('HealthWeightMonth')}</span>
              <span className={buildClassName(kit.small, styles.good)}>
                {[
                  weight.monthDelta !== undefined ? `${formatDelta(weight.monthDelta, lang.code)} ${unit}` : '',
                  weight.toGoal !== undefined
                    ? lang('HealthWeightToGoal', { value: formatNumber(Math.abs(weight.toGoal), lang.code) })
                    : '',
                ].filter(Boolean).join(' · ')}
              </span>
            </span>
            <HealthPeriodChart metric={weight} period="month" today={view.today} />
          </button>
        )}
        <section className={buildClassName(kit.card, styles.cardList)}>
          <div className={buildClassName(kit.caps, styles.cardListTitle)}>{lang('HealthRecentTitle')}</div>
          <HealthEntries entries={recent.slice(0, RECENT_ON_SUMMARY)} today={view.today} withKind onEdit={onEdit} />
        </section>
      </div>
    </div>
  );
};

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export default memo(HealthSummary);
