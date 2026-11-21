import { memo } from '../../../lib/teact/teact';

import type { PlannerState } from './plannerModel';

import buildClassName from '../../../util/buildClassName';
import { formatHours, formatSpan } from './plannerFormat';
import { getDailyRecord, getDayBudget, isShortSleep } from './plannerHealth';

import useLang from '../../../hooks/useLang';

import pv from './PlannerPv.module.scss';

type OwnProps = {
  state: PlannerState;
  day: string;
};

// Строка внизу колонки дня компьютера (доска `RdPlan`): «Сон прошлой ночью: 6:55 — бюджет дня не снижен» либо
// «… — бюджет дня снижен до 6 ч». Сна нет — строки нет
const PlannerSleepLine = ({ state, day }: OwnProps) => {
  const lang = useLang();

  const sleep = getDailyRecord(state, 'sleep', day);
  if (!sleep) return undefined;
  const isShort = isShortSleep(state, day);
  const sleepText = formatSpan(sleep.value);

  return (
    <p className={buildClassName(pv.sleepLine, isShort && pv.sleepLineShort)} data-sleep-line={day}>
      {isShort
        ? lang('PlannerSleepLineReduced', { sleep: sleepText, budget: formatHours(lang, getDayBudget(state, day)) })
        : lang('PlannerSleepLineKept', { sleep: sleepText })}
    </p>
  );
};

export default memo(PlannerSleepLine);
