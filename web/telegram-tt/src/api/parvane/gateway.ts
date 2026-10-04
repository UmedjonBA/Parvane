// Соединение с Parvane gateway: JSON-кадры поверх WebSocket.
// Протокол (backend/shards/gateway): до `auth` разрешены только bootstrap-запросы
// (identity.token.issue / identity.user.register); после — pub/req/reqmany/sub.
//
// T134 (spec 007): при включённом v2 всё, что не переписка (вход, профили,
// устройства, линковка, превью, push, ICE), уходит методами v2 через мост
// (`v2/bridge.ts`), а само JSON-соединение v1 необязательно: сервер с
// `PARVANE_V1_MODE=disabled` отвечает `upgrade_required` и закрывает его —
// соединение становится «виртуальным» (`hasV1 === false`): запросы моста
// работают, публикации и подписки v1 молча ничего не делают, остальные запросы
// отклоняются. Обрыв такого соединения не запускает переподключение.

import { bridgePrefersV1, V2Bridge } from './v2/bridge';
import { isV2Enabled } from './v2/engine';

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const GATEWAY_URL_STORAGE_KEY = 'parvane:gateway';

type GatewayFrame = {
  op: string;
  id?: string;
  subject?: string;
  payload?: string;
  token?: string;
  timeout_ms?: number;
  error?: string;
  user?: string;
  kind?: string;
};

type PendingRequest = {
  resolve: (payload: string) => void;
  reject: (err: Error) => void;
  timer: number;
};

// Сервер отключил v1 (кадр `upgrade_required`): новых JSON-соединений не
// открываем, пока не пройдёт пауза (оператор мог вернуть v1)
const V1_RETRY_GAP_MS = 5 * 60 * 1000;
let v1DisabledAt = 0;

function isV1Blocked() {
  return v1DisabledAt !== 0 && Date.now() - v1DisabledAt < V1_RETRY_GAP_MS;
}

let sharedBridge: V2Bridge | undefined;

/** Мост «запросы клиента → методы v2» — один на страницу. */
export function getV2Bridge(): V2Bridge {
  if (!sharedBridge) sharedBridge = new V2Bridge(getGatewayUrl);
  return sharedBridge;
}

