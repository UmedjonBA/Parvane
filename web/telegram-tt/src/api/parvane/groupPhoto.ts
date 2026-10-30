// Фото частной группы v2 (A0089-5, правило GPHOTO-1): блоб шифруется как вложение чата (PVB2 + секрет
// скачивания), а в журнал группы (`SetInfo.avatar_key`) кладётся ОДИН 32-байтный секрет, из которого все
// клиенты одинаково выводят ключ PVB2, nonce и capability. Сервер видит шифртекст и хэш capability.
// Вектор проверки (общий с desktop и android): conformance/README.md, правило GPHOTO-1.

const DOMAIN = 'parvane/group-avatar/v1/';

export const GROUP_PHOTO_SECRET_LEN = 32;

export type GroupPhotoKeys = { capability: Uint8Array; key: Uint8Array; nonce: Uint8Array };

async function derive(label: string, secret: Uint8Array): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode(DOMAIN + label);
  const input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix, 0);
  input.set(secret, prefix.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

export async function deriveGroupPhotoKeys(secret: Uint8Array): Promise<GroupPhotoKeys> {
  if (secret.length !== GROUP_PHOTO_SECRET_LEN) throw new Error('секрет фото группы: нужно 32 байта');
  const [capability, key, nonce] = await Promise.all([
    derive('cap', secret), derive('key', secret), derive('nonce', secret),
  ]);
  return { capability, key, nonce: nonce.slice(0, 12) };
}

export function newGroupPhotoSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(GROUP_PHOTO_SECRET_LEN));
}
