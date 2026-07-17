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
  return localStorage.getItem(GATEWAY_URL_STORAGE_KEY)
    || `ws://${window.location.hostname}:9222`;
}

export class GatewayConnection {
  private ws?: WebSocket;

  private requestSeq = 0;

  private pendingById = new Map<string, PendingRequest>();

  private handlersBySubject = new Map<string, (payload: string) => void>();

  // Для NATS-wildcard подписок вида `presence.*` — матчим по префиксу
  private wildcardHandlers: { prefix: string; handler: (payload: string) => void }[] = [];

  private pendingAuth?: { resolve: (user: string) => void; reject: (err: Error) => void };

  onClose?: () => void;

  connect(url: string) {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`Gateway недоступен: ${url}`));
      ws.onclose = () => {
        this.failAllPending(new Error('Соединение с gateway закрыто'));
        this.onClose?.();
      };
      ws.onmessage = (e) => this.handleFrame(String(e.data));
    });
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
        const pending = frame.id ? this.pendingById.get(frame.id) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingById.delete(frame.id!);
          pending.resolve(frame.payload || '');
        }
        break;
      }
      case 'err': {
        const pending = frame.id ? this.pendingById.get(frame.id) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingById.delete(frame.id!);
          pending.reject(new Error(frame.error || 'Ошибка запроса'));
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
    this.pendingAuth?.reject(err);
    this.pendingAuth = undefined;
  }
}
