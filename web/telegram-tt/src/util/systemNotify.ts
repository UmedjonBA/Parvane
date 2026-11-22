// Системные уведомления по доске `ZpSystem` (spec 041 F2): заголовок «Parvane · <модуль>», действия по виду
// уведомления и то, что делает нажатие. Здесь только правила — без DOM и глобального состояния: модуль читают
// и страница (`util/notifications.tsx`, звонки, напоминания), и service worker (`serviceWorker/pushNotification.ts`).
// Действия (`actions`) показывают Chromium на Android и компьютере; Safari и iOS их не показывают — там
// работает только нажатие на само уведомление

export type NotifyKind = 'message' | 'call' | 'reminder' | 'music' | 'wake';
// Пустая строка — нажатие на само уведомление, а не на кнопку
export type NotifyAction = '' | 'reply' | 'read' | 'answer' | 'decline' | 'done' | 'snooze' | 'listen';

// То, что лежит в `notification.data`: по нему service worker и страница решают, что открыть
export type NotifyData = {
  kind: NotifyKind;
  chatId?: string;
  messageId?: number;
  callId?: string;
  reminderKey?: string;
  reminderTitle?: string;
  // «Трек скачан на сервер» (доска `ZpSystem`): «Слушать» играет этот трек
  trackId?: string;
};

// Команда странице: что сделать по нажатию (`util/notifyCommands.ts`)
export type NotifyCommand = NotifyData & { action: NotifyAction; id?: string };

export type NotifyButton = { action: Exclude<NotifyAction, ''>; title: string };

export const NOTIFY_SNOOZE_MS = 10 * 60 * 1000;

const ACTIONS: Record<NotifyKind, Exclude<NotifyAction, ''>[]> = {
  message: ['reply', 'read'],
  call: ['answer', 'decline'],
  reminder: ['done', 'snooze'],
  music: ['listen'],
  // Пробуждение сервера пустое (E2E): ни чата, ни текста — делать с ним нечего, только открыть приложение
  wake: [],
};

// Действия, которым не нужно показывать приложение: страница выполнит их в фоне
const BACKGROUND_ACTIONS = new Set<NotifyAction>(['read', 'decline', 'done', 'snooze']);
const KNOWN_KINDS = new Set<string>(Object.keys(ACTIONS));
const KNOWN_ACTIONS = new Set<string>(['', 'reply', 'read', 'answer', 'decline', 'done', 'snooze', 'listen']);

/** Заголовок уведомления: «Parvane · Чаты». */
export function buildNotifyTitle(appName: string, moduleName: string) {
  return `${appName} · ${moduleName}`;
}

/**
 * Текст уведомления о сообщении: чат первой строкой, затем текст. Текст — только если он включён в настройках
 * уведомлений, иначе «Новое сообщение». Экран заблокирован PIN — ни чата, ни текста, только «Новое сообщение» и
 * подсказка второй строкой («Разблокируйте, чтобы прочитать», доска `ZpSystem`).
 */
export function buildMessageNotifyBody({
  chatTitle, senderName, summary, isTextShown, isLocked, hiddenText, lockedHint,
}: {
  chatTitle: string;
  // Автор в группе; в личном чате совпадает с названием чата и не повторяется
  senderName?: string;
  summary: string;
  isTextShown: boolean;
  isLocked: boolean;
  hiddenText: string;
  lockedHint?: string;
}) {
  if (isLocked) return lockedHint ? `${hiddenText}\n${lockedHint}` : hiddenText;
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
    trackId: readString(data.trackId),
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

// Настройки уведомлений устройства (spec 041 E3, доски `PhProfileA`, `DkSettingsB`): выключенные модули и «Не
// беспокоить». Хранит их `util/notifyPrefs.ts`, копию для service worker — `reminderStore.ts`. «Музыка» — уведомление
// «Трек скачан на сервер», «Здоровье» — напоминание об отбое, «Файлы» — приглашение в общую папку и ссылка в чате
export type NotifyModule = 'chats' | 'plan' | 'health' | 'files' | 'music';

export type NotifyPrefs = {
  off: NotifyModule[];
  isQuietOn: boolean;
  // Минуты от полуночи; конец раньше начала — тишина через полночь
  quietFrom: number;
  quietTo: number;
  // Часы заданы вручную; иначе «Не беспокоить» следует режиму сна из «Здоровья» (доска `DkSettingsB`)
  isQuietCustom: boolean;
  // Текст уведомлений и при экране под PIN (выключатель «Скрывать текст…, пока заблокировано», доска `ZdProfileX`)
  isLockedTextShown: boolean;
  // «Не беспокоить 1 час / до утра» (доска `ZdMisc`): до этого момента (мс) уведомлений нет; 0 — не включено
  muteUntil: number;
};

const MINUTES_IN_DAY = 24 * 60;
const NOTIFY_MODULES = new Set<string>(['chats', 'plan', 'health', 'files', 'music']);
// Ключ напоминания об отбое (`plannerReminders.ts getBedtimeReminders`)
const BEDTIME_KEY_PREFIX = 'bedtime@';
const MS_IN_MINUTE = 60 * 1000;
const MS_IN_HOUR = 60 * MS_IN_MINUTE;

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  off: [], isQuietOn: false, quietFrom: 23 * 60 + 30, quietTo: 7 * 60, isQuietCustom: false, isLockedTextShown: false,
  muteUntil: 0,
};

