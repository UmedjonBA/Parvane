import { memo } from '../../../lib/teact/teact';

import type { HealthGoalTarget } from './HealthGoalSheet';
import type { HealthPeriod } from './healthPeriods';
import type { HealthEntriesPage } from './healthStore';
import type { HealthEntry, HealthMetricView, HealthView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import {
  formatDelta, formatNumber, formatValue, MOOD_KIND, MOOD_MAX,
} from './healthFormat';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import HealthDayTotals from './HealthDayTotals';
import HealthEntries from './HealthEntries';
import HealthGoalRow from './HealthGoalRow';
import HealthPeriodChart from './HealthPeriodChart';
import HealthQuickInput from './HealthQuickInput';
import HealthRecordForm from './HealthRecordForm';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  view: HealthView;
  metric?: HealthMetricView;
  kind: string;
  period: HealthPeriod;
  isWide?: boolean;
  entries: HealthEntry[];
  page?: HealthEntriesPage;
  onEdit: (entry: HealthEntry) => void;
  onGoal: (target: HealthGoalTarget) => void;
};

type Tile = { id: string; title: string; value: string; tone?: 'good' | 'warn' };

// Пример строки ввода по экрану (доски `HealthWeight`, `XpHealth`, `RpHealth`, `RdHealth`)
const LINE_EXAMPLES: Record<string, string> = {
  weight: 'HealthLineWeight',
  pressure: 'HealthLinePressure',
  pulse: 'HealthLinePulse',
  steps: 'HealthLineSteps',
};
const PERIOD_AVG_KEYS = {
  week: 'HealthTileWeekAvg', month: 'HealthTileMonthAvg', year: 'HealthTileYearAvg',
} as const;
const PERIOD_SUFFIX_KEYS = {
  week: 'HealthPerWeekSuffix', month: 'HealthPerMonthSuffix', year: 'HealthPerYearSuffix',
} as const;

