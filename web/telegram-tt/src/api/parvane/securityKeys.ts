import { base64ToBytes, bytesToBase64 } from './v2/base64';

// Ключ безопасности — второй фактор входа на сервере (правило SECKEY-1, доска `ZdProfileX` «Ключ безопасности»).
// Ключ USB/NFC (WebAuthn) заводится на устройстве журнала со свежим паролем; вход паролем НОВОГО устройства на
// аккаунт с ключом получает вызов сервера (`identity.session.issue` → `seckey_required`) и повторяется с подписью
// ключа. Проверяет подпись, источник и счётчик сервер (identity `webauthn.rs`); клиент только зовёт браузер.
// Отличие от входа по отпечатку (`storageWebAuthn.ts`): тот открывает хранилище этого устройства, сервер о нём не знает

/** Шаг входа «вставьте ключ безопасности» из ответа выдачи токена. */
export type SecurityKeyStep = {
  challenge: Uint8Array;
  ids: Uint8Array[];
  rpId: string;
  isRejected: boolean;
  isRecoveryWrong: boolean;
  hasRecovery: boolean;
};

/** Второй фактор для повторной выдачи токена: ответ ключа (base64, как в proto3-JSON) либо ключ восстановления. */
export type SecondFactor = {
  seckey?: { credential_id: string; client_data_json: string; authenticator_data: string; signature: string };
  recoveryKey?: string;
};

export type SecurityKeyFailure = 'unsupported' | 'cancelled' | 'failed';

/** Ключ аккаунта в настройках. */
export type SecurityKeyInfo = { id: string; name: string; createdMs: number; lastUsedMs: number };

export class SecurityKeyRequiredError extends Error {
  constructor(public step: SecurityKeyStep) {
    super('нужен ключ безопасности');
    this.name = 'SecurityKeyRequiredError';
  }
}

type CredentialsApi = Pick<CredentialsContainer, 'create' | 'get'>;
type Json = Record<string, unknown>;

const TIMEOUT_MS = 120_000;
const RP_NAME = 'Parvane';
// ES256 и EdDSA — алгоритмы, которые проверяет сервер
const ALGORITHMS = [-7, -8];
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;

/** Браузер умеет WebAuthn, а адрес страницы годится для ключа (не IP). */
export function checkSecurityKeySupported() {
  if (typeof window === 'undefined' || !window.isSecureContext || !window.PublicKeyCredential) return false;
  return Boolean(navigator.credentials) && !IP_HOST.test(window.location.hostname);
}

function readField(o: Json, ...keys: string[]) {
  for (const key of keys) {
    if (o[key] !== undefined) return o[key];
  }
  return undefined;
}

function readString(o: Json, ...keys: string[]) {
  const value = readField(o, ...keys);
  return typeof value === 'string' ? value : '';
}

function readBytes(o: Json, ...keys: string[]) {
  const value = readField(o, ...keys);
  return typeof value === 'string' && value ? base64ToBytes(value) : new Uint8Array(0);
}

function readBytesList(o: Json, ...keys: string[]) {
  const value = readField(o, ...keys);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map(base64ToBytes) : [];
}

/** Шаг ключа из ответа выдачи токена (поля proto3-JSON либо прежней формы моста); нет шага — `undefined`. */
export function parseSecurityKeyStep(response: Json): SecurityKeyStep | undefined {
  if (!readField(response, 'seckeyRequired', 'seckey_required')) return undefined;
  return {
    challenge: readBytes(response, 'seckeyChallenge', 'seckey_challenge'),
    ids: readBytesList(response, 'seckeyIds', 'seckey_ids'),
    rpId: readString(response, 'seckeyRpId', 'seckey_rp_id'),
    isRejected: Boolean(readField(response, 'seckeyRejected', 'seckey_rejected')),
    isRecoveryWrong: Boolean(readField(response, 'recoveryKeyWrong', 'recovery_key_wrong')),
    hasRecovery: Boolean(readField(response, 'seckeyRecovery', 'seckey_recovery')),
  };
}

/** Поля шага для ответа моста прежней формы (`identity.token.issue`). */
export function formatSecurityKeyStep(response: Json): Json {
  return {
    ok: false,
    seckey_required: true,
    seckey_challenge: readField(response, 'seckeyChallenge', 'seckey_challenge') || '',
    seckey_ids: readField(response, 'seckeyIds', 'seckey_ids') || [],
    seckey_rp_id: readField(response, 'seckeyRpId', 'seckey_rp_id') || '',
    seckey_rejected: Boolean(readField(response, 'seckeyRejected', 'seckey_rejected')),
    recovery_key_wrong: Boolean(readField(response, 'recoveryKeyWrong', 'recovery_key_wrong')),
    seckey_recovery: Boolean(readField(response, 'seckeyRecovery', 'seckey_recovery')),
  };
}

