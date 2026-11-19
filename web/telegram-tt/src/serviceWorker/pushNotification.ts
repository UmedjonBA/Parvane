import type { WorkerReminder } from '../util/reminderStore';
import type { NotifyButton, NotifyCommand, NotifyData } from '../util/systemNotify';

import { APP_NAME, DEBUG, DEBUG_MORE } from '../config';
import { loadWorkerNotifyPrefs, takeDueWorkerReminders } from '../util/reminderStore';
import {
  buildNotifyButtons, buildNotifyTitle, getIsNotifyAllowed, getWorkerNotifyTexts, readNotifyPrefs, resolveNotifyClick,
} from '../util/systemNotify';

declare const self: ServiceWorkerGlobalScope;

enum Boolean {
  True = '1',
  False = '0',
}

type PushData = {
  custom: {
    msg_id?: string;
    silent?: string;
    channel_id?: string;
    chat_id?: string;
    from_id?: string;
  };
  mute: Boolean;
  badge: Boolean;
  loc_key: string;
  loc_args: string[];
  random_id: number;
  title: string;
  description: string;
};

type NotificationData = {
  messageId?: number;
  chatId?: string;
  title: string;
  body: string;
  isSilent?: boolean;
  icon?: string;
  reaction?: string;
  shouldReplaceHistory?: boolean;
  // Кнопки уведомления (spec 041 F2): подписи страница кладёт на своём языке
  actions?: NotifyButton[];
};

// `actions` нет в типах DOM этой версии TypeScript, но Chromium их показывает
type NotificationOptionsWithActions = NotificationOptions & { actions?: NotifyButton[] };

type CloseNotificationData = {
  lastReadInboxMessageId?: number;
  chatId: string;
};

let lastSyncAt = new Date().valueOf();
// Сколько ждать ответа окна: замороженная страница не ответит вовсе
const CLIENT_PING_TIMEOUT_MS = 1000;
const shownNotifications = new Set();
// Команда нажатия ждёт, пока открытое по нажатию окно загрузится (`clientReady`)
const pendingCommands: Record<string, NotifyCommand> = {};
const NEW_CLIENT_KEY = 'new';

function getPushData(e: PushEvent | Notification): PushData | undefined {
  try {
    const data = e.data.json() as PushData;
    // Пробуждение протокола v2 (`push.wake.*`) — пустой объект: сервер не знает ни чата, ни текста (E2E).
    // Заголовок — «Parvane · Чаты», текст — «Новое сообщение» (доска `ZpSystem`)
    if (!data.custom) {
      const texts = getWorkerNotifyTexts(self.navigator.language);
      return {
        ...data,
        title: data.title || buildNotifyTitle(APP_NAME, texts.chats),
        description: data.description || texts.newMessage,
        custom: {},
      };
    }
    return data;
  } catch (error) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[SW] Unable to parse push notification data', e.data);
    }
    return undefined;
  }
}

function getChatId(data: PushData) {
  if (data.custom.from_id) {
    return data.custom.from_id;
  }

  // Chats and channels have “negative” IDs
  if (data.custom.chat_id || data.custom.channel_id) {
    return `-${data.custom.chat_id || data.custom.channel_id}`;
  }

  return undefined;
}

function getMessageId(data: PushData) {
  if (!data.custom.msg_id) return undefined;
  return parseInt(data.custom.msg_id, 10);
}

function getNotificationData(data: PushData): NotificationData {
  let title = data.title || APP_NAME;
  const isSilent = data.custom?.silent === Boolean.True;
  if (isSilent) {
    title += ' 🔕';
  }
  return {
    chatId: getChatId(data),
    messageId: getMessageId(data),
    body: data.description,
    isSilent,
    title,
  };
}

async function getClients() {
  const appUrl = new URL(self.registration.scope).origin;
  const clients = await self.clients.matchAll({ type: 'window' }) as WindowClient[];
  return clients.filter((client) => {
    return new URL(client.url).origin === appUrl;
  });
}

