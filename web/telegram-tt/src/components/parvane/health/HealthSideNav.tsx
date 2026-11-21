import { memo } from '../../../lib/teact/teact';

import type { HealthBlockId } from '../../../util/parvaneModules';
import type { HealthView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { FOOD_KIND, WORKOUT_KIND } from './healthDayFormat';
import {
  formatDurationShort, formatNumber, formatValue, KIND_COLORS, MOOD_KIND, MOOD_MAX, orderMetrics, WATER_KIND,
} from './healthFormat';
import useHealthLabels from './useHealthLabels';

import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import HealthBlocksNote from './HealthBlocksNote';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  view: HealthView;
  blocks: HealthBlockId[];
  selected: string;
  onSelect: (kind: string) => void;
  onBack: NoneToVoidFunction;
  onOpenBlocks: NoneToVoidFunction;
};

type Item = { kind: string; title: string; hint: string; value: string };

const ML_IN_LITER = 1000;

// Parvane (spec 041; доски `DeskHealthDetail`, `XdHealth`, `RdHealth`): левая колонка подробного экрана компьютера —
// «‹ Сводка» и показатели с цветной точкой, когда записано и последним значением; переключение без возврата к
// сводке. Внизу — какие блоки выключены
const HealthSideNav = ({
  view, blocks, selected, onSelect, onBack, onOpenBlocks,
}: OwnProps) => {
  const {
    lang, kindTitle, dayTitle,
  } = useHealthLabels(view.today);
  const number = (value: number) => formatNumber(value, lang.code);

  const handleSelect = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onSelect(e.currentTarget.dataset.kind!);
  });

  const items: Item[] = [];
  const { sleep } = view;
  if (blocks.includes('sleep')) {
    const minutes = sleep.lastTotalMinutes ?? sleep.last?.minutes;
    items.push({
      kind: 'sleep',
      title: lang('HealthKindSleep'),
      hint: lang('HealthSleepLastNight').toLowerCase(),
      value: minutes !== undefined ? formatDurationShort(minutes) : '—',
    });
  }
  if (blocks.includes('body')) {
    orderMetrics(view.metrics)
      .filter((metric) => metric.kind !== WATER_KIND && metric.kind !== MOOD_KIND)
      .forEach((metric) => {
        const value = metric.isSum ? number(metric.today ?? 0)
          : metric.last ? formatValue(metric.last, lang.code) : '—';
        items.push({
          kind: metric.kind,
          title: kindTitle(metric.kind),
          hint: metric.isSum ? lang('HealthToday') : metric.last ? dayTitle(metric.last.day) : '',
          value,
        });
      });
    const mood = view.metrics.find((metric) => metric.kind === MOOD_KIND);
    items.push({
      kind: MOOD_KIND,
      title: lang('HealthKindMood'),
      hint: mood?.last ? dayTitle(mood.last.day) : '',
      value: mood?.last ? `${Math.round(mood.last.value)}/${MOOD_MAX}` : '—',
    });
  }
  if (blocks.includes('food')) {
    items.push({
      kind: FOOD_KIND, title: lang('ParvaneHealthBlockFood'), hint: '', value: number(view.nutrition.total.kcal),
    });
  }
  if (blocks.includes('water')) {
    const water = view.metrics.find((metric) => metric.kind === WATER_KIND);
    const liters = new Intl.NumberFormat(lang.code, { maximumFractionDigits: 2 })
      .format((water?.today ?? 0) / ML_IN_LITER);
    items.push({
      kind: WATER_KIND, title: lang('HealthKindWater'), hint: '', value: `${liters} ${lang('HealthUnitLiter')}`,
    });
  }
  if (blocks.includes('workouts')) {
    items.push({
      kind: WORKOUT_KIND,
      title: lang('HealthActivityTitle'),
      hint: '',
      value: `${number(view.activity.activeMinutes)} ${lang('HealthUnitMin')}`,
    });
  }
  const isWaterInFood = selected === WATER_KIND && blocks.includes('food');

  return (
    <nav className={styles.side} aria-label={lang('PlannerHealth')} data-health-side>
      <button type="button" className={buildClassName(styles.sideBack)} data-health-side-back onClick={onBack}>
        <ParvaneIcon name="left" isSmall />
        {lang('HealthSummary')}
      </button>
      {items.map((item) => {
        const isOn = item.kind === selected || (isWaterInFood && item.kind === FOOD_KIND);
        return (
          <button
            key={item.kind}
            type="button"
            className={buildClassName(styles.sideItem, isOn && styles.sideItemOn)}
            aria-current={isOn ? 'page' : undefined}
            data-kind={item.kind}
            data-health-side-item={item.kind}
            onClick={handleSelect}
          >
            <span
              className={styles.sideDot}
              style={`background: var(--pv-${KIND_COLORS[item.kind] || 'accent'})`}
            />
            <span className={buildClassName(kit.grow, styles.sideText)}>
              <span className={styles.sideTitle}>{item.title}</span>
              {Boolean(item.hint) && <span className={buildClassName(kit.muted, kit.small)}>{item.hint}</span>}
            </span>
            <span className={buildClassName(kit.mono, kit.small)}>{item.value}</span>
          </button>
        );
      })}
      <span className={kit.grow} />
      <HealthBlocksNote blocks={blocks} isShort onOpenBlocks={onOpenBlocks} />
    </nav>
  );
};

export default memo(HealthSideNav);
