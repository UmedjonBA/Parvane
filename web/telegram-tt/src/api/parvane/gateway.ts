// Сессия с Parvane gateway (протокол v2, spec 007). JSON-транспорт v1 удалён
// (T110): переписка, группы, звонки, «печатает»/«в сети» идут движком v2
// (`v2/controller.ts`), а всё остальное (вход, регистрация, профили, поиск,
// устройства, линковка, превью, ICE, push, удаление файла) — методами v2 через
// мост (`v2/bridge.ts`): запрос прежней формы (subject + JSON) → метод v2 →
// ответ прежнего вида. `GatewayConnection` — ручка сессии провайдера: держит
// JWT и отдаёт запросы мосту.

import { V2Bridge } from './v2/bridge';

const GATEWAY_URL_STORAGE_KEY = 'parvane:gateway';

let sharedBridge: V2Bridge | undefined;

/** Мост «запросы клиента → методы v2» — один на страницу. */
export function getV2Bridge(): V2Bridge {
  if (!sharedBridge) sharedBridge = new V2Bridge(getGatewayUrl);
  return sharedBridge;
}

// Адрес аккаунта из JWT (claim `sub`)
function jwtSubject(token: string): string {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String((JSON.parse(atob(payload)) as { sub?: string }).sub || '');
  } catch {
    return '';
  }
}

export function getGatewayUrl() {
  // Страница на https обязана ходить в gateway по wss (mixed content всё равно
  // блокируется браузером); prod-раскладка — wss на том же origin за
  // реверс-прокси по пути /ws (наружу проброшен один порт)
  const isSecurePage = window.location.protocol === 'https:';
  // Переопределение из localStorage — только wss на https-странице: иначе
  // запись в localStorage (расширение/XSS) уводила бы логин на чужой ws://
  const override = localStorage.getItem(GATEWAY_URL_STORAGE_KEY);
  const isOverrideAllowed = Boolean(override) && (!isSecurePage || override.startsWith('wss://'));
  return (isOverrideAllowed ? override : undefined)
    || (isSecurePage
      ? `wss://${window.location.host}/ws`
      : `ws://${window.location.hostname}:9222`);
}

export class GatewayConnection {
  /** JWT сессии: им авторизуется соединение управления моста. */
  authorize(token: string) {
    getV2Bridge().setToken(token);
    return jwtSubject(token);
  }

  /**
   * Запрос прежней формы методами v2. Отказ метода — ответ `{ok: false, error}`
   * прежнего вида; потеря связи — исключение; subject без метода v2 — исключение
   */
  async request(subject: string, payload: string): Promise<string> {
    const viaV2 = await getV2Bridge().request(subject, payload);
    if (viaV2 === undefined) throw new Error(`Gateway: запрос ${subject} не обслуживается протоколом v2`);
    return viaV2;
  }
}
