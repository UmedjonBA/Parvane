// Parvane (spec 022): мини-кодек кадров протокола v2 для публичной страницы
// ссылки. Страница лёгкая — без движка (WASM): ей нужны только Hello анонимного
// канала, Request и разбор Welcome / Response / StreamChunk / Ping. Схема —
// `proto/parvane/core/v2/frame.proto`; protobuf собран вручную (varint и поля
// с длиной), значения по умолчанию не пишутся — как у движка, с которым кодек
// сверяет тест `frames.test.ts` (байты запросов и разбор ответов).

export const PROTO_MAJOR = 2;
export const CHANNEL_ANONYMOUS = 2;
/** Кадр целиком не больше 4 МиБ — проверяется до разбора. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

// Frame
const FRAME_PROTO_MAJOR = 1;
const FRAME_HELLO = 10;
const FRAME_WELCOME = 11;
const FRAME_REQUEST = 20;
const FRAME_RESPONSE = 21;
const FRAME_STREAM_CHUNK = 23;
const FRAME_PING = 30;
const FRAME_PONG = 31;

// Коды ошибок (`errors.proto`) — имена, как их отдаёт движок
const ERROR_NAMES = [
  'ERROR_CODE_UNSPECIFIED', 'ERROR_CODE_INVALID', 'ERROR_CODE_FORBIDDEN', 'ERROR_CODE_NOT_FOUND',
  'ERROR_CODE_DUPLICATE', 'ERROR_CODE_RATE_LIMITED', 'ERROR_CODE_UPGRADE_REQUIRED', 'ERROR_CODE_REVOKED',
  'ERROR_CODE_REAUTH_REQUIRED', 'ERROR_CODE_LIMIT', 'ERROR_CODE_FEDERATION_UNAVAILABLE', 'ERROR_CODE_UNAVAILABLE',
  'ERROR_CODE_EXPIRED', 'ERROR_CODE_BANNED',
];

export type ServerFrame =
  | { kind: 'welcome'; features: string[]; serverDescriptor: Uint8Array }
  | { kind: 'response'; id: number; ok?: Uint8Array; error?: string; retryAfterMs: number }
  | {
    kind: 'chunk'; id: number; index: number; last: boolean; data: Uint8Array; error?: string; retryAfterMs: number;
  }
  | { kind: 'ping'; nonce: number }
  | { kind: 'unknown' };

export class FrameError extends Error {}

// ── запись ───────────────────────────────────────────────────────────────────

export function concatBytes(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** Беззнаковый varint; числа — до 2^53 (ид запросов, размеры, времена). */
export function varint(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new FrameError('varint: bad value');
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return Uint8Array.from(out);
}

function tag(field: number, wire: number) {
  return varint(field * 8 + wire);
}

/** Поле-число; ноль не пишется (значение по умолчанию proto3). */
export function fieldVarint(field: number, value: number) {
  return value ? concatBytes([tag(field, WIRE_VARINT), varint(value)]) : new Uint8Array(0);
}

/** Поле с длиной (bytes, string, вложенное сообщение); пустое не пишется, если не `isForced`. */
export function fieldBytes(field: number, value: Uint8Array, isForced = false) {
  if (!value.length && !isForced) return new Uint8Array(0);
  return concatBytes([tag(field, WIRE_LEN), varint(value.length), value]);
}

export function fieldString(field: number, value: string) {
  return fieldBytes(field, new TextEncoder().encode(value));
}

function frame(field: number, body: Uint8Array) {
  // Поле oneof пишется всегда, даже пустым сообщением
  return concatBytes([fieldVarint(FRAME_PROTO_MAJOR, PROTO_MAJOR), fieldBytes(field, body, true)]);
}

/** Первый кадр клиента: `Hello{client{kind, version}, channel}` (`proto_minor = 0`). */
export function encodeHello(channel: number, clientKind: string, clientVersion: string) {
  const client = concatBytes([fieldString(1, clientKind), fieldString(2, clientVersion)]);
  return frame(FRAME_HELLO, concatBytes([fieldBytes(3, client, true), fieldVarint(4, channel)]));
}

/** `Request{id, method, body, timeout_ms}`. */
export function encodeRequest(id: number, method: string, body: Uint8Array, timeoutMs: number) {
  return frame(FRAME_REQUEST, concatBytes([
    fieldVarint(1, id), fieldString(2, method), fieldBytes(3, body), fieldVarint(4, timeoutMs),
  ]));
}