// Parvane (spec 041; доски `HealthWeight`, `XpHealth`, `RpHealth`, `DeskHealthDetail`, `RdHealth`, `ZdHealthX`):
// подробный экран показателя. Компьютер — четыре плитки, график во всю ширину, записи и цель рядом (в цели — форма
// «Записать» и «Записать строкой»); телефон — значение с изменением, график, цель, «Записать», записи. Числа —
// из движка (`periods`, `paceWeek`, `delta`, итоги дней)
const HealthMetricDetail = ({
  view, metric, kind, period, isWide, entries, page, onEdit, onGoal,
}: OwnProps) => {
  const {
    lang, unitTitle, entryTitle, dayWord,
  } = useHealthLabels(view.today);
  const unit = metric ? unitTitle(metric.unit) : '';
  const number = (value: number) => formatNumber(value, lang.code);
  const withUnit = (text: string) => (unit && kind !== 'pressure' && kind !== 'steps' ? `${text} ${unit}` : text);
  const stats = metric?.periods[period];
  const last = metric?.last;
  const goal = metric?.goal;
  const isSum = Boolean(metric?.isSum);
  const delta = period === 'week' ? metric?.weekDelta : period === 'month' ? metric?.monthDelta : metric?.yearDelta;
  const pulse = view.metrics.find((item) => item.kind === 'pulse');
  const mood = view.metrics.find((item) => item.kind === MOOD_KIND);

  const deltaTone = (value: number) => (goal === undefined || !last ? undefined
    : (value < 0) === (last.value > goal) ? 'good' : 'warn');

  function currentValue() {
    if (isSum) return number(metric?.today ?? 0);
    return last ? formatValue(last, lang.code) : '—';
  }

  function avgText(stat = stats) {
    if (stat?.avg === undefined) return '—';
    return kind === 'pressure' ? `${Math.round(stat.avg)}/${Math.round(stat.avg2 ?? 0)}` : number(stat.avg);
  }

  function buildTiles(): Tile[] {
    const count = { id: 'count', title: lang('HealthTileCount'), value: number(stats?.count ?? 0) };
    if (kind === 'weight') {
      return [
        { id: 'last', title: lang('HealthTileToday'), value: withUnit(currentValue()) },
        {
          id: 'delta',
          title: capitalize(lang(PERIOD_SUFFIX_KEYS[period])),
          value: delta !== undefined ? withUnit(formatDelta(delta, lang.code)) : '—',
          tone: delta !== undefined ? deltaTone(delta) : undefined,
        },
        {
          id: 'toGoal',
          title: lang('HealthTileToGoal'),
          value: metric?.toGoal !== undefined
            ? withUnit(formatValue({ kind, value: Math.abs(metric.toGoal), value2: 0 }, lang.code)) : '—',
        },
        {
          id: 'pace',
          title: lang('HealthTilePace'),
          value: metric?.paceWeek !== undefined
            ? `${formatDelta(metric.paceWeek, lang.code)}/${lang('HealthWeekShort')}` : '—',
        },
      ];
    }
    if (kind === 'pressure') {
      return [
        { id: 'last', title: lang('HealthTileLast'), value: currentValue() },
        { id: 'avg', title: lang(PERIOD_AVG_KEYS[period]), value: avgText() },
        { id: 'pulse', title: lang('HealthKindPulse'), value: pulse?.last ? formatValue(pulse.last, lang.code) : '—' },
        count,
      ];
    }
    if (kind === 'steps') {
      return [
        { id: 'last', title: lang('HealthTileToday'), value: currentValue() },
        { id: 'avg', title: lang('HealthTileAvg'), value: avgText() },
        {
          id: 'goalDays',
          title: lang('HealthTileGoalDays'),
          value: stats?.goalDays !== undefined
            ? lang('HealthOfTotal', { value: number(stats.goalDays), total: number(stats.spanDays) }) : '—',
        },
        {
          id: 'mood',
          title: lang('HealthKindMood'),
          value: mood?.periods[period].avg !== undefined
            ? lang('HealthOfTotal', { value: number(mood.periods[period].avg), total: MOOD_MAX }) : '—',
        },
      ];
    }
    return [
      { id: 'last', title: lang(isSum ? 'HealthTileToday' : 'HealthTileLast'), value: withUnit(currentValue()) },
      {
        id: 'delta',
        title: capitalize(lang(PERIOD_SUFFIX_KEYS[period])),
        value: delta !== undefined ? formatDelta(delta, lang.code) : '—',
        tone: delta !== undefined ? deltaTone(delta) : undefined,
      },
      { id: 'avg', title: lang('HealthTileAvg'), value: avgText() },
      count,
    ];
  }

  function goalText() {
    if (kind === 'pressure') {
      return goal === undefined ? lang('HealthPressureGoalNone')
        : lang('HealthPressureGoalValue', { value: number(goal), unit });
    }
    if (goal === undefined) return lang('HealthGoalNone');
    if (kind === 'steps') return `${number(goal)} ${lang('HealthStepsPerDay')}`;
    if (kind === 'weight' && metric?.paceWeek !== undefined) {
      return lang('HealthWeightGoalPace', {
        value: formatValue({ kind, value: goal, value2: 0 }, lang.code),
        pace: formatDelta(metric.paceWeek, lang.code),
      });
    }
    return withUnit(kind === 'weight' ? formatValue({ kind, value: goal, value2: 0 }, lang.code) : number(goal));
  }

  const handleGoal = useLastCallback(() => {
    onGoal({
      kind,
      title: lang('HealthGoalLabel'),
      unit: kind === 'steps' ? lang('HealthStepsPerDay') : unit,
      value: goal,
      hint: kind === 'pressure' ? lang('HealthPressureGoalHint') : undefined,
    });
  });

  function renderGoalCard() {
    if (!isWide) {
      const isUnset = goal === undefined;
      return <HealthGoalRow kind={kind} text={isUnset ? lang('HealthGoalEmpty') : goalText()} onEdit={handleGoal} />;
    }
    return (
      <section className={buildClassName(kit.card, styles.card)} data-health-goal-card={kind}>
        <div className={styles.cardHead}>
          <span className={buildClassName(kit.caps, kit.grow)}>{lang('HealthGoalLabel')}</span>
        </div>
        <div className={kit.mono} data-health-goal-text>{goalText()}</div>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnWide)}
          data-health-goal-edit={kind}
          onClick={handleGoal}
        >
          {lang('HealthGoalChange')}
        </button>
        <HealthRecordForm kind={kind} metric={metric} />
        <span className={kit.grow} />
        <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthQuickLine')}</div>
        <HealthQuickInput isCompact placeholder={lineExample()} />
      </section>
    );
  }

  function lineExample() {
    return LINE_EXAMPLES[kind] ? lang(LINE_EXAMPLES[kind] as 'HealthLineWeight') : lang('HealthQuickPlaceholder');
  }

  function renderRecords() {
    return isSum && page?.days ? (
      <HealthDayTotals days={page.days} entries={entries} today={view.today} isWide={isWide} onEdit={onEdit} />
    ) : (
      <HealthEntries entries={entries} today={view.today} isWide={isWide} goal={goal} onEdit={onEdit} />
    );
  }

  function renderChartCard() {
    const titleKey = kind === 'pressure' ? 'HealthPressureByDay'
      : kind === 'steps' ? 'HealthStepsByDayGoal' : undefined;
    return (
      <section className={buildClassName(kit.card, styles.card)}>
        {titleKey && isWide && <div className={kit.caps}>{lang(titleKey)}</div>}
        {metric ? <HealthPeriodChart metric={metric} period={period} today={view.today} />
          : <div className={kit.muted}>{lang('HealthNoEntries')}</div>}
      </section>
    );
  }

  if (isWide) {
    return (
      <div className={styles.detailWide} data-health-card={kind}>
        <div className={styles.tiles}>
          {buildTiles().map((tile) => (
            <div key={tile.id} className={buildClassName(kit.card, styles.tile)} data-health-tile={tile.id}>
              <span className={buildClassName(kit.muted, kit.small)}>{tile.title}</span>
              <span
                className={buildClassName(kit.mono, styles.metricValue, tile.tone && styles[tile.tone])}
                data-health-value={tile.id === 'last' ? '' : undefined}
              >
                {tile.value}
              </span>
            </div>
          ))}
        </div>
        {renderChartCard()}
        <div className={styles.detailPair}>
          <section className={buildClassName(kit.card, styles.cardList)}>
            <div className={buildClassName(kit.caps, styles.cardListTitle)}>{lang('HealthEntriesTitle')}</div>
            {renderRecords()}
          </section>
          {renderGoalCard()}
        </div>
      </div>
    );
  }

  function renderSide() {
    if (kind === 'pressure') {
      return pulse?.last ? (
        <span className={styles.detailSideBig}>
          <span className={buildClassName(kit.mono, styles.metricValue)}>{formatValue(pulse.last, lang.code)}</span>
          <span className={buildClassName(kit.muted, kit.small)}>{lang('HealthUnitBpm')}</span>
        </span>
      ) : undefined;
    }
    const lines: { text: string; tone?: string }[] = [];
    if (kind === 'steps' && goal) {
      lines.push({
        text: lang('HealthPercentOfGoal', { value: Math.round(((metric?.today ?? 0) / goal) * 100) }), tone: 'warn',
      });
    } else if (delta !== undefined && period !== 'year') {
      lines.push({
        text: `${withUnit(formatDelta(delta, lang.code))} ${lang(PERIOD_SUFFIX_KEYS[period])}`,
        tone: deltaTone(delta),
      });
    }
    if (kind === 'weight' && metric?.toGoal !== undefined) {
      lines.push({
        text: `${lang('HealthTileToGoal').toLowerCase()} ${
          withUnit(formatValue({ kind, value: Math.abs(metric.toGoal), value2: 0 }, lang.code))}`,
      });
    } else if (stats?.avg !== undefined) {
      lines.push({ text: `${lang('HealthTileAvg').toLowerCase()} ${avgText()}` });
    }
    return (
      <span className={styles.detailSide}>
        {lines.map((line) => (
          <span key={line.text} className={line.tone ? styles[line.tone as 'good'] : kit.muted} data-health-to-goal>
            {line.text}
          </span>
        ))}
      </span>
    );
  }

  return (
    <div className={styles.detail} data-health-card={kind}>
      <div className={styles.detailHead}>
        <span className={styles.detailMain}>
          <span className={buildClassName(kit.muted, kit.small)}>
            {isSum ? dayWord(view.today) : last ? entryTitle(last) : ''}
          </span>
          <span>
            <span className={buildClassName(kit.mono, styles.big)} data-health-value>{currentValue()}</span>
            {kind === 'steps' ? (
              <span className={kit.muted}>
                {` ${lang('HealthStepsUnit', undefined, { pluralValue: metric?.today ?? 0 })}`}
              </span>
            ) : Boolean(unit) && <span className={kit.muted}>{` ${unit}`}</span>}
          </span>
        </span>
        {renderSide()}
      </div>
      {renderChartCard()}
      {renderGoalCard()}
      <section className={buildClassName(kit.card, styles.card)}>
        <div className={kit.caps}>{lang('HealthRecord')}</div>
        <HealthRecordForm kind={kind} metric={metric} />
        {kind === 'weight' ? (
          <>
            <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthOrLine')}</div>
            <HealthQuickInput isCompact placeholder={lineExample()} />
          </>
        ) : (
          <div className={buildClassName(kit.muted, kit.small)}>
            {`${lang('HealthOrLine')}: «${lineExample()}»`}
          </div>
        )}
      </section>
      <div className={kit.caps}>{lang('HealthEntriesTitle')}</div>
      {renderRecords()}
    </div>
  );
};

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export default memo(HealthMetricDetail);
