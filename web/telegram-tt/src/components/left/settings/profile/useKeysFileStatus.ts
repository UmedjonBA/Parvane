import { useEffect, useState } from '../../../../lib/teact/teact';
import { getGlobal } from '../../../../global';

import { fetchKeysMark } from './keysFile';
import { getIsKeysBackupStale, getKeysBackupSavedAt } from './profileStatus';

import useLastCallback from '../../../../hooks/useLastCallback';

/** Состояние файла копии ключей для карточки «Копия сохранена …» — перечитывается при открытии экрана. */
export default function useKeysFileStatus(isActive?: boolean) {
  const user = getGlobal().currentUserId;
  const [savedAt, setSavedAt] = useState(() => getKeysBackupSavedAt(user));
  const [isStale, setIsStale] = useState<boolean>();

  const refresh = useLastCallback(async () => {
    setSavedAt(getKeysBackupSavedAt(user));
    setIsStale(getIsKeysBackupStale(user, await fetchKeysMark().catch(() => undefined)));
  });

  useEffect(() => {
    if (isActive) void refresh();
  }, [isActive, refresh]);

  return { user, savedAt, isStale, refresh };
}
