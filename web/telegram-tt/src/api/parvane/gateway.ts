// Соединение с Parvane gateway: JSON-кадры поверх WebSocket.
// Протокол (shards/gateway): до `auth` разрешены только bootstrap-запросы
// (identity.token.issue / identity.user.register); после — pub/req/reqmany/sub.

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
};

type PendingRequest = {
  resolve: (payload: string) => void;
  reject: (err: Error) => void;
  timer: number;
};

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

  private pendingManyById = new Map<string, {
    onReply: (payload: string) => void;
    onEnd: () => void;
    onError: (err: Error) => void;
  }>();

  onClose?: () => void;

  connect(url: string) {
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
    return this.ws?.readyState === WebSocket.OPEN;
  }

  authorize(token: string) {
    return new Promise<string>((resolve, reject) => {
      this.pendingAuth = { resolve, reject };
      this.sendFrame({ op: 'auth', token });
    });
  }

  request(subject: string, payload: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
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
    this.sendFrame({ op: 'pub', subject, payload });
  }

  subscribe(subject: string, handler: (payload: string) => void) {
    if (subject.endsWith('.*')) {
      this.wildcardHandlers.push({ prefix: subject.slice(0, -1), handler });
    } else {
      this.handlersBySubject.set(subject, handler);
    }
    this.sendFrame({ op: 'sub', subject });
  }

  close() {
    this.ws?.close();
  }

  private sendFrame(frame: GatewayFrame) {
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
        break;
      }
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