async function hasLiveClient() {
  const clients = await getClients();
  if (!clients.length) return false;
  const answers = clients.map((client) => new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve(true);
    client.postMessage({ type: 'parvanePing' }, [channel.port2]);
  }));
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), CLIENT_PING_TIMEOUT_MS);
  });
  return Promise.race([...answers, timeout]);
}

async function playNotificationSound(id: string) {
  const clients = await getClients();
  const client = clients[0];
  if (!client) return;
  client.postMessage({
    type: 'playNotificationSound',
    payload: { id },
  });
}

function showNotification({
  chatId,
  messageId,
  body,
  title,
  icon,
  reaction,
  isSilent,
  actions,
}: NotificationData) {
  const isFirstBatch = new Date().valueOf() - lastSyncAt < 1000;
  const tag = String(isFirstBatch ? 0 : chatId || 0);
  const data: NotifyData = { kind: chatId ? 'message' : 'wake', chatId, messageId };
  const options: NotificationOptionsWithActions = {
    body,
    data,
    actions: chatId ? actions : undefined,
    icon: icon || 'icon-192x192.png',
    badge: 'icon-192x192.png',
    tag,
    // @ts-ignore
    vibrate: [200, 100, 200],
  };

  return Promise.all([
    // TODO Update condition when reaction badges are implemented
    (!reaction && !isSilent) ? playNotificationSound(String(messageId) || chatId || '') : undefined,
    self.registration.showNotification(title, options),
  ]);
}

async function closeNotifications({
  chatId,
  lastReadInboxMessageId,
}: CloseNotificationData) {
  const notifications = await self.registration.getNotifications();
  const lastMessageId = lastReadInboxMessageId || Number.MAX_VALUE;
  notifications.forEach((notification) => {
    if (
      notification.tag === '0'
      || (notification.data.chatId === chatId && notification.data.messageId <= lastMessageId)
    ) {
      notification.close();
    }
  });
}

export function handlePush(e: PushEvent) {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[SW] Push received event', e);
    if (e.data) {
      // eslint-disable-next-line no-console
      console.log('[SW] Push received with data', e.data.json());
    }
  }

  const data = getPushData(e);

  // Do not show muted notifications
  if (!data || data.mute === Boolean.True) return;

  const notification = getNotificationData(data);

  // Don't show already triggered notification
  if (shownNotifications.has(notification.messageId)) {
    shownNotifications.delete(notification.messageId);
    return;
  }

  // Parvane: пуш будит только закрытое приложение — живая вкладка показывает уведомления сама. Свёрнутое PWA на
  // Android окно сохраняет, но страница заморожена и ничего не покажет, поэтому окно спрашивается, живо ли оно
  e.waitUntil((async () => {
    if (await hasLiveClient()) return;
    // Пробуждение без данных бывает и будильником напоминания «Плана» (этап 4 плана 15 окт 2026):
    // наступившее напоминание показывается вместо общего «новое сообщение»
    const reminders = await takeDueWorkerReminders(Date.now()).catch(() => []);
    // Модули, выключенные в «Профиль → Уведомления», и «Не беспокоить» (spec 041 E3) — настройки страницы
    const prefs = readNotifyPrefs(await loadWorkerNotifyPrefs().catch(() => undefined));
    const now = new Date();
    if (reminders.length) {
      if (getIsNotifyAllowed(prefs, 'plan', now)) await Promise.all(reminders.map(showReminder));
      return;
    }
    if (!getIsNotifyAllowed(prefs, 'chats', now)) return;
    await showNotification(notification);
  })());
}

// Напоминание «Плана» закрытого приложения: «Parvane · План», название записи, «Готово» и «Через 10 мин».
// При PIN хранилища названия нет — общий текст
function showReminder(reminder: WorkerReminder) {
  const texts = getWorkerNotifyTexts(self.navigator.language);
  const data: NotifyData = { kind: 'reminder', reminderKey: reminder.key, reminderTitle: reminder.title };
  const options: NotificationOptionsWithActions = {
    body: reminder.title || texts.openPlanner,
    icon: 'icon-192x192.png',
    badge: 'icon-192x192.png',
    tag: `reminder:${reminder.key}`,
    data,
    actions: buildNotifyButtons('reminder', (action) => (action === 'done' ? texts.done : texts.snooze)),
  };
  return self.registration.showNotification(buildNotifyTitle(APP_NAME, texts.planner), options);
}

