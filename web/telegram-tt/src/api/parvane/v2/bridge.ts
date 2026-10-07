// Протокол v2 (spec 007, T134/T162): мост «запросы клиента → методы v2».
// Код клиента исторически говорит с сервером запросами прежней формы (subject +
// JSON через `GatewayConnection.request`). Мост переводит всё, что НЕ переписка
// (вход, регистрация и подтверждения, профили, поиск, 2FA, смена пароля,
// устройства, линковка, превью, тайлы карты, ICE, ключ push, удаление файла), в
// методы v2 (`control.ts`) и возвращает ответ прежнего вида — вызывающий код не
// меняется. Переписку, группы, звонки и присутствие ведёт движок v2
// (`controller.ts`); subject без метода v2 мост не обслуживает (`undefined`).
// Зеркало `parvane-core` `v2_bridge`.
// Текста ошибок в протоколе v2 нет (только код): мост подставляет в `error`
// ответа прежние формулировки сервера по методу и коду — на них завязаны
// экраны входа и настройки.

import { preauth, V2Control, type V2Json } from './control';
import { V2Error } from './transport';

function str(o: V2Json | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const value = o?.[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function flag(o: V2Json | undefined, ...keys: string[]): boolean {
  return keys.some((key) => o?.[key] === true);
}

// int64 в proto3-JSON — строка либо число
function int(o: V2Json | undefined, ...keys: string[]): number {
  for (const key of keys) {
    const value = o?.[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value) return Number(value) || 0;
  }
  return 0;
}

function list(o: V2Json | undefined, key: string): V2Json[] {
  const value = o?.[key];
  return Array.isArray(value) ? value as V2Json[] : [];
}

// Тело запроса: клиент шлёт либо голый объект, либо ParvaneEvent с `payload`
function bodyOf(raw: unknown): V2Json {
  if (!raw || typeof raw !== 'object') return {};
  const event = raw as V2Json;
  if (event.payload && typeof event.payload === 'object') {
    const body = { ...(event.payload as V2Json) };
    if (body.token === undefined && event.token !== undefined) body.token = event.token;
    return body;
  }
  return event;
}

function fail(error: string) {
  return { ok: false, error };
}

/** Прежние формулировки сервера (identity) по запросу и коду v2. */
export function bridgeErrorText(subject: string, code: string): string {
  if (code === 'ERROR_CODE_RATE_LIMITED') return 'слишком много попыток, попробуйте позже';
  if (code === 'ERROR_CODE_UPGRADE_REQUIRED') return 'нужна новая версия приложения';
  if (code === 'ERROR_CODE_UNAVAILABLE') return 'сервер временно недоступен';
  if (code === 'ERROR_CODE_REVOKED') return 'устройство отозвано';
  switch (subject) {
    case 'identity.token.issue':
      return code === 'ERROR_CODE_INVALID' ? 'пустой логин или пароль' : 'неверный логин или пароль';
    case 'identity.user.register':
      if (code === 'ERROR_CODE_DUPLICATE') return 'логин занят';
      if (code === 'ERROR_CODE_INVALID') {
        return 'некорректный ник или пароль: ник — 2–64 символа (латиница в нижнем регистре, цифры, _ . -), '
          + 'пароль — не короче 8 символов';
      }
      return 'нужен валидный инвайт-код';
    case 'identity.email.confirm':
      if (code === 'ERROR_CODE_EXPIRED') return 'код истёк, запросите новый';
      if (code === 'ERROR_CODE_INVALID') return 'пустой логин или код';
      return 'неверный код';
    case 'identity.user.twofa':
      if (code === 'ERROR_CODE_REAUTH_REQUIRED') return 'требуется пароль';
      if (code === 'ERROR_CODE_FORBIDDEN') return 'сначала привяжите Telegram (подтверждение через бота)';
      break;
    case 'identity.password.change':
      if (code === 'ERROR_CODE_INVALID') return 'пароль короче 8 символов';
      if (code === 'ERROR_CODE_DUPLICATE') return 'новый пароль совпадает со старым';
      return 'неверный пароль';
    case 'identity.device.revoke':
      if (code === 'ERROR_CODE_REAUTH_REQUIRED') return 'требуется пароль';
      if (code === 'ERROR_CODE_NOT_FOUND') return 'устройство не найдено';
      return 'неверный пароль';
    default:
      break;
  }
  if (subject.startsWith('identity.link.')) {
    if (code === 'ERROR_CODE_NOT_FOUND' || code === 'ERROR_CODE_EXPIRED') return 'оффер линковки не найден или истёк';
    if (code === 'ERROR_CODE_INVALID') return 'некорректный эфемерный ключ';
  }
  if (code === 'ERROR_CODE_NOT_FOUND') return 'не найдено';
  if (code === 'ERROR_CODE_INVALID') return 'некорректный запрос';
  if (code === 'ERROR_CODE_LIMIT') return 'квота исчерпана';
  if (code === 'ERROR_CODE_EXPIRED') return 'срок действия истёк';
  return 'отказано';
}

function profileToV1(p: V2Json) {
  const user: V2Json = {
    username: str(p.user as V2Json | undefined, 'address'),
    display_name: str(p, 'displayName', 'display_name'),
  };
  const put = (key: string, value: string) => {
    if (value) user[key] = value;
  };
  put('avatar', str(p, 'avatarFileId', 'avatar_file_id'));
  put('bio', str(p, 'bio'));
  put('birthday', str(p, 'birthday'));
  put('personal_channel', str(p, 'personalChannel', 'personal_channel'));
  put('phone', str(p, 'phone'));
  put('root_key', str(p, 'rootKey', 'root_key'));
  if (p.nameColor !== undefined || p.name_color !== undefined) user.name_color = int(p, 'nameColor', 'name_color');
  return user;
}

function twofaToV1(r: V2Json) {
  const out: V2Json = {
    ok: true, enabled: flag(r, 'enabled'), telegram_linked: flag(r, 'telegramLinked', 'telegram_linked'),
  };
  const bot = str(r, 'telegramBot', 'telegram_bot');
  if (bot) out.telegram_bot = bot;
  const secret = str(r, 'trustSecret', 'trust_secret');
  if (secret) out.trust_secret = secret;
  return out;
}

// bytes в proto3-JSON — base64; ключ VAPID клиент ждёт в base64url без дополнения
function toBase64Url(base64: string) {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class V2Bridge {
  private described?: V2Json;

  private token?: string;

  readonly control: V2Control;

  constructor(private readonly url: () => string) {
    this.control = new V2Control(url, () => this.token);
  }

  /** JWT сессии (после входа) — им авторизуется соединение управления. */
  setToken(token: string | undefined) {
    this.token = token;
  }

  private sessionProof?: (user: string, deviceId: string) => Promise<{ proof: string; tsMs: number } | undefined>;

  /** ID-01: источник доказательства устройства для входа (контроллер v2). */
  setSessionProof(fn: typeof this.sessionProof) {
    this.sessionProof = fn;
  }

  private async describe(): Promise<V2Json> {
    if (!this.described) this.described = await preauth(this.url(), 'server.describe', {});
    return this.described;
  }

  private pre(method: string, request: V2Json) {
    return preauth(this.url(), method, request);
  }

  // Запросы, которым нужен свежий пароль (класс 15): сначала session.reauth
  private async reauth(password: string) {
    if (password) await this.control.call('identity.session.reauth', { password });
  }

  /**
   * Запрос прежней формы методами v2. `undefined` — мост этот subject не обслуживает.
   * Отказ метода — ответ прежнего вида (`ok: false, error`); потеря связи — исключение.
   */
  async request(subject: string, payload: string): Promise<string | undefined> {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      raw = {};
    }
    const p = bodyOf(raw);
    if (typeof p.token === 'string' && p.token && !this.token) this.token = p.token;
    try {
      const out = await this.viaV2(subject, p);
      return out === undefined ? undefined : JSON.stringify(out);
    } catch (err) {
      // Потеря связи и «версия v2 клиента ниже минимальной» — исключение
      // (диалог обновления покажет контроллер v2); отказ самого метода — ответ
      // прежнего вида
      if (!(err instanceof V2Error) || err.code === 'ERROR_CODE_UNAVAILABLE'
        || err.code === 'ERROR_CODE_UPGRADE_REQUIRED') {
        throw err;
      }
      return JSON.stringify(fail(bridgeErrorText(subject, err.code)));
    }
  }

  private async viaV2(subject: string, p: V2Json): Promise<V2Json | undefined> {
    const c = this.control;
    switch (subject) {
      case 'identity.server.info': {
        const d = await this.describe();
        const modes = Array.isArray(d.registration) ? d.registration as unknown[] : [];
        const mode = typeof modes[0] === 'string' ? modes[0] : 'none';
        return {
          domain: str(d, 'domain'),
          email_required: mode === 'email',
          confirm: mode,
          telegram_bot: str(d, 'telegramBot', 'telegram_bot'),
        };
      }
      case 'identity.token.issue': {
        // ID-01: устройство, уже привязанное к журналу, доказывает свой ключ
        const proof = str(p, 'device_id') ? await this.sessionProof?.(str(p, 'user'), str(p, 'device_id')) : undefined;
        const r = await this.pre('identity.session.issue', {
          login: str(p, 'user'),
          password: str(p, 'password'),
          device_id: str(p, 'device_id'),
          login_token: str(p, 'login_token'),
          trust_secret: str(p, 'trust_secret'),
          client_kind: str(p, 'client'),
          device_proof: proof?.proof,
          proof_ts_ms: proof ? String(proof.tsMs) : undefined,
        });
        if (flag(r, 'twofaRequired', 'twofa_required')) {
          return {
            ok: false,
            twofa_required: true,
            login_token: str(r, 'loginToken', 'login_token'),
            telegram_bot: str(r, 'telegramBot', 'telegram_bot'),
          };
        }
        if (flag(r, 'confirmRequired', 'confirm_required')) return fail('почта не подтверждена');
        const out: V2Json = { ok: true, token: str(r, 'token') };
        const secret = str(r, 'trustSecret', 'trust_secret');
        if (secret) out.trust_secret = secret;
        return out;
      }
      case 'identity.user.register': {
        try {
          const r = await this.pre('identity.account.register', {
            user: str(p, 'user'), password: str(p, 'password'), invite: str(p, 'invite'), email: str(p, 'email'),
          });
          const out: V2Json = { ok: true, confirm_required: flag(r, 'confirmRequired', 'confirm_required') };
          const telegramToken = str(r, 'telegramToken', 'telegram_token');
          if (telegramToken) out.telegram_token = telegramToken;
          return out;
        } catch (err) {
          // Сервер с подтверждением по почте, а почты в запросе нет — экран
          // входа ждёт именно эту формулировку, чтобы спросить адрес
          if (err instanceof V2Error && err.code === 'ERROR_CODE_INVALID' && !str(p, 'email')) {
            const d = await this.describe().catch(() => undefined);
            if ((d?.registration as unknown[] | undefined)?.includes('email')) return fail('нужен корректный email');
          }
          throw err;
        }
      }
      case 'identity.email.confirm':
        await this.pre('identity.account.confirm_email', { user: str(p, 'user'), code: str(p, 'code') });
        return { ok: true };
      case 'identity.register.status': {
        const r = await this.pre('identity.account.register_status', { user: str(p, 'user'), token: str(p, 'token') });
        return { confirmed: flag(r, 'confirmed') };
      }
      case 'identity.user.twofa': {
        if (typeof p.enabled !== 'boolean') {
          return twofaToV1(await c.call('identity.account.get_2fa', {}));
        }
        // Свежий пароль нужен методу v2 всегда — экран настроек спрашивает его и
        // при включении, и при выключении 2FA; без пароля сервер ответит REAUTH_REQUIRED
        const password = str(p, 'password');
        await this.reauth(password);
        return twofaToV1(await c.call('identity.account.set_2fa', { enabled: p.enabled, password }));
      }
      case 'identity.password.change':
        await this.reauth(str(p, 'old_password'));
        await c.call('identity.account.change_password', {
          old_password: str(p, 'old_password'), new_password: str(p, 'new_password'),
        });
        return { ok: true };
      case 'identity.user.resolve': {
        const names = Array.isArray(p.usernames) ? p.usernames as unknown[] : [];
        const users = names.filter((name) => typeof name === 'string').map((address) => ({ address }));
        const r = await c.call('identity.profile.resolve', { users });
        return { ok: true, users: list(r, 'profiles').map(profileToV1) };
      }
      case 'identity.user.search': {
        const r = await c.call('identity.directory.search', { query: str(p, 'query') });
        return { ok: true, users: list(r, 'results').map(profileToV1) };
      }
      case 'identity.user.setname': {
        const request: V2Json = { display_name: str(p, 'display_name') };
        ['bio', 'birthday', 'personal_channel', 'phone'].forEach((key) => {
          if (typeof p[key] === 'string') request[key] = p[key];
        });
        if (typeof p.name_color === 'number') request.name_color = String(p.name_color);
        await c.call('identity.profile.set_name', request);
        return { ok: true };
      }
      case 'identity.user.setavatar':
        await c.call('identity.profile.set_avatar', { avatar_file_id: str(p, 'file_id') });
        return { ok: true };
      case 'identity.device.list': {
        const r = await c.call('identity.device.list', {});
        const devices = list(r, 'devices').filter((d) => !flag(d, 'revoked')).map((d) => ({
          device_id: str(d, 'deviceId', 'device_id'),
          signing_key: '',
          identity_key: '',
          one_time_available: 0,
          updated_at: Math.floor(int(d, 'lastSeenMs', 'last_seen_ms') / 1000),
          created_at: Math.floor(int(d, 'createdMs', 'created_ms') / 1000),
          legacy: flag(d, 'legacy'),
          label: str(d, 'clientKind', 'client_kind') || undefined,
          login_at: Math.floor(int(d, 'createdMs', 'created_ms') / 1000) || undefined,
        }));
        return { ok: true, devices };
      }
      case 'identity.device.revoke':
        await this.reauth(str(p, 'password')); // неверный пароль — отказ здесь
        try {
          await c.call('identity.device.revoke', { device_id: str(p, 'device_id') });
        } catch (err) {
          // Устройство журнала v2 (INVALID) отзывается подписанной записью
          // журнала — её пишет контроллер движка следом за этим запросом.
          // Пароль уже проверен
          if (!(err instanceof V2Error) || err.code !== 'ERROR_CODE_INVALID') throw err;
        }
        return { ok: true };
      case 'identity.link.offer':
        await c.call('identity.link.offer', {
          eph_pub: str(p, 'eph_pub'),
          commitment: str(p, 'commitment'),
          signing_key: str(p, 'signing_key'),
          revoke: p.revoke === true,
        });
        return { ok: true };
      case 'identity.link.poll': {
        const r = await c.call('identity.link.poll', {});
        const out: V2Json = {
          ok: true,
          offers: list(r, 'offers').map((o) => ({
            device_id: str(o, 'deviceId', 'device_id'),
            eph_pub: str(o, 'ephPub', 'eph_pub'),
            commitment: str(o, 'commitment'),
            signing_key: str(o, 'signingKey', 'signing_key'),
            created_at: Math.floor(int(o, 'createdMs', 'created_ms') / 1000),
            challenge_pub: str(o, 'challengePub', 'challenge_pub'),
          })),
        };
        const grant = r.grant as V2Json | undefined;
        if (grant && typeof grant === 'object') {
          out.grant = {
            box_payload: str(grant, 'boxPayload', 'box_payload'), eph_pub: str(grant, 'ephPub', 'eph_pub'),
          };
        }
        const challenge = str(r, 'challenge');
        if (challenge) out.challenge = challenge;
        return out;
      }
      case 'identity.link.challenge':
        await c.call('identity.link.challenge', { device_id: str(p, 'device_id'), eph_pub: str(p, 'eph_pub') });
        return { ok: true };
      case 'identity.link.grant':
        await c.call('identity.link.grant', {
          device_id: str(p, 'device_id'), box_payload: str(p, 'box_payload'), eph_pub: str(p, 'eph_pub'),
        });
        return { ok: true };
      case 'preview.link.fetch': {
        const r = await c.call('preview.link', { url: str(p, 'url') });
        const webpage: V2Json = { url: str(r, 'url') };
        const siteName = str(r, 'siteName', 'site_name');
        if (siteName) webpage.site_name = siteName;
        if (str(r, 'title')) webpage.title = str(r, 'title');
        if (str(r, 'description')) webpage.description = str(r, 'description');
        return { ok: true, webpage };
      }
      case 'preview.map.tile': {
        const r = await c.call('preview.map_tile', { zoom: int(p, 'z'), x: int(p, 'x'), y: int(p, 'y') });
        return { ok: true, png_base64: str(r, 'png') }; // bytes в proto3-JSON — base64
      }
      case 'call.ice.request': {
        const r = await c.call('call.ice_config', {});
        const servers = list(r, 'servers').map((s) => {
          const server: V2Json = { urls: Array.isArray(s.urls) ? s.urls : [] };
          if (str(s, 'username')) server.username = str(s, 'username');
          if (str(s, 'credential')) server.credential = str(s, 'credential');
          return server;
        });
        const left = Math.floor((int(r, 'expiresMs', 'expires_ms') - Date.now()) / 1000);
        // Шард call отвечает событием: клиенты читают серверы из `payload`
        return { payload: { ice_servers: servers, ttl_secs: Math.max(0, left) } };
      }
      case 'push.vapid.get': {
        const r = await c.call('push.wake.describe', {});
        const key = str(r, 'vapidPublicKey', 'vapid_public_key');
        return key ? { ok: true, public_key: toBase64Url(key) } : { ok: false };
      }
      case 'file.delete':
        await c.call('cloud.blob.delete', { file_id: str(p, 'file_id') });
        return { ok: true };
      default:
        return undefined;
    }
  }

  close() {
    this.control.close();
  }
}
