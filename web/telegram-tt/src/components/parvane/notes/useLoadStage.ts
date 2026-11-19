import { useEffect, useState } from '../../../lib/teact/teact';

import type { LoadStage } from './loadStage';

import { watchLoadStage } from './loadStage';

import useLastCallback from '../../../hooks/useLastCallback';

// Стадия загрузки с момента показа; `retry` запускает `onRetry` и начинает отсчёт заново
export default function useLoadStage(onRetry?: NoneToVoidFunction) {
  const [stage, setStage] = useState<LoadStage>('loading');
  const [attempt, setAttempt] = useState(0);
  const canGiveUp = Boolean(onRetry);

  useEffect(() => watchLoadStage(setStage, canGiveUp), [attempt, canGiveUp]);

  const retry = useLastCallback(() => {
    setStage('loading');
    setAttempt((previous) => previous + 1);
    onRetry?.();
  });

  return { stage, retry };
}
