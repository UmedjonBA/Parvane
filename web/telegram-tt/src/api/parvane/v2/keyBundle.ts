// Копия ключей аккаунта под ключом восстановления (spec 015). Лежит на сервере
// рядом с копией корня (`RootBackupSet.key_bundle`) и несёт то же, что получает
// устройство при привязке с другого устройства: материал гранта движка (ключ
// подписи устройств, журнал, ключ доставки, ключ личного состояния), ключи
// планировщика и указатель на снимок истории. По ней новое устройство входит в
// журнал устройств с одним ключом восстановления, а прежние устройства остаются.
//
// Формат: "PVKB" ‖ версия (1) ‖ nonce (12) ‖ AES-256-GCM(JSON),
// ключ = HKDF-SHA256(ikm = ключ восстановления в каноничной записи без «-»,
// salt = "parvane/v2/key-bundle", info = адрес), AAD = "PVKB" ‖ версия ‖ адрес.
// Ключ копии устройство хранит у себя (сам ключ восстановления — нет) и передаёт
// привязанным устройствам, чтобы любое из них могло обновить копию.

const MAGIC = [0x50, 0x56, 0x4b, 0x42];
const VERSION = 1;
const NONCE_LEN = 12;
const HEADER_LEN = MAGIC.length + 1;
const KEY_CHARS = 40;
const SALT = 'parvane/v2/key-bundle';

export type KeyBundleHistory = {
  fileId: string;
  fileKey: string;
  fileNonce: string;
  // Время снимка, мс: новое устройство перечитывает копию и берёт снимок свежее
  at: number;
  // Отпечаток содержимого: устройство не перезаливает неизменившуюся историю
  mark: string;
  // Размер снимка, байт: небольшую историю обновляем чаще
  size?: number;
};

export type KeyBundlePayload = {
  // Материал гранта движка (`linkGrantMaterial`), base64
  grant: string;
  // Ключи контейнера планировщика (`plannerKeysExport`)
  planner?: string;
  history?: KeyBundleHistory;
};

const encoder = new TextEncoder();

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Ключ восстановления без оформления: регистр, пробелы и «-» не важны, O→0, I/L→1
 * (как разбор движка). undefined — это не ключ восстановления. */
export function canonicalRecoveryKey(text: string): string | undefined {
  const compact = text.toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return compact.length === KEY_CHARS && !compact.includes('U') ? compact : undefined;
}

// Десять групп по четыре знака (между группами — до трёх любых знаков) либо
// сорок знаков подряд; по краям — не латиница и не цифра
const KEY_IN_TEXT = /(?<![0-9A-Z])[0-9A-Z]{4}(?:[^0-9A-Z]{0,3}[0-9A-Z]{4}){9}(?![0-9A-Z])/g;
const KEY_GROUP = /.{4}/g;

/** Ключ восстановления из того, что ввёл человек: ключ часто вставляют вместе с
 * куском окружающего текста (диалог приложения, сообщение бота) или с длинным
 * тире вместо дефиса — движок такой ввод отклоняет. Возвращает ключ в записи
 * `XXXX-XXXX-…`; ничего похожего нет — исходный текст (движок отклонит его сам). */
export function pickRecoveryKey(text: string): string {
  const found = text.toUpperCase().match(KEY_IN_TEXT);
  const canonical = found?.map((match) => canonicalRecoveryKey(match)).find(Boolean);
  return canonical ? canonical.match(KEY_GROUP)!.join('-') : text.trim();
}

/** Ключ копии ключей аккаунта из ключа восстановления (32 байта). */
export async function deriveBundleKey(recoveryKey: string, address: string): Promise<Uint8Array | undefined> {
  const canonical = canonicalRecoveryKey(recoveryKey);
  if (!canonical) return undefined;
  const material = await crypto.subtle.importKey('raw', toBuffer(encoder.encode(canonical)), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: toBuffer(encoder.encode(SALT)), info: toBuffer(encoder.encode(address)),
  }, material, 256);
  return new Uint8Array(bits);
}