/** Тело запроса выдачи токена со вторым фактором. */
export function buildSecondFactorRequest(factor: SecondFactor | undefined): Json {
  if (!factor) return {};
  if (factor.recoveryKey) return { recovery_key: factor.recoveryKey };
  return factor.seckey ? { seckey: factor.seckey } : {};
}

/** Ключи аккаунта из ответа `identity.seckey.list`. */
export function parseSecurityKeyList(response: Json) {
  const keys = readField(response, 'keys');
  const list = Array.isArray(keys) ? keys as Json[] : [];
  return {
    keys: list.map((key): SecurityKeyInfo => ({
      id: readString(key, 'credentialId', 'credential_id'),
      name: readString(key, 'name'),
      createdMs: Number(readField(key, 'createdMs', 'created_ms') || 0),
      lastUsedMs: Number(readField(key, 'lastUsedMs', 'last_used_ms') || 0),
    })),
    isRequired: Boolean(readField(response, 'required')),
    isRecoveryReady: Boolean(readField(response, 'recoveryReady', 'recovery_ready')),
  };
}

function toArrayBuffer(bytes: Uint8Array) {
  return new Uint8Array(bytes).buffer;
}

function toBase64(buffer: ArrayBuffer) {
  return bytesToBase64(new Uint8Array(buffer));
}

function classifyError(err: unknown): SecurityKeyFailure {
  const name = (err as { name?: string } | undefined)?.name;
  // Отмена, истёк срок, ключ не тот — «не подтвердили»; заведённый ключ повторно — тоже отказ браузера
  if (name === 'NotAllowedError' || name === 'AbortError' || name === 'InvalidStateError') return 'cancelled';
  if (name === 'NotSupportedError' || name === 'SecurityError') return 'unsupported';
  return 'failed';
}

/** Подпись вызова входа ключом безопасности (`navigator.credentials.get`). */
export async function signSecurityKeyStep(
  step: SecurityKeyStep, credentials: CredentialsApi = navigator.credentials,
): Promise<SecondFactor | SecurityKeyFailure> {
  let assertion: PublicKeyCredential;
  try {
    assertion = await credentials.get({
      publicKey: {
        challenge: toArrayBuffer(step.challenge),
        rpId: step.rpId || undefined,
        allowCredentials: step.ids.map((id) => ({ type: 'public-key', id: toArrayBuffer(id) })),
        userVerification: 'discouraged',
        timeout: TIMEOUT_MS,
      },
    }) as PublicKeyCredential;
  } catch (err) {
    return classifyError(err);
  }
  if (!assertion) return 'failed';
  const response = assertion.response as AuthenticatorAssertionResponse;
  return {
    seckey: {
      credential_id: toBase64(assertion.rawId),
      client_data_json: toBase64(response.clientDataJSON),
      authenticator_data: toBase64(response.authenticatorData),
      signature: toBase64(response.signature),
    },
  };
}

/** Новый ключ безопасности на вызов сервера (`identity.seckey.challenge`) → тело `identity.seckey.add`. */
export async function createSecurityKey(
  challengeResponse: Json, userName: string, name: string, credentials: CredentialsApi = navigator.credentials,
): Promise<Json | SecurityKeyFailure> {
  const rpId = readString(challengeResponse, 'rpId', 'rp_id');
  let created: PublicKeyCredential;
  try {
    created = await credentials.create({
      publicKey: {
        rp: { name: RP_NAME, id: rpId || undefined },
        user: {
          id: toArrayBuffer(readBytes(challengeResponse, 'userHandle', 'user_handle')),
          name: userName,
          displayName: userName,
        },
        challenge: toArrayBuffer(readBytes(challengeResponse, 'challenge')),
        pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
        excludeCredentials: readBytesList(challengeResponse, 'excludeIds', 'exclude_ids')
          .map((id) => ({ type: 'public-key', id: toArrayBuffer(id) })),
        authenticatorSelection: { userVerification: 'discouraged', residentKey: 'discouraged' },
        attestation: 'none',
        timeout: TIMEOUT_MS,
      },
    }) as PublicKeyCredential;
  } catch (err) {
    return classifyError(err);
  }
  if (!created) return 'failed';
  const response = created.response as AuthenticatorAttestationResponse;
  if (typeof response.getAuthenticatorData !== 'function') return 'unsupported';
  return {
    name,
    client_data_json: toBase64(response.clientDataJSON),
    authenticator_data: toBase64(response.getAuthenticatorData()),
  };
}
