import { getIsFirstRunDone } from './parvaneFirstRun';
import { createSignal } from './signals';

// Разрешения браузера по доске `ZpSysGen`: запрос — в момент, когда нужен; перед геопозицией — лист-объяснение; отказ
// браузер запоминает, и функция показывает «Открыть настройки» с инструкцией вместо повторного запроса (открыть
// настройки сайта страница сама не может). После первого входа — экран уведомлений с выбором работы в фоне

export type PermissionKind = 'microphone' | 'camera' | 'notifications' | 'location';
export type PermissionAnswer = 'granted' | 'denied' | 'prompt';

const QUERY_NAMES = {
  microphone: 'microphone', camera: 'camera', notifications: 'notifications', location: 'geolocation',
} as const satisfies Record<PermissionKind, string>;

const NOTIFY_ONBOARD_KEY = 'parvane:notify-onboard';

const [getDeniedPermission, setDeniedPermission] = createSignal<PermissionKind | undefined>(undefined);

export { getDeniedPermission };

/** Показать «Нет доступа» с инструкцией, как разрешить в настройках сайта. */
export function showPermissionDenied(kind: PermissionKind) {
  setDeniedPermission(kind);
}

export function closePermissionDenied() {
  setDeniedPermission(undefined);
}

/** Что браузер ответит на запрос: уже разрешено, запрещено навсегда либо спросит. Не знает — «спросит». */
export async function queryPermission(kind: PermissionKind): Promise<PermissionAnswer> {
  if (kind === 'notifications' && typeof Notification !== 'undefined') {
    return Notification.permission === 'default' ? 'prompt' : Notification.permission;
  }
  try {
    const status = await navigator.permissions.query({ name: QUERY_NAMES[kind] });
    return status.state;
  } catch {
    return 'prompt';
  }
}

/** Ошибка `getUserMedia` / геопозиции — это отказ в доступе, а не поломка устройства. */
export function getIsPermissionError(err: unknown) {
  if (err instanceof DOMException) return err.name === 'NotAllowedError' || err.name === 'SecurityError';
  // `GeolocationPositionError.PERMISSION_DENIED`
  return Boolean(err) && typeof err === 'object' && (err as { code?: unknown }).code === 1;
}

/**
 * Показывать ли экран уведомлений после первого входа: ещё не показан на устройстве, выбор модулей первого запуска
 * сделан, браузер умеет уведомления и ещё не ответил.
 */
export function shouldOfferNotifyOnboard({ isShown, isModulesChosen, permission }: {
  isShown: boolean; isModulesChosen: boolean; permission?: NotificationPermission;
}) {
  return !isShown && isModulesChosen && permission === 'default';
}

export function readNotifyOnboardState() {
  return {
    isShown: readFlag(NOTIFY_ONBOARD_KEY),
    // Экран «Что вам нужно в Parvane?» (первый запуск) идёт первым: уведомления ждут, пока выбор модулей не сделан
    isModulesChosen: getIsFirstRunDone(),
    permission: typeof Notification === 'undefined' ? undefined : Notification.permission,
  };
}

export function markNotifyOnboardShown() {
  try {
    localStorage.setItem(NOTIFY_ONBOARD_KEY, '1');
  } catch {
    // Экран покажется ещё раз при следующем запуске
  }
}

function readFlag(key: string) {
  try {
    return Boolean(localStorage.getItem(key));
  } catch {
    return false;
  }
}