function buildAad(address: string) {
  return toBuffer(new Uint8Array([...MAGIC, VERSION, ...encoder.encode(address)]));
}

function importAesKey(bundleKey: Uint8Array) {
  return crypto.subtle.importKey('raw', toBuffer(bundleKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealKeyBundle(
  bundleKey: Uint8Array, address: string, payload: KeyBundlePayload,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: buildAad(address) },
    await importAesKey(bundleKey),
    toBuffer(encoder.encode(JSON.stringify(payload))),
  ));
  const out = new Uint8Array(HEADER_LEN + NONCE_LEN + sealed.length);
  out.set([...MAGIC, VERSION]);
  out.set(nonce, HEADER_LEN);
  out.set(sealed, HEADER_LEN + NONCE_LEN);
  return out;
}

/** Открыть копию; undefined — чужой ключ, чужой адрес или испорченные байты. */
export async function openKeyBundle(
  bundleKey: Uint8Array, address: string, bytes: Uint8Array,
): Promise<KeyBundlePayload | undefined> {
  if (bytes.length <= HEADER_LEN + NONCE_LEN) return undefined;
  if (MAGIC.some((byte, index) => bytes[index] !== byte) || bytes[MAGIC.length] !== VERSION) return undefined;
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toBuffer(bytes.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN)),
        additionalData: buildAad(address),
      },
      await importAesKey(bundleKey),
      toBuffer(bytes.subarray(HEADER_LEN + NONCE_LEN)),
    );
    const payload = JSON.parse(new TextDecoder().decode(opened)) as Partial<KeyBundlePayload>;
    if (typeof payload.grant !== 'string' || !payload.grant) return undefined;
    return {
      grant: payload.grant,
      planner: typeof payload.planner === 'string' ? payload.planner : undefined,
      history: isHistory(payload.history) ? payload.history : undefined,
    };
  } catch {
    return undefined;
  }
}

function isHistory(value: unknown): value is KeyBundleHistory {
  if (!value || typeof value !== 'object') return false;
  const history = value as Partial<KeyBundleHistory>;
  return typeof history.fileId === 'string' && typeof history.fileKey === 'string'
    && typeof history.fileNonce === 'string' && typeof history.at === 'number' && typeof history.mark === 'string';
}

/** Журнал устройств в материале гранта заменяется свежим ответом сервера
 * (`identity.device.log_sync` с версии 0): копия могла быть записана до того,
 * как в журнале появились новые записи. Подлинность журнала проверит движок —
 * ключ подписи устройств из копии обязан совпасть с ключом в журнале. */
export function withFreshLog(grant: Uint8Array, logResponse: Uint8Array): Uint8Array {
  const material = JSON.parse(new TextDecoder().decode(grant)) as Record<string, unknown>;
  material.log = Array.from(logResponse, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return encoder.encode(JSON.stringify(material));
}

/** Ключ копии ключей аккаунта — в материал гранта (поле `bk`): привязанное
 * устройство тоже сможет обновлять копию. Движок незнакомое поле пропускает. */
export function withBundleKey(grant: Uint8Array, bundleKeyB64: string): Uint8Array {
  const material = JSON.parse(new TextDecoder().decode(grant)) as Record<string, unknown>;
  material.bk = bundleKeyB64;
  return encoder.encode(JSON.stringify(material));
}

export function readGrantBundleKey(grant: Uint8Array): string | undefined {
  try {
    const { bk } = JSON.parse(new TextDecoder().decode(grant)) as { bk?: unknown };
    return typeof bk === 'string' && bk ? bk : undefined;
  } catch {
    return undefined;
  }
}

/** SHA-256 текста в hex. */
export async function digestHex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBuffer(encoder.encode(text)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Отпечаток содержимого копии: неизменившуюся копию на сервер не шлём. */
export function buildBundleMark(payload: KeyBundlePayload): Promise<string> {
  return digestHex(JSON.stringify(payload));
}
