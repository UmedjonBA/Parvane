import { PRF_SALT_BYTES } from './storagePrfWrap';

// Обращение к аутентификатору для входа по отпечатку (WebAuthn, расширение PRF). Ключ создаётся только для этого
// устройства: сервер о нём не знает, вызов `challenge` проверять некому — он случайный. Пользователь проверяется
// самим аутентификатором (`userVerification: required`): отпечаток, лицо либо PIN ключа безопасности
export type PrfCredential = { credentialId: Uint8Array; prfSalt: Uint8Array; prf: Uint8Array };
export type PrfFailure = 'unsupported' | 'cancelled' | 'failed';

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };
type CredentialsApi = Pick<CredentialsContainer, 'create' | 'get'>;

const RP_NAME = 'Parvane';
const CHALLENGE_BYTES = 32;
const USER_ID_BYTES = 16;
const TIMEOUT_MS = 60_000;
// ES256 и RS256 — их поддерживают все аутентификаторы
const ALGORITHMS = [-7, -257];
// Браузер уже отвечал, что PRF здесь нет: функцию больше не предлагаем (настройка браузера, не аккаунта)
const UNSUPPORTED_KEY = 'parvane:webauthn-prf-unsupported';
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;

/** Предлагать ли вход по отпечатку: WebAuthn есть, адрес годится для ключа (не IP), браузер не отказывал в PRF. */
export async function checkPrfOffered() {
  if (typeof window === 'undefined' || !window.isSecureContext || !window.PublicKeyCredential) return false;
  if (!navigator.credentials || IP_HOST.test(window.location.hostname)) return false;
  if (readUnsupported()) return false;
  const getCapabilities = (PublicKeyCredential as unknown as {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
  }).getClientCapabilities;
  if (!getCapabilities) return true;
  try {
    const capabilities = await getCapabilities.call(PublicKeyCredential);
    return capabilities['extension:prf'] !== false;
  } catch {
    return true;
  }
}

/** Новый ключ аутентификатора и сразу секрет PRF для него. Без PRF — `unsupported` (и больше не предлагаем). */
export async function createPrfCredential(
  userName: string, credentials: CredentialsApi = navigator.credentials,
): Promise<PrfCredential | PrfFailure> {
  const prfSalt = randomBytes(PRF_SALT_BYTES);
  let created: PublicKeyCredential;
  try {
    created = await credentials.create({
      publicKey: {
        rp: { name: RP_NAME },
        user: { id: randomBytes(USER_ID_BYTES), name: userName, displayName: userName },
        challenge: randomBytes(CHALLENGE_BYTES),
        pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
        authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
        timeout: TIMEOUT_MS,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    }) as PublicKeyCredential;
  } catch (err) {
    return classifyError(err);
  }
  if (!created) return 'failed';
  const credentialId = new Uint8Array(created.rawId);
  const prf = readPrf(created);
  if (!prf.enabled) {
    markUnsupported();
    return 'unsupported';
  }
  // Часть аутентификаторов отдаёт секрет только при входе, не при создании
  const first = toBytes(prf.results?.first);
  if (first) return { credentialId, prfSalt, prf: first };
  const evaluated = await evaluatePrf(credentialId, prfSalt, credentials);
  return typeof evaluated === 'string' ? evaluated : { credentialId, prfSalt, prf: evaluated };
}

/** Секрет PRF уже созданного ключа: проверка пользователя на аутентификаторе. */
export async function evaluatePrf(
  credentialId: Uint8Array, prfSalt: Uint8Array, credentials: CredentialsApi = navigator.credentials,
): Promise<Uint8Array | PrfFailure> {
  let assertion: PublicKeyCredential;
  try {
    assertion = await credentials.get({
      publicKey: {
        challenge: randomBytes(CHALLENGE_BYTES),
        allowCredentials: [{ type: 'public-key', id: copyBytes(credentialId) }],
        userVerification: 'required',
        timeout: TIMEOUT_MS,
        extensions: { prf: { eval: { first: copyBytes(prfSalt) } } },
      },
    }) as PublicKeyCredential;
  } catch (err) {
    return classifyError(err);
  }
  if (!assertion) return 'failed';
  const first = toBytes(readPrf(assertion).results?.first);
  return first || 'unsupported';
}

function classifyError(err: unknown): PrfFailure {
  const name = (err as { name?: string } | undefined)?.name;
  // Отмена, истёк срок или ключ не распознан — одна и та же «не открыли»: ни попыткой PIN, ни ошибкой не считается
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
  if (name === 'NotSupportedError' || name === 'SecurityError') return 'unsupported';
  return 'failed';
}

function readPrf(credential: PublicKeyCredential): PrfResults {
  const results = credential.getClientExtensionResults() as { prf?: PrfResults };
  return results.prf || {};
}

function toBytes(source: BufferSource | undefined) {
  if (!source) return undefined;
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return bytes.length ? new Uint8Array(bytes) : undefined;
}

function copyBytes(bytes: Uint8Array) {
  return new Uint8Array(bytes);
}

function randomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function readUnsupported() {
  try {
    return localStorage.getItem(UNSUPPORTED_KEY) === '1';
  } catch {
    return false;
  }
}

function markUnsupported() {
  try {
    localStorage.setItem(UNSUPPORTED_KEY, '1');
  } catch {
    // Хранилище страницы недоступно — спросим браузер ещё раз в другой раз
  }
}