export function encodePong(nonce: number) {
  return frame(FRAME_PONG, fieldVarint(1, nonce));
}

// ── чтение ───────────────────────────────────────────────────────────────────

export type ProtoField = { field: number; value: number | Uint8Array };

/** Поля сообщения по порядку: varint — число, поле с длиной — байты; fixed32/64 пропускаются. */
export function readFields(bytes: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let pos = 0;
  const readVarint = () => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= bytes.length) throw new FrameError('proto: truncated varint');
      const byte = bytes[pos++];
      value += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return value;
      scale *= 0x80;
    }
    throw new FrameError('proto: varint too long');
  };
  while (pos < bytes.length) {
    const key = readVarint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (!field) throw new FrameError('proto: field 0');
    if (wire === WIRE_VARINT) {
      out.push({ field, value: readVarint() });
    } else if (wire === WIRE_LEN) {
      const length = readVarint();
      if (pos + length > bytes.length) throw new FrameError('proto: truncated field');
      out.push({ field, value: bytes.subarray(pos, pos + length) });
      pos += length;
    } else if (wire === WIRE_FIXED64 || wire === WIRE_FIXED32) {
      pos += wire === WIRE_FIXED64 ? 8 : 4;
      if (pos > bytes.length) throw new FrameError('proto: truncated fixed');
    } else {
      throw new FrameError('proto: wire type');
    }
  }
  return out;
}

/** Последнее значение поля-числа (0 — поля нет). */
export function numberOf(fields: ProtoField[], field: number) {
  let found = 0;
  fields.forEach((f) => {
    if (f.field === field && typeof f.value === 'number') found = f.value;
  });
  return found;
}

/** Последнее значение поля с длиной (undefined — поля нет). */
export function bytesOf(fields: ProtoField[], field: number): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  fields.forEach((f) => {
    if (f.field === field && typeof f.value !== 'number') found = f.value;
  });
  return found;
}

function readError(bytes: Uint8Array) {
  const fields = readFields(bytes);
  return {
    error: ERROR_NAMES[numberOf(fields, 1)] || ERROR_NAMES[0],
    retryAfterMs: numberOf(fields, 2),
  };
}

/** Разобрать кадр сервера. Негодный кадр — исключение `FrameError`. */
export function decodeFrame(bytes: Uint8Array): ServerFrame {
  if (bytes.length > MAX_FRAME_BYTES) throw new FrameError('frame: too large');
  const top = readFields(bytes);
  if (numberOf(top, FRAME_PROTO_MAJOR) !== PROTO_MAJOR) throw new FrameError('frame: major');
  const welcome = bytesOf(top, FRAME_WELCOME);
  if (welcome) {
    const fields = readFields(welcome);
    const decoder = new TextDecoder();
    return {
      kind: 'welcome',
      features: fields.filter((f) => f.field === 4 && typeof f.value !== 'number')
        .map((f) => decoder.decode(f.value as Uint8Array)),
      serverDescriptor: bytesOf(fields, 5) || new Uint8Array(0),
    };
  }
  const response = bytesOf(top, FRAME_RESPONSE);
  if (response) {
    const fields = readFields(response);
    const id = numberOf(fields, 1);
    const failure = bytesOf(fields, 3);
    if (failure) return { kind: 'response', id, ...readError(failure) };
    const ok = bytesOf(fields, 2);
    // Ни результата, ни ошибки — как у движка, ошибка без кода
    if (!ok) return { kind: 'response', id, error: ERROR_NAMES[0], retryAfterMs: 0 };
    return {
      kind: 'response', id, ok, retryAfterMs: 0,
    };
  }
  const chunk = bytesOf(top, FRAME_STREAM_CHUNK);
  if (chunk) {
    const fields = readFields(chunk);
    const failure = bytesOf(fields, 5);
    return {
      kind: 'chunk',
      id: numberOf(fields, 1),
      index: numberOf(fields, 2),
      last: numberOf(fields, 3) !== 0,
      data: bytesOf(fields, 4) || new Uint8Array(0),
      retryAfterMs: 0,
      ...(failure ? readError(failure) : undefined),
    };
  }
  const ping = bytesOf(top, FRAME_PING);
  if (ping) return { kind: 'ping', nonce: numberOf(readFields(ping), 1) };
  return { kind: 'unknown' };
}
