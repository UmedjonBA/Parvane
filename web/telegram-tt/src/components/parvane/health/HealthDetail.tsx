import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { HealthGoalTarget } from './HealthGoalSheet';
import type { HealthPeriod } from './healthPeriods';
import type { HealthEntriesPage } from './healthStore';
import type { HealthEntry, HealthView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { FOOD_KIND, WORKOUT_KIND } from './healthDayFormat';
import { MOOD_KIND, WATER_KIND } from './healthFormat';
import { loadHealthEntries } from './healthStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import HealthActivityDetail from './HealthActivityDetail';
import HealthEntries from './HealthEntries';
import HealthMetricDetail from './HealthMetricDetail';
import HealthMoodDetail from './HealthMoodDetail';
import HealthNutritionDetail from './HealthNutritionDetail';
import HealthSleepDetail from './HealthSleepDetail';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  view: HealthView;
  // `sleep`, `food` (питание и вода), `workout` (активность) либо вид показателя
  kind: string;
  period: HealthPeriod;
  isWide?: boolean;
  hasFood?: boolean;
  onBed: NoneToVoidFunction;
  onWake: NoneToVoidFunction;
  onEdit: (entry: HealthEntry) => void;
  onNap: NoneToVoidFunction;
  onGoal: (target: HealthGoalTarget) => void;
};

const SLEEP_KINDS = ['sleep', 'sleep_start', 'sleep_end'];
const PAGE_SIZE = 30;

// Parvane (spec 038, 041): подробный экран — сон, самочувствие, питание и вода, активность либо показатель.
// Записи приходят из движка страницами (у шагов и воды — ещё итоги дней)
const HealthDetail = ({
  view, kind, period, isWide, hasFood, onBed, onWake, onEdit, onNap, onGoal,
}: OwnProps) => {
  const lang = useLang();
  const isSleep = kind === 'sleep';
  const metric = view.metrics.find((item) => item.kind === kind);

  // До ответа движка — записи вида из сводки; сводка сменилась — страница перечитывается
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [page, setPage] = useState<HealthEntriesPage & { kind: string }>();
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [kind]);
  useEffect(() => {
    let isStale = false;
    void loadHealthEntries(kind, limit).then((loaded) => {
      if (loaded && !isStale) setPage({ ...loaded, kind });
    });
    return () => {
      isStale = true;
    };
  }, [kind, limit, view]);
  const entries = page?.kind === kind
    ? page.entries
    : view.recent.filter((entry) => (isSleep ? SLEEP_KINDS.includes(entry.kind) : entry.kind === kind));
  const hasMore = page?.kind === kind && (page.hasMore || Boolean(page.hasMoreDays));

  const handleMore = useLastCallback(() => setLimit(limit + PAGE_SIZE));

  function renderBlock() {
    if (kind === FOOD_KIND || (kind === WATER_KIND && hasFood)) {
      return (
        <HealthNutritionDetail
          nutrition={view.nutrition}
          water={view.metrics.find((item) => item.kind === WATER_KIND)}
          isWide={isWide}
          hasFood={hasFood}
        />
      );
    }
    if (kind === WORKOUT_KIND) return <HealthActivityDetail activity={view.activity} isWide={isWide} onGoal={onGoal} />;
    if (isSleep) {
      return (
        <HealthSleepDetail
          view={view}
          period={period}
          isWide={isWide}
          entries={entries}
          onEdit={onEdit}
          onGoal={onGoal}
          onBed={onBed}
          onWake={onWake}
          onNap={onNap}
        />
      );
    }
    if (kind === MOOD_KIND) return <HealthMoodDetail view={view} isWide={isWide} entries={entries} onEdit={onEdit} />;
    return (
      <HealthMetricDetail
        view={view}
        metric={metric}
        kind={kind}
        period={period}
        isWide={isWide}
        entries={entries}
        page={page?.kind === kind ? page : undefined}
        onEdit={onEdit}
        onGoal={onGoal}
      />
    );
  }

  // Еда и тренировки: записи под экраном — правка и удаление окном (сверх досок `XdHealth`)
  const isDayScreen = kind === FOOD_KIND || kind === WORKOUT_KIND;
  const hasEntriesList = !(kind === WATER_KIND && hasFood);

  return (
    <div className={styles.detailBody} data-health-detail={kind}>
      {renderBlock()}
      {isDayScreen && (
        <>
          <div className={kit.caps}>{lang('HealthEntriesTitle')}</div>
          <HealthEntries entries={entries} today={view.today} isWide={isWide} onEdit={onEdit} />
        </>
      )}
      {hasEntriesList && hasMore && (
        <button type="button" className={buildClassName(kit.btn, styles.more)} data-health-more onClick={handleMore}>
          {lang('HealthEntriesMore')}
        </button>
      )}
    </div>
  );
};

export default memo(HealthDetail);
