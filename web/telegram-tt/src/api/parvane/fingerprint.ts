// Отпечаток ключа: SHA-256 от base64 identity-ключа, 12 групп по 4 hex-символа
// (48 символов), как safety number — сверяется вслух/по другому каналу
export async function fingerprintOf(key: string): Promise<string> {
  if (!key) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return (hex.slice(0, 48).match(/.{4}/g) || []).join(' ');
}
