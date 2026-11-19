import { getCloudData, getCloudStatus, getIsCloudLoaded } from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';

// Нет связи с облаком: движок работает без сервера либо показан снимок дерева с устройства (движок ещё не
// поднялся) — «Файлы» и «Заметки» показывают полосу с «Повторить»
export default function useCloudOffline() {
  return useDerivedState(
    () => getCloudStatus() === 'offline' || (Boolean(getCloudData()) && !getIsCloudLoaded()),
    // Сигналы облака — зависимости: по ним производное пересчитывается
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
    [getCloudStatus, getCloudData, getIsCloudLoaded],
  );
}
