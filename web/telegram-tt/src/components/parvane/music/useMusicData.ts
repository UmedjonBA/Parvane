import { useEffect, useRef, useState } from '../../../lib/teact/teact';

import useLastCallback from '../../../hooks/useLastCallback';

// Последние данные экранов по ключу: при возврате на экран (главная → альбом → назад) они видны сразу, свежие
// подгружаются следом, а не через заглушку
const MAX_CACHED = 60;
const cached = new Map<string, unknown>();

function remember(key: string, data: unknown) {
  cached.delete(key);
  cached.set(key, data);
  if (cached.size > MAX_CACHED) cached.delete(cached.keys().next().value!);
}

// Parvane (spec 041): данные экрана «Музыки» по ключу (альбом, исполнитель, главная). Ответ для прежнего ключа,
// пришедший после смены экрана, не показывается. Уже виденный экран показывается из памяти и тихо обновляется;
// сбой обновления оставляет прежние данные
export default function useMusicData<T>(key: string | undefined, load: () => Promise<T>) {
  const [state, setState] = useState<{ key: string; data?: T; isFailed: boolean } | undefined>(
    () => (key !== undefined && cached.has(key) ? { key, data: cached.get(key) as T, isFailed: false } : undefined),
  );
  const requestRef = useRef(0);

  const fetchData = useLastCallback(async (forKey: string) => {
    const id = ++requestRef.current;
    const data = await load().catch(() => undefined);
    if (id !== requestRef.current) return;
    if (data === undefined && cached.has(forKey)) return;
    if (data !== undefined) remember(forKey, data);
    setState({ key: forKey, data, isFailed: data === undefined });
  });

  useEffect(() => {
    if (key === undefined) return;
    if (cached.has(key)) setState({ key, data: cached.get(key) as T, isFailed: false });
    void fetchData(key);
  }, [key, fetchData]);

  const reload = useLastCallback(() => {
    if (key !== undefined) void fetchData(key);
  });

  // Правка на месте (отметка «любимое» в открытом списке)
  const patch = useLastCallback((update: (data: T) => T) => {
    setState((previous) => {
      if (previous?.data === undefined) return previous;
      const data = update(previous.data);
      remember(previous.key, data);
      return { ...previous, data };
    });
  });

  const current = state?.key === key ? state : undefined;
  return {
    data: current?.data, isFailed: Boolean(current?.isFailed), isLoaded: Boolean(current), reload, patch,
  };
}
