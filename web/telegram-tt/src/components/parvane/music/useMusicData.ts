import { useEffect, useRef, useState } from '../../../lib/teact/teact';

import useLastCallback from '../../../hooks/useLastCallback';

// Parvane (spec 041): данные экрана «Музыки» по ключу (альбом, исполнитель, главная). Ответ для прежнего ключа,
// пришедший после смены экрана, не показывается

export default function useMusicData<T>(key: string | undefined, load: () => Promise<T>) {
  const [state, setState] = useState<{ key: string; data?: T; isFailed: boolean }>();
  const requestRef = useRef(0);

  const fetchData = useLastCallback(async (forKey: string) => {
    const id = ++requestRef.current;
    const data = await load().catch(() => undefined);
    if (id !== requestRef.current) return;
    setState({ key: forKey, data, isFailed: data === undefined });
  });

  useEffect(() => {
    if (key !== undefined) void fetchData(key);
  }, [key, fetchData]);

  const reload = useLastCallback(() => {
    if (key !== undefined) void fetchData(key);
  });

  // Правка на месте (отметка «любимое» в открытом списке)
  const patch = useLastCallback((update: (data: T) => T) => {
    setState((previous) => (previous?.data !== undefined ? { ...previous, data: update(previous.data) } : previous));
  });

  const current = state?.key === key ? state : undefined;
  return {
    data: current?.data, isFailed: Boolean(current?.isFailed), isLoaded: Boolean(current), reload, patch,
  };
}
