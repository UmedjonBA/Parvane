import type { NotifyButton, NotifyData, NotifyKind } from './systemNotify';

import { APP_NAME } from '../config';
import { getTranslationFn } from './localization';
import { getIsNotifyAllowedNow } from './notifyPrefs';
import { buildNotifyButtons, buildNotifyTitle, getReminderNotifyModule } from './systemNotify';

// Системные уведомления, которые показывает открытое приложение (spec 041 F2, доска `ZpSystem`): звонок, напоминание
// «Плана» и «Трек скачан на сервер». Показывает их service worker страницы — тогда нажатия (и кнопки) приходят в
// `serviceWorker/pushNotification.ts handleNotificationClick`, как у уведомлений закрытого приложения

const NOTIFY_ACTION_KEYS = {
  reply: 'NotifyActionReply',
  read: 'NotifyActionRead',
  answer: 'NotifyActionAnswer',
  decline: 'NotifyActionDecline',
  done: 'NotifyActionDone',
  snooze: 'NotifyActionSnooze',
  listen: 'PvSysActionListen',
} as const satisfies Record<NotifyButton['action'], string>;

const ICON = 'icon-192x192.png';
const CALL_TAG = 'call';

// `actions` нет в типах DOM этой версии TypeScript, но Chromium их показывает
type NotificationOptionsWithActions = NotificationOptions & { actions?: NotifyButton[] };

export function buildPageNotifyButtons(kind: NotifyKind) {
  const lang = getTranslationFn();
  return buildNotifyButtons(kind, (action) => lang(NOTIFY_ACTION_KEYS[action]));
}

/** Входящий звонок, когда окно скрыто или не в фокусе: «Parvane · Звонок», «Ответить» и «Отклонить». */
export function showCallNotification(callId: string, peerName: string) {
  if ((document.visibilityState === 'visible' && document.hasFocus()) || !getIsNotifyAllowedNow('chats')) return;
  const lang = getTranslationFn();
  void showPageNotification(buildNotifyTitle(APP_NAME, lang('NotifyModuleCall')), {
    body: lang('NotifyCallFrom', { name: peerName }),
    tag: CALL_TAG,
    requireInteraction: true,
    data: { kind: 'call', callId } satisfies NotifyData,
    actions: buildPageNotifyButtons('call'),
  });
}

/** Звонок больше не входящий (принят, отклонён, пропущен): уведомление убирается. */
export function closeCallNotification() {
  void closePageNotifications(CALL_TAG);
}

/** Напоминание «Плана» при скрытом окне: «Parvane · План», текст, «Готово» и «Через 10 мин». */
export function showReminderNotification({ key, title, text }: { key: string; title: string; text: string }) {
  const notifyModule = getReminderNotifyModule(key);
  if (document.visibilityState === 'visible' || !getIsNotifyAllowedNow(notifyModule)) return;
  const lang = getTranslationFn();
  const moduleTitle = lang(notifyModule === 'health' ? 'PlannerHealth' : 'ParvaneSectionPlanner');
  void showPageNotification(buildNotifyTitle(APP_NAME, moduleTitle), {
    body: text,
    tag: `reminder:${key}`,
    data: { kind: 'reminder', reminderKey: key, reminderTitle: title } satisfies NotifyData,
    actions: buildPageNotifyButtons('reminder'),
  });
}

/**
 * «Найти и скачать» закончилось, а окно скрыто: «Parvane · Музыка», «Трек скачан на сервер», название и исполнитель,
 * «Слушать» (доска `ZpSystem`). Закрытому приложению сервер об этом не сообщает — нужен push с нагрузкой.
 */
export function showMusicTrackNotification({ jobId, trackId, title, artist }: {
  jobId: string; trackId?: string; title: string; artist?: string;
}) {
  if (document.visibilityState === 'visible' || !getIsNotifyAllowedNow('music')) return;
  const lang = getTranslationFn();
  const readyText: string = lang('PvSysTrackReady');
  void showPageNotification(buildNotifyTitle(APP_NAME, lang('ParvaneModuleMusic')), {
    body: `${readyText}\n${[title, artist].filter(Boolean).join(' · ')}`,
    tag: `music-fetch:${jobId}`,
    data: { kind: 'music', trackId } satisfies NotifyData,
    actions: trackId ? buildPageNotifyButtons('music') : undefined,
  });
}

async function showPageNotification(title: string, options: NotificationOptionsWithActions) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.showNotification(title, { icon: ICON, badge: ICON, ...options });
  } catch {
    // Уведомление просто не покажется: экран приложения показывает то же самое
  }
}

async function closePageNotifications(tag: string) {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const notifications = await registration?.getNotifications({ tag });
    notifications?.forEach((notification) => notification.close());
  } catch {
    // Закроется само при нажатии
  }
}