// Адрес аккаунта из JWT (claim `sub`) — виртуальному соединению некому ответить `auth_ok`
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
  private ws?: WebSocket;

  private requestSeq = 0;

  private pendingById = new Map<string, PendingRequest>();

  private handlersBySubject = new Map<string, (payload: string) => void>();

  // Для NATS-wildcard подписок вида `presence.*` — матчим по префиксу
  private wildcardHandlers: { prefix: string; handler: (payload: string) => void }[] = [];

  private pendingAuth?: { resolve: (user: string) => void; reject: (err: Error) => void };

  // T134: соединения v1 нет (сервер его отключил) — работает только мост v2
  private isVirtual = false;

  private authToken?: string;

  private pendingManyById = new Map<string, {
    onReply: (payload: string) => void;
    onEnd: () => void;
    onError: (err: Error) => void;
  }>();

  onClose?: () => void;

  connect(url: string) {
    if (isV2Enabled() && isV1Blocked()) {
      this.becomeVirtual();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      let isSettled = false;
      this.ws = ws;
      ws.onopen = () => {
        isSettled = true;
        resolve();
      };
      ws.onerror = () => {
        if (isSettled) return;
        isSettled = true;
        reject(new Error(`Gateway недоступен: ${url}`));
      };
      ws.onclose = () => {
        if (this.isVirtual) {
          // v1 отключён сервером: это не обрыв — переподключение не нужно
          if (!isSettled) {
            isSettled = true;
            resolve();
          }
          this.settleVirtualAuth();
          this.failAllPending(new Error('Gateway: v1 отключён сервером'));
          return;
        }
        const error = new Error('Соединение с gateway закрыто');
        if (!isSettled) {
          isSettled = true;
          reject(error);
        }
        this.failAllPending(error);
        this.onClose?.();
      };
      ws.onmessage = (e) => this.handleFrame(String(e.data));
    });
  }

  get isOpen() {
    return this.isVirtual || this.ws?.readyState === WebSocket.OPEN;
  }

  /** Живо ли JSON-соединение v1 (переписка с v1-собеседниками, группы и синк v1). */
  get hasV1() {
    return !this.isVirtual && this.ws?.readyState === WebSocket.OPEN;
  }

  authorize(token: string) {
    this.authToken = token;
    if (isV2Enabled()) getV2Bridge().setToken(token);
    if (this.isVirtual) return Promise.resolve(jwtSubject(token));
    return new Promise<string>((resolve, reject) => {
      this.pendingAuth = { resolve, reject };
      this.sendFrame({ op: 'auth', token });
    });
  }

  private becomeVirtual() {
    if (this.isVirtual) return;
    this.isVirtual = true;
    // Провайдер пишет об этом в журнал (один раз на соединение)
    window.dispatchEvent(new CustomEvent('parvane-v1-disabled'));
  }

  private settleVirtualAuth() {
    if (!this.pendingAuth) return;
    this.pendingAuth.resolve(jwtSubject(this.authToken || ''));
    this.pendingAuth = undefined;
  }

  async request(subject: string, payload: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string> {
    // T134: запросы управления — методами v2; «v1, если жив» — по v1, пока оно есть
    if (isV2Enabled() && !(bridgePrefersV1(subject) && this.hasV1)) {
      try {
        const viaV2 = await getV2Bridge().request(subject, payload, this.hasV1);
        if (viaV2 !== undefined) return viaV2;
      } catch (err) {
        // Мост недоступен (движок не загрузился, сеть) — по v1, пока оно живо.
        // Отказ самого метода сюда не попадает: он приходит ответом `ok: false`
        if (!this.hasV1) throw err;
      }
    }
    if (this.isVirtual) throw new Error(`Gateway: v1 отключён сервером (${subject})`);
    return this.requestV1(subject, payload, timeoutMs);
  }

  private requestV1(subject: string, payload: string, timeoutMs: number) {
    const id = String(++this.requestSeq);
    return new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingById.delete(id);
        reject(new Error(`Таймаут запроса ${subject}`));
      }, timeoutMs + 1000);
      this.pendingById.set(id, { resolve, reject, timer });
      this.sendFrame({
        op: 'req', id, subject, payload, timeout_ms: timeoutMs,
      });
    });
  }

  // Один запрос — много ответов (чанки файла): собираем до reply_end.
  // ВАЖНО: gateway ждёт `timeout_ms` ТИШИНЫ после последнего ответа, прежде чем
  // прислать reply_end — интервал должен быть коротким, а общий лимит щедрым
  // `isComplete` — досрочное завершение, когда ответов уже достаточно (число
  // чанков известно): не ждём паузу тишины, поздний reply_end игнорируется
  requestMany(
    subject: string,
    payload: string,
    silenceMs = 4000,
    totalMs = 90000,
    isComplete?: (replies: string[]) => boolean,
  ) {
    if (this.isVirtual) return Promise.reject(new Error(`Gateway: v1 отключён сервером (${subject})`));
    const id = String(++this.requestSeq);
    return new Promise<string[]>((resolve, reject) => {
      const replies: string[] = [];
      const timer = window.setTimeout(() => {
        this.pendingManyById.delete(id);
        reject(new Error(`Таймаут reqmany ${subject}`));
      }, totalMs);
      this.pendingManyById.set(id, {
        onReply: (reply) => {
          replies.push(reply);
          if (isComplete?.(replies)) {
            clearTimeout(timer);
            this.pendingManyById.delete(id);
            resolve(replies);
          }
        },
        onEnd: () => {
          clearTimeout(timer);
          this.pendingManyById.delete(id);
          resolve(replies);
        },
        onError: (err) => {
          clearTimeout(timer);
          this.pendingManyById.delete(id);
          reject(err);
        },
      });
      this.sendFrame({
        op: 'reqmany', id, subject, payload, timeout_ms: silenceMs,
      });
    });
  }

  publish(subject: string, payload: string) {
    if (this.isVirtual) return;
    this.sendFrame({ op: 'pub', subject, payload });
  }

  subscribe(subject: string, handler: (payload: string) => void) {
    if (subject.endsWith('.*')) {
      this.wildcardHandlers.push({ prefix: subject.slice(0, -1), handler });
    } else {
      this.handlersBySubject.set(subject, handler);
    }
    if (this.isVirtual) return;
    this.sendFrame({ op: 'sub', subject });
  }

  /**
   * Подать кадр подписчику subject'а, как если бы он пришёл по v1: записи
   * `LegacyV1` инбокса v2 несут кадры инбокса v1 (история и живые кадры), а без
   * соединения v1 это единственный путь, которым они доходят (FR-053).
   */
  deliver(subject: string, payload: string) {
    this.handlersBySubject.get(subject)?.(payload);
  }

  close() {
    this.ws?.close();
  }

  private sendFrame(frame: GatewayFrame) {
    if (this.isVirtual) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway: соединение не открыто');
    }
    this.ws.send(JSON.stringify(frame));
  }

  private handleFrame(text: string) {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }

    switch (frame.op) {
      case 'auth_ok':
        this.pendingAuth?.resolve(frame.user!);
        this.pendingAuth = undefined;
        break;
      case 'auth_err':
        this.pendingAuth?.reject(new Error(frame.error || 'Авторизация отклонена'));
        this.pendingAuth = undefined;
        break;
      case 'reply': {
        const pendingMany = frame.id ? this.pendingManyById.get(frame.id) : undefined;
        if (pendingMany) {
          pendingMany.onReply(frame.payload || '');
          break;
        }
        const pending = frame.id ? this.pendingById.get(frame.id) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingById.delete(frame.id!);
          pending.resolve(frame.payload || '');
        }
        break;
      }
      case 'reply_end': {
        const pendingMany = frame.id ? this.pendingManyById.get(frame.id) : undefined;
        pendingMany?.onEnd();
        break;
      }
      case 'err': {
        const pendingMany = frame.id ? this.pendingManyById.get(frame.id) : undefined;
        if (pendingMany) {
          pendingMany.onError(new Error(frame.error || 'Ошибка запроса'));
          break;
        }
        const pending = frame.id ? this.pendingById.get(frame.id) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingById.delete(frame.id!);
          pending.reject(new Error(frame.error || 'Ошибка запроса'));
        }
        // Лимит частоты gateway (в т.ч. на fire-and-forget publish без id):
        // UI показывает предупреждение через провайдер
        if ((frame.error || '').startsWith('rate_limited')) {
          window.dispatchEvent(new CustomEvent('parvane-rate-limited', { detail: frame.subject || '' }));
        }
        // E6 (spec 007): сервер отключил v1-путь. Клиент на v2 без него
        // работоспособен (T134) — соединение становится виртуальным; без v2
        // нужна новая версия клиента
        if (frame.error === 'upgrade_required') {
          if (isV2Enabled()) {
            v1DisabledAt = Date.now();
            this.becomeVirtual();
            this.settleVirtualAuth();
          } else {
            window.dispatchEvent(new CustomEvent('parvane-upgrade-required'));
          }
        }
        break;
      }
      case 'notice':
        if (frame.kind === 'upgrade_available') window.dispatchEvent(new CustomEvent('parvane-upgrade-available'));
        break;
      case 'msg': {
        const subject = frame.subject || '';
        const handler = this.handlersBySubject.get(subject)
          || this.wildcardHandlers.find(({ prefix }) => subject.startsWith(prefix))?.handler;
        handler?.(frame.payload || '');
        break;
      }
      default:
        break;
    }
  }

  private failAllPending(err: Error) {
    this.pendingById.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(err);
    });
    this.pendingById.clear();
    this.pendingManyById.forEach((pending) => pending.onError(err));
    this.pendingManyById.clear();
    this.pendingAuth?.reject(err);
    this.pendingAuth = undefined;
  }
}
