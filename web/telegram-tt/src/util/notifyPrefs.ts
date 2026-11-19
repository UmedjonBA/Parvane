import type { NotifyModule, NotifyPrefs } from './systemNotify';

import { ACCOUNT_WIPED_EVENT } from './parvaneEvents';
import { saveWorkerNotifyPrefs } from './reminderStore';
import { createSignal } from './signals';
import { DEFAULT_NOTIFY_PREFS, getIsNotifyAllowed, readNotifyPrefs } from './systemNotify';

// Уведомления по модулям и «Не беспокоить» (spec 041 E3, доски `PhProfileA`, `DkSettingsB`). Настройка этого
// устройства, как и прежние выключатели уведомлений в браузере: страница читает её из `localStorage`, service worker —
// из копии в базе напоминаний (`reminderStore.ts`), которую страница пишет при каждой правке и при запуске. Выход из
// аккаунта стирает обе (`deviceWipe.ts`: все `parvane:*` и база напоминаний целиком)
const STORAGE_KEY = 'parvane:notify-prefs';

const [getNotifyPrefs, setNotifyPrefs] = createSignal<NotifyPrefs>(loadNotifyPrefs());

export { getNotifyPrefs };

export function updateNotifyPrefs(patch: Partial<NotifyPrefs>) {
  const next = { ...getNotifyPrefs(), ...patch };
  setNotifyPrefs(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Настройка действует до перезагрузки
  }
  void saveWorkerNotifyPrefs(next).catch(() => undefined);
}

export function setNotifyModuleOn(module: NotifyModule, isOn: boolean) {
  const off = getNotifyPrefs().off.filter((id) => id !== module);
  updateNotifyPrefs({ off: isOn ? off : [...off, module] });
}

/** Показывать ли сейчас системное уведомление модуля (звук сообщения — тоже по этому правилу). */
export function getIsNotifyAllowedNow(module: NotifyModule) {
  return getIsNotifyAllowed(getNotifyPrefs(), module, new Date());
}

function loadNotifyPrefs() {
  const saved = readSavedPrefs();
  return saved === undefined ? DEFAULT_NOTIFY_PREFS : readNotifyPrefs(saved);
}

function readSavedPrefs(): unknown {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : undefined;
  } catch {
    return undefined;
  }
}

if (typeof window !== 'undefined') {
  // Копия для service worker могла отстать (приложение обновлено) — пишется заново, только если настройка менялась:
  // без неё service worker берёт умолчания, а база напоминаний после выхода из аккаунта остаётся пустой
  if (readSavedPrefs() !== undefined) void saveWorkerNotifyPrefs(getNotifyPrefs()).catch(() => undefined);
  window.addEventListener(ACCOUNT_WIPED_EVENT, () => setNotifyPrefs(DEFAULT_NOTIFY_PREFS));
}
