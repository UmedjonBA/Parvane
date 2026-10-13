// base64 ↔ байты частями (perf A7): посимвольная склейка строки на мегабайтных
// блобах стоила секунд главного потока; `String.fromCharCode` принимает до
// нескольких десятков тысяч аргументов — идём окнами по 32 КиБ.

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