async function focusClient(client: WindowClient) {
  if (client.focused) return;
  // Catch "focus not allowed" DOM Exceptions
  try {
    await client.focus();
  } catch (error) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[SW] ', error);
    }
  }
}

/**
 * Нажатие на уведомление или его кнопку (spec 041 F2): команда странице (`util/notifyCommands.ts`) — открыть
 * чат, ответить на звонок, отметить задачу и т. п. Фоновое действие при живой странице выполняется без её
 * показа; иначе приложение показывается (открывается), и команда ждёт его готовности.
 */
export function handleNotificationClick(e: NotificationEvent) {
  e.notification.close(); // Android needs explicit close.
  const { command, shouldFocus } = resolveNotifyClick(e.notification.data, e.action);
  // Номер команды: страница выполняет каждую один раз, сколько бы раз она ни пришла
  command.id = `${Date.now()}-${Math.random()}`;
  keepAlive(e, runNotifyCommand(command, shouldFocus));
}

async function runNotifyCommand(command: NotifyCommand, shouldFocus: boolean) {
  const clients = await getClients();
  const client = clients.find((c) => c.focused) || clients.find((c) => c.visibilityState === 'visible') || clients[0];
  if (!client) {
    await openClient(command);
    return;
  }
  // Если страница ещё грузится, команду заберёт её `clientReady`
  pendingCommands[client.id] = command;
  client.postMessage({ type: 'parvaneNotify', payload: command });
  // Фоновое действие при живой странице — без показа; иначе окно показывается (свёрнутое PWA на Android
  // заморожено и оживает, только когда его покажут)
  if (shouldFocus || !(await hasLiveClient())) await focusClient(client);
}

async function openClient(command: NotifyCommand) {
  if (!self.clients.openWindow) return;
  pendingCommands[NEW_CLIENT_KEY] = command;
  try {
    const newClient = await self.clients.openWindow(self.registration.scope);
    if (newClient) pendingCommands[newClient.id] = command;
  } catch (error) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[SW] ', error);
    }
  }
}

// Событие, созданное не браузером (сценарий вызывает `notificationclick` сам), `waitUntil` не принимает
function keepAlive(e: ExtendableEvent, promise: Promise<unknown>) {
  try {
    e.waitUntil(promise);
  } catch {
    // Обработка идёт и так
  }
}

export function handleClientMessage(e: ExtendableMessageEvent) {
  if (DEBUG_MORE) {
    // eslint-disable-next-line no-console
    console.log('[SW] New message from client', e);
  }
  if (!e.data) return;
  const source = e.source as WindowClient;
  if (e.data.type === 'clientReady') {
    // Окно, открытое нажатием на уведомление, загрузилось: команда нажатия — ему
    const command = pendingCommands[source.id] || pendingCommands[NEW_CLIENT_KEY];
    delete pendingCommands[NEW_CLIENT_KEY];
    if (command) source.postMessage({ type: 'parvaneNotify', payload: command });
  }
  // Страница выполнила команду: повторять её при следующем `clientReady` (перезагрузка) не нужно
  if (e.data.type === 'parvaneNotifyDone') {
    delete pendingCommands[source.id];
  }
  if (e.data.type === 'showMessageNotification') {
    // store messageId for already shown notification
    const notification: NotificationData = e.data.payload;
    e.waitUntil((async () => {
      // Close existing notification if it is already shown
      if (notification.chatId) {
        const notifications = await self.registration.getNotifications({ tag: notification.chatId });
        notifications.forEach((n) => n.close());
      }
      // Mark this notification as shown if it was handled locally
      shownNotifications.add(notification.messageId);
      return showNotification(notification);
    })());
  }

  if (e.data.type === 'closeMessageNotifications') {
    e.waitUntil(closeNotifications(e.data.payload));
  }
}

self.addEventListener('sync', () => {
  lastSyncAt = Date.now();
});
