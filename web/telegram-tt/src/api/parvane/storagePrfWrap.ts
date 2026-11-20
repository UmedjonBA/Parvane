// Вход по отпечатку в хранилище (spec 041, решение пользователя 20 ноя 2026): секрет, который аутентификатор отдаёт
// по расширению WebAuthn PRF (hmac-secret), заворачивает KEK обёртки PIN. На диске лежит только завёрнутое: без
// аутентификатора (и проверки пользователя на нём) открыть хранилище можно лишь PIN, как раньше.
// Ключ обёртки — HKDF-SHA256(выход PRF, метка с профилем, солью PIN и id ключа аутентификатора), шифр — AES-256-GCM
// с той же меткой в AAD: запись другого профиля, прежнего PIN или другого ключа аутентификатора не открывается
export const PRF_SALT_BYTES = 32;
const IV_BYTES = 12;
const RECORD_VERSION = 1;
const LABEL = 'parvane/store/prf/v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Запись на диске: всё, кроме `sealed`, открыто — это параметры запроса к аутентификатору
export type BiometricRecord = {
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  pinSalt: string;
  sealed: Uint8Array;
};

type BiometricRecordJson = {
  v: number;
  credentialId: string;
  prfSalt: string;
  pinSalt: string;
  sealed: string;
};

export type BiometricBinding = {
  profileId: string;
  pinSalt: string;
  credentialId: Uint8Array;
};

/** Завернуть `secret` секретом аутентификатора: `iv ‖ шифртекст`. */
export async function sealWithPrf(prf: Uint8Array, binding: BiometricBinding, secret: Uint8Array) {
  const label = buildLabel(binding);
  const key = await deriveWrapKey(prf, label);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(iv), additionalData: toBuffer(label) }, key, toBuffer(secret),
  ));
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv);
  out.set(sealed, IV_BYTES);
  return out;
}

/** Развернуть; чужой секрет, другая метка или испорченная запись — `undefined`. */
export async function openWithPrf(prf: Uint8Array, binding: BiometricBinding, sealed: Uint8Array) {
  if (sealed.length <= IV_BYTES) return undefined;
  const label = buildLabel(binding);
  const key = await deriveWrapKey(prf, label);
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(sealed.subarray(0, IV_BYTES)), additionalData: toBuffer(label) }, key,
      toBuffer(sealed.subarray(IV_BYTES)),
    ));
  } catch {
    return undefined;
  }
}

export function encodeBiometricRecord(record: BiometricRecord) {
  return encoder.encode(JSON.stringify({
    v: RECORD_VERSION,
    credentialId: toHex(record.credentialId),
    prfSalt: toHex(record.prfSalt),
    pinSalt: record.pinSalt,
    sealed: toHex(record.sealed),
  } satisfies BiometricRecordJson));
}

export function decodeBiometricRecord(bytes: Uint8Array): BiometricRecord | undefined {
  try {
    const json = JSON.parse(decoder.decode(bytes)) as Partial<BiometricRecordJson>;
    if (json.v !== RECORD_VERSION || !json.credentialId || !json.prfSalt || !json.pinSalt || !json.sealed) {
      return undefined;
    }
    return {
      credentialId: fromHex(json.credentialId),
      prfSalt: fromHex(json.prfSalt),
      pinSalt: json.pinSalt,
      sealed: fromHex(json.sealed),
    };
  } catch {
    return undefined;
  }
}

async function deriveWrapKey(prf: Uint8Array, label: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', toBuffer(prf), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: toBuffer(label),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function buildLabel({ profileId, pinSalt, credentialId }: BiometricBinding) {
  return encoder.encode(`${LABEL}\0${profileId}\0${pinSalt}\0${toHex(credentialId)}`);
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string) {
  if (text.length % 2 || /[^0-9a-f]/i.test(text)) throw new Error('bad hex');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
