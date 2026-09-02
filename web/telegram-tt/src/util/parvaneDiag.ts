/**
 * Parvane: ВРЕМЕННЫЙ журнал действий клиента для отладки багов у живых
 * пользователей (решение пользователя, сентябрь 2026). Пишет кольцевой буфер
 * событий (действия UI, вызовы API-провайдера, апдейты, ошибки) в
 * localStorage и отдаёт его кнопке «Report a Bug» (меню ⋮ → More), которая
 * отправляет описание + JSON-журнал сообщением на адрес
 * PARVANE_BUG_REPORT_ADDRESS. СОДЕРЖИМОЕ сообщений/паролей НЕ пишется —
 * только длины строк, id и имена действий. После финального деплоя модуль
 * удаляется целиком (точки врезки помечены «parvaneDiag»).
 */

export const PARVANE_DIAG_ENABLED = true;
export const PARVANE_BUG_REPORT_ADDRESS = (
  (import.meta.env?.VITE_PARVANE_BUG_REPORT_TO as string | undefined) || 'bugs@server'
);

export type DiagEntry = {
  t: number; // Date.now()
  k: string; // kind: act:<action> | api:<method> | upd:<@type> | err | nav
  d?: string; // краткие детали (без пользовательского контента)
  n?: number; // счётчик схлопнутых повторов
};

const STORAGE_KEY = 'parvane:diag:v1';
const MAX_ENTRIES = 800;
const SAVE_DELAY_MS = 1500;
const DEDUPE_WINDOW_MS = 60;
const SENSITIVE_KEYS = new Set([
  'text', 'query', 'password', 'caption', 'html', 'code', 'email', 'draft', 'title', 'description',
  'firstName', 'lastName', 'token', 'ciphertext', 'key', 'secret',
]);
const ID_KEYS = new Set(['chat', 'peer', 'message', 'user', 'messageList', 'attachment']);

let entries: DiagEntry[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let installed = false;
let lastKey = '';
let lastAt = 0;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) entries = JSON.parse(raw) as DiagEntry[];
  } catch {
    entries = [];
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // quota / приватный режим — журнал остаётся только в памяти
    }
  }, SAVE_DELAY_MS);
}

function idToString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '?';
}

function truncate(value: string, max = 48) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function summarize(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'undefined' || (typeof value === 'object' && !value)) return undefined;
  if (typeof value === 'string') return `"${truncate(value)}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value !== 'object') return typeof value;
  if (depth > 0) {
    const obj = value as Record<string, unknown>;
    const id = obj.id ?? obj.chatId;
    return id !== undefined ? `{id:${idToString(id)}}` : '{…}';
  }
  const parts: string[] = [];
  Object.entries(value as Record<string, unknown>).slice(0, 10).forEach(([key, item]) => {
    if (item === undefined || typeof item === 'function') return;
    if (SENSITIVE_KEYS.has(key)) {
      parts.push(`${key}:len=${typeof item === 'string' ? item.length : '?'}`);
      return;
    }
    if (ID_KEYS.has(key) && item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      parts.push(`${key}:${idToString(obj.id ?? obj.chatId)}`);
      return;
    }
    const summary = summarize(item, depth + 1);
    if (summary !== undefined) parts.push(`${key}:${summary}`);
  });
  return `{${parts.join(',')}}`;
}

export function diagLog(kind: string, details?: unknown) {
  if (!PARVANE_DIAG_ENABLED) return;
  const d = typeof details === 'string' ? details : summarize(details);
  const now = Date.now();
  const key = `${kind}|${d || ''}`;
  const last = entries[entries.length - 1];
  if (last && key === lastKey && now - lastAt < DEDUPE_WINDOW_MS) {
    last.n = (last.n || 1) + 1;
    lastAt = now;
    return;
  }
  lastKey = key;
  lastAt = now;
  entries.push(d ? { t: now, k: kind, d } : { t: now, k: kind });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  scheduleSave();
}

export function getDiagEntries(): DiagEntry[] {
  return entries.slice();
}

export function clearDiag() {
  entries = [];
  scheduleSave();
}

// Открытие модалки отчёта из любого места UI без прокидывания пропсов
// (пункт меню живёт в дропдауне, модалка — в Main).
export const BUG_REPORT_OPEN_EVENT = 'parvane:open-bug-report';
export function openBugReport() {
  window.dispatchEvent(new CustomEvent(BUG_REPORT_OPEN_EVENT));
}

export function installParvaneDiag() {
  if (installed || !PARVANE_DIAG_ENABLED || typeof window === 'undefined') return;
  installed = true;
  load();
  diagLog('nav', `${truncate(navigator.userAgent, 80)} online=${navigator.onLine}`);
  window.addEventListener('error', (event) => {
    diagLog('err', truncate(`${event.message} @${event.filename}:${event.lineno}`, 200));
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string } | string | undefined;
    const text = typeof reason === 'string' ? reason : reason?.message || 'unknown';
    diagLog('err', `unhandled: ${truncate(text, 200)}`);
  });
  window.addEventListener('online', () => diagLog('nav', 'online'));
  window.addEventListener('offline', () => diagLog('nav', 'offline'));
  document.addEventListener('visibilitychange', () => diagLog('nav', `visibility=${document.visibilityState}`));
  // eslint-disable-next-line no-console
  const originalError = console.error;
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    diagLog('cerr', truncate(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '), 200));
    originalError.apply(console, args);
  };
}
