import { preauth } from './v2/control';
import { isTokenDueForRenewal, readRememberMe, readTokenClaims } from './authStorage';
import { getGatewayUrl } from './gateway';

// Продление сессии без пароля (правило SESSION-1, `identity.session.renew`): прежний токен (срок мог выйти) и
// подпись ключа устройства дают новый. Продление идёт при запуске и заранее, с половины срока токена; при
// отказе сервера — один раз, затем перезагрузка

// Неудачную попытку повторяем не чаще раза в час
const RETRY_MS = 60 * 60 * 1000;
// После продления по отказу сервера страница перезагружается; повторный отказ в этот срок — уже не истёкший
// токен, а настоящий отзыв: второй раз не продлеваем, спрашиваем пароль
const RELOAD_GUARD_MS = 2 * 60 * 1000;
const RELOAD_GUARD_KEY = 'parvane:session-renewed-at';

type Deps = {
  getToken: () => string;
  // Новый токен становится токеном сессии: следующее подключение идёт уже с ним
  setToken: (token: string) => void;
  buildProof: (address: string, deviceId: string) => Promise<{ proof: string; tsMs: number } | undefined>;
  saveToken: (address: string, token: string) => Promise<void>;
  log: (message: string) => void;
};

export function createSessionRenewal(deps: Deps) {
  let lastFailedAt = 0;
  let inFlight: Promise<string | undefined> | undefined;

  async function requestToken(address: string, current: string) {
    const deviceId = readTokenClaims(current)?.dev;
    if (!deviceId) return undefined;
    const proof = await deps.buildProof(address, deviceId);
    if (!proof) return undefined;
    const reply = await preauth(getGatewayUrl(), 'identity.session.renew', {
      token: current, device_proof: proof.proof, proof_ts_ms: String(proof.tsMs),
    });
    return typeof reply.token === 'string' && reply.token ? reply.token : undefined;
  }

  /** Новый токен вместо `current`. `undefined` — сервер отказал, нет связи или у устройства нет ключа в
   * журнале: вызывающий остаётся с прежним токеном. */
  function renew(address: string, current: string): Promise<string | undefined> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await requestToken(address, current);
        if (!next) {
          lastFailedAt = Date.now();
          return undefined;
        }
        if (deps.getToken() === current) deps.setToken(next);
        if (readRememberMe()) await deps.saveToken(address, next).catch(() => undefined);
        lastFailedAt = 0;
        deps.log('сессия продлена без пароля');
        return next;
      } catch (err) {
        lastFailedAt = Date.now();
        deps.log(`продление сессии не удалось: ${String(err)}`);
        return undefined;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  /** Токен для запуска: продлённый, если прежнему пора; не вышло — прежний (живой сервер примет, истёкший
   * отвергнет, и продление повторится по отказу). */
  async function freshForStart(address: string, saved: string) {
    if (!isTokenDueForRenewal(saved)) return saved;
    return await renew(address, saved) || saved;
  }

  /** Открытая вкладка: продлить заранее, не дожидаясь отказа сервера. */
  function renewIfDue(address: string) {
    const current = deps.getToken();
    if (!address || !current || !isTokenDueForRenewal(current)) return;
    if (Date.now() - lastFailedAt < RETRY_MS) return;
    void renew(address, current);
  }

  /** Сервер отверг токен. `true` — токен продлён и сохранён, страницу можно перезагружать без пароля. */
  async function recoverAfterReject(address: string, rejected: string) {
    if (!address || !rejected || !readRememberMe()) return false;
    if (Date.now() - readReloadGuard() <= RELOAD_GUARD_MS) return false;
    if (!await renew(address, rejected)) return false;
    try {
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch {
      // Без отметки повторный отказ продлит ещё раз — сервер откажет, и вход пойдёт паролем
    }
    return true;
  }

  return { freshForStart, renewIfDue, recoverAfterReject };
}

function readReloadGuard() {
  try {
    return Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
  } catch {
    return 0;
  }
}
