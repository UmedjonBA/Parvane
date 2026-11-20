import { useLayoutEffect } from '../../lib/teact/teact';

import { getIsAutoLockDue, getIsLockHotkey, lockAppNow } from '../../util/autoLock';
import { callApi } from '../../api/gramjs';

// Parvane (spec 041, доска `ZdProfileX`): автоблокировка и Ctrl+L. Работают, только когда задан PIN хранилища —
// его состояние перечитывается при запуске и при возвращении к вкладке (PIN могли включить в «Профиле»)
const CHECK_INTERVAL_MS = 5_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;

export default function useAutoLock() {
  // Слушатель клавиш ставится до первого кадра: Ctrl+L сразу после запуска не должен уйти мимо
  useLayoutEffect(() => {
    let lastActivityAt = Date.now();
    let isPinEnabled = false;
    // Ответ о PIN ещё не пришёл (первые мгновения после запуска)
    let pinRequest: Promise<void> | undefined;

    const refreshPin = () => {
      const request = (callParvane('parvaneGetStoragePin', {}) as Promise<{ enabled: boolean } | undefined>)
        .then((state) => {
          isPinEnabled = Boolean(state?.enabled);
        })
        .catch(() => undefined)
        .finally(() => {
          if (pinRequest === request) pinRequest = undefined;
        });
      pinRequest = request;
    };

    const lockIfDue = () => {
      if (isPinEnabled && getIsAutoLockDue(lastActivityAt, Date.now())) lockAppNow();
    };

    const handleActivity = () => {
      lastActivityAt = Date.now();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!getIsLockHotkey(e)) return;
      // Состояние PIN ещё запрошено: клавиша не теряется — блокировка сработает, как только придёт ответ
      if (pinRequest && !isPinEnabled) {
        e.preventDefault();
        void pinRequest.then(() => {
          if (isPinEnabled) lockAppNow();
        });
        return;
      }
      if (!isPinEnabled) return;
      e.preventDefault();
      lockAppNow();
    };

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      lockIfDue();
      refreshPin();
    };

    refreshPin();
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, handleActivity, { passive: true, capture: true }));
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    document.addEventListener('visibilitychange', handleVisibility);
    const timer = window.setInterval(lockIfDue, CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, handleActivity, { capture: true }));
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(timer);
    };
  }, []);
}