/** Сохранённые настройки любой версии: неизвестное и испорченное — по умолчанию. */
export function readNotifyPrefs(raw: unknown): NotifyPrefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_NOTIFY_PREFS;
  const data = raw as Record<string, unknown>;
  const readMinutes = (value: unknown, fallback: number) => (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MINUTES_IN_DAY ? value : fallback
  );
  return {
    off: Array.isArray(data.off)
      ? data.off.filter((id): id is NotifyModule => typeof id === 'string' && NOTIFY_MODULES.has(id))
      : [],
    isQuietOn: data.isQuietOn === true,
    quietFrom: readMinutes(data.quietFrom, DEFAULT_NOTIFY_PREFS.quietFrom),
    quietTo: readMinutes(data.quietTo, DEFAULT_NOTIFY_PREFS.quietTo),
    isQuietCustom: data.isQuietCustom === true,
    isLockedTextShown: data.isLockedTextShown === true,
    muteUntil: typeof data.muteUntil === 'number' && Number.isFinite(data.muteUntil) && data.muteUntil > 0
      ? data.muteUntil : 0,
  };
}

/** Модуль напоминания по его ключу: отбой — «Здоровье», остальное — «План». */
export function getReminderNotifyModule(key: string): NotifyModule {
  return key.startsWith(BEDTIME_KEY_PREFIX) ? 'health' : 'plan';
}

/** Попадает ли минута суток в «Не беспокоить»; начало входит, конец — нет. */
export function getIsQuietMinute(prefs: NotifyPrefs, minute: number) {
  if (!prefs.isQuietOn || prefs.quietFrom === prefs.quietTo) return false;
  if (prefs.quietFrom < prefs.quietTo) return minute >= prefs.quietFrom && minute < prefs.quietTo;
  return minute >= prefs.quietFrom || minute < prefs.quietTo;
}

/**
 * «Не беспокоить на время»: час от сейчас либо до утра — до ближайшего конца тишины по расписанию (по умолчанию 07:00;
 * в 02:00 — сегодня утром, днём — завтра утром).
 */
export function buildMuteUntil(span: 'hour' | 'morning', prefs: NotifyPrefs, now: Date) {
  if (span === 'hour') return now.getTime() + MS_IN_HOUR;
  const morning = new Date(now);
  morning.setHours(Math.floor(prefs.quietTo / 60), prefs.quietTo % 60, 0, 0);
  if (morning.getTime() <= now.getTime()) morning.setDate(morning.getDate() + 1);
  return morning.getTime();
}

/** Показывать ли уведомление модуля сейчас: модуль не выключен, нет «Не беспокоить» на время и по расписанию. */
export function getIsNotifyAllowed(prefs: NotifyPrefs, module: NotifyModule, now: Date) {
  if (prefs.off.includes(module)) return false;
  if (now.getTime() < prefs.muteUntil) return false;
  return !getIsQuietMinute(prefs, now.getHours() * 60 + now.getMinutes());
}

// Тексты service worker: у него нет общего механизма языков (как у страницы публичной ссылки) — свой словарь
const WORKER_TEXTS = {
  en: {
    chats: 'Chats',
    planner: 'Plan',
    health: 'Health',
    newMessage: 'New message',
    reminder: 'Reminder',
    openPlanner: 'Open Plan',
    done: 'Done',
    snooze: 'In 10 min',
  },
  ru: {
    chats: 'Чаты',
    planner: 'План',
    health: 'Здоровье',
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
