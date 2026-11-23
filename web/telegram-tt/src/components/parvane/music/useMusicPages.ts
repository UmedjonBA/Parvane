import { useEffect, useRef, useState } from '../../../lib/teact/teact';

import { MUSIC_LIBRARY_CHANGED_EVENT } from './musicAdded';
import { mergePage } from './musicLibrary';

import useLastCallback from '../../../hooks/useLastCallback';

// Parvane (spec 041): длинный список библиотеки по страницам (исполнители, альбомы, любимое — по 50 с сервера).
// Следующая страница читается, когда низ списка показался (`MusicLoadMore`); повторы склеивает движок

export type MusicPage<T> = { items: T[]; hasMore: boolean };

type State<T> = {
  key: string;
  items: T[];
  hasMore: boolean;
  isLoading: boolean;
  isFailed: boolean;
  isLoaded: boolean;
};

export default function useMusicPages<T extends { id: string }>(
  key: string | undefined, load: (offset: number) => Promise<MusicPage<T>>,
) {
  const [state, setState] = useState<State<T>>();
  const requestRef = useRef(0);

  const fetchPage = useLastCallback(async (forKey: string, offset: number) => {
    const id = ++requestRef.current;
    setState((previous) => (previous && previous.key === forKey
      ? { ...previous, isLoading: true, isFailed: false }
      : {
        key: forKey, items: [], hasMore: false, isLoading: true, isFailed: false, isLoaded: false,
      }));
    const page = await load(offset).catch(() => undefined);
    if (id !== requestRef.current) return;
    setState((previous) => {
      const items = offset && previous ? mergePage(previous.items, page?.items || []) : page?.items || [];
      return {
        key: forKey, items, hasMore: Boolean(page?.hasMore), isLoading: false, isFailed: !page, isLoaded: true,
      };
    });
  });

  useEffect(() => {
    if (key !== undefined) void fetchPage(key, 0);
  }, [key, fetchPage]);

  const loadMore = useLastCallback(() => {
    if (!state || state.key !== key || !state.hasMore || state.isLoading) return;
    void fetchPage(state.key, state.items.length);
  });

  const reload = useLastCallback(() => {
    if (key !== undefined) void fetchPage(key, 0);
  });

  // Библиотека изменилась — открытый список перечитывается с начала (альбомы, исполнители, любимое, жанр)
  useEffect(() => {
    window.addEventListener(MUSIC_LIBRARY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MUSIC_LIBRARY_CHANGED_EVENT, reload);
  }, [reload]);

  const current = state?.key === key ? state : undefined;
  return {
    items: current?.items,
    hasMore: Boolean(current?.hasMore),
    isFailed: Boolean(current?.isFailed),
    isLoaded: Boolean(current?.isLoaded),
    loadMore,
    reload,
  };
}
