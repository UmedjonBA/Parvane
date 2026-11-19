// Системные уведомления по доске `ZpSystem` (spec 041 F2): заголовок «Parvane · <модуль>», действия по виду
// уведомления и то, что делает нажатие. Здесь только правила — без DOM и глобального состояния: модуль читают
// и страница (`util/notifications.tsx`, звонки, напоминания), и service worker (`serviceWorker/pushNotification.ts`).
// Действия (`actions`) показывают Chromium на Android и компьютере; Safari и iOS их не показывают — там
// работает только нажатие на само уведомление

export type NotifyKind = 'message' | 'call' | 'reminder' | 'wake';
// Пустая строка — нажатие на само уведомление, а не на кнопку
export type NotifyAction = '' | 'reply' | 'read' | 'answer' | 'decline' | 'done' | 'snooze';

// То, что лежит в `notification.data`: по нему service worker и страница решают, что открыть
export type NotifyData = {
  kind: NotifyKind;
  chatId?: string;
  messageId?: number;
  callId?: string;
  reminderKey?: string;
  reminderTitle?: string;
};

// Команда странице: что сделать по нажатию (`util/notifyCommands.ts`)
export type NotifyCommand = NotifyData & { action: NotifyAction; id?: string };

export type NotifyButton = { action: Exclude<NotifyAction, ''>; title: string };

export const NOTIFY_SNOOZE_MS = 10 * 60 * 1000;

const ACTIONS: Record<NotifyKind, Exclude<NotifyAction, ''>[]> = {
  message: ['reply', 'read'],
  call: ['answer', 'decline'],
  reminder: ['done', 'snooze'],
  // Пробуждение сервера пустое (E2E): ни чата, ни текста — делать с ним нечего, только открыть приложение
  wake: [],
};

// Действия, которым не нужно показывать приложение: страница выполнит их в фоне
const BACKGROUND_ACTIONS = new Set<NotifyAction>(['read', 'decline', 'done', 'snooze']);
const KNOWN_KINDS = new Set<string>(Object.keys(ACTIONS));
const KNOWN_ACTIONS = new Set<string>(['', 'reply', 'read', 'answer', 'decline', 'done', 'snooze']);

/** Заголовок уведомления: «Parvane · Чаты». */
export function buildNotifyTitle(appName: string, moduleName: string) {
  return `${appName} · ${moduleName}`;
}

/**
 * Текст уведомления о сообщении: чат первой строкой, затем текст. Текст — только если он включён в настройках
 * уведомлений, иначе «Новое сообщение». Экран заблокирован PIN — ни чата, ни текста.
 */
export function buildMessageNotifyBody({
  chatTitle, senderName, summary, isTextShown, isLocked, hiddenText,
}: {
  chatTitle: string;
  // Автор в группе; в личном чате совпадает с названием чата и не повторяется
  senderName?: string;
  summary: string;
  isTextShown: boolean;
  isLocked: boolean;
  hiddenText: string;
}) {
  if (isLocked) return hiddenText;
  if (!isTextShown) return `${chatTitle}\n${hiddenText}`;
  const author = senderName && senderName !== chatTitle ? `${senderName}: ` : '';
  return `${chatTitle}\n${author}${summary}`;
}

/** Кнопки уведомления этого вида; `getLabel` — подпись кнопки на языке интерфейса. */
export function buildNotifyButtons(
  kind: NotifyKind, getLabel: (action: NotifyButton['action']) => string,
): NotifyButton[] {
  return ACTIONS[kind].map((action) => ({ action, title: getLabel(action) }));
}

/**
 * Что делает нажатие: команда странице и нужно ли показать приложение. Фоновые действия («Прочитано»,
 * «Отклонить», «Готово», «Через 10 мин») выполняет живая страница без показа; если живой страницы нет,
 * service worker всё равно открывает приложение — расшифровка и движок есть только у страницы.
 */
export function resolveNotifyClick(raw: unknown, rawAction: string): { command: NotifyCommand; shouldFocus: boolean } {
  const data = readNotifyData(raw);
  const action = (KNOWN_ACTIONS.has(rawAction) && (rawAction === '' || ACTIONS[data.kind].includes(
    rawAction as NotifyButton['action'],
  )) ? rawAction : '') as NotifyAction;
  return { command: { ...data, action }, shouldFocus: !BACKGROUND_ACTIONS.has(action) };
}

/** `notification.data` прежних уведомлений и чужих версий: всё, что не разобрано, — пробуждение. */
export function readNotifyData(raw: unknown): NotifyData {
  if (!raw || typeof raw !== 'object') return { kind: 'wake' };
  const data = raw as Record<string, unknown>;
  const readString = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const chatId = readString(data.chatId);
  const kind = typeof data.kind === 'string' && KNOWN_KINDS.has(data.kind)
    ? data.kind as NotifyKind
    : (chatId ? 'message' : 'wake');
  return {
    kind,
    chatId,
    messageId: typeof data.messageId === 'number' ? data.messageId : undefined,
    callId: readString(data.callId),
    reminderKey: readString(data.reminderKey),
    reminderTitle: readString(data.reminderTitle),
  };
}

/** Ключ напоминания `<id записи>@<день>@<минут>` (`plannerReminders.ts reminderKey`): запись и день. */
export function parseReminderKey(key: string): { id: string; day: string } | undefined {
  const parts = key.split('@');
  if (parts.length < 3) return undefined;
  const day = parts[parts.length - 2];
  const id = parts.slice(0, -2).join('@');
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  return { id, day };
}

// Тексты service worker: у него нет общего механизма языков (как у страницы публичной ссылки) — свой словарь
const WORKER_TEXTS = {
  en: {
    chats: 'Chats',
    planner: 'Planner',
    newMessage: 'New message',
    reminder: 'Reminder',
    openPlanner: 'Open the Planner',
    done: 'Done',
    snooze: 'In 10 min',
  },
  ru: {
    chats: 'Чаты',
    planner: 'План',
    newMessage: 'Новое сообщение',
    reminder: 'Напоминание',
    openPlanner: 'Откройте «План»',
    done: 'Готово',
    snooze: 'Через 10 мин',
  },
};

export function getWorkerNotifyTexts(language: string) {
  return language.toLowerCase().startsWith('ru') ? WORKER_TEXTS.ru : WORKER_TEXTS.en;
}
