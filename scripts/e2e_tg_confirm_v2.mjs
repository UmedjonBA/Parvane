// «Бот» подтверждения Telegram по протоколу v2 (метод канала PRE
// `identity.account.confirm_telegram`) — для сценариев, играющих роль бота.
// Минимальный protobuf-кодек без зависимостей; номера полей — из
// proto/parvane/core/v2/frame.proto и identity/v2/identity.proto. Зеркало
// кодека в backend/infra/telegram-bot/parvane_tg_bot.py.
const PROTO_MAJOR = 2;
const PROTO_MINOR = 0;
const CHANNEL_IDENTIFIED = 1;
const METHOD = 'identity.account.confirm_telegram';
const ERROR_TEXT = {
  1: 'неверный запрос', 2: 'Telegram уже привязан к другому аккаунту или неверный секрет',
  3: 'ссылка подтверждения не найдена или устарела', 4: 'уже подтверждено',
  5: 'слишком много попыток, попробуйте позже', 6: 'сервер требует обновления бота',
  11: 'сервер временно недоступен', 12: 'ссылка подтверждения устарела',
};

function varint(n) {
  const out = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) out.push(b | 0x80); else { out.push(b); return out; }
  }
}
const cat = (...parts) => Uint8Array.from(parts.flat());
const fVarint = (num, value) => cat(varint((num << 3) | 0), varint(value));
const fBytes = (num, bytes) => cat(varint((num << 3) | 2), varint(bytes.length), [...bytes]);
const fStr = (num, s) => fBytes(num, new TextEncoder().encode(s));

function readVarint(buf, i) {
  let shift = 0n; let n = 0n;
  for (;;) {
    const b = buf[i++];
    n |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [n, i];
    shift += 7n;
    if (shift > 63n) throw new Error('varint');
  }
}
function fields(buf) {
  const out = new Map();
  let i = 0;
  while (i < buf.length) {
    let key; [key, i] = readVarint(buf, i);
    const num = Number(key >> 3n); const wt = Number(key & 7n);
    let v;
    if (wt === 0) [v, i] = readVarint(buf, i);
    else if (wt === 2) { let ln; [ln, i] = readVarint(buf, i); v = buf.subarray(i, i + Number(ln)); i += Number(ln); }
    else if (wt === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else if (wt === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else throw new Error('wire type');
    if (!out.has(num)) out.set(num, []);
    out.get(num).push(v);
  }
  return out;
}
const first = (f, num) => f.get(num)?.[0];

export function helloFrame() {
  const client = cat([...fStr(1, 'e2e-bot')], [...fStr(2, '1')]);
  const hello = cat([...fVarint(1, PROTO_MINOR)], [...fBytes(3, client)], [...fVarint(4, CHANNEL_IDENTIFIED)]);
  return cat([...fVarint(1, PROTO_MAJOR)], [...fBytes(10, hello)]);
}
export function requestFrame(id, method, body, timeoutMs) {
  const request = cat([...fVarint(1, id)], [...fStr(2, method)], [...fBytes(3, body)], [...fVarint(4, timeoutMs)]);
  return cat([...fVarint(1, PROTO_MAJOR)], [...fBytes(20, request)]);
}
/** Frame{response} с нужным id → { ok: Uint8Array } | { code } ; undefined — другой кадр */
export function parseResponse(frame, id) {
  const response = first(fields(frame), 21);
  if (!response) return undefined;
  const r = fields(response);
  if (Number(first(r, 1) ?? 0n) !== id) return undefined;
  if (r.has(2)) return { ok: first(r, 2) };
  const err = fields(first(r, 3) ?? new Uint8Array());
  return { code: Number(first(err, 1) ?? 0n) };
}

/** Один запрос подтверждения через gateway v2; результат в виде прежнего v1-ответа бота. */
export async function botConfirmV2(gatewayUrl, secret, token, telegramId, telegramName = `tg${telegramId}`) {
  const ws = new WebSocket(gatewayUrl);
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('gateway ws error')), { once: true });
  });
  const frames = [];
  let wake;
  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data));
    wake?.();
  });
  const next = async () => {
    const deadline = Date.now() + 10000;
    while (!frames.length) {
      if (Date.now() > deadline) throw new Error('gateway v2: нет ответа');
      await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 200); });
    }
    return frames.shift();
  };
  try {
    ws.send(helloFrame());
    const welcome = await next();
    if (!fields(welcome).has(11)) return { ok: false, error: 'gateway не ответил Welcome v2' };
    const body = cat(
      [...fStr(1, secret)], [...fStr(2, token)], [...fVarint(3, telegramId)], [...fStr(4, telegramName)],
    );
    ws.send(requestFrame(1, METHOD, body, 5000));
    for (;;) {
      const parsed = parseResponse(await next(), 1);
      if (!parsed) continue;
      if (parsed.ok) {
        const f = fields(parsed.ok);
        const dec = new TextDecoder();
        const user = f.has(1) ? dec.decode(first(f, 1)) : '';
        const action = f.has(2) ? dec.decode(first(f, 2)) : '';
        return { ok: true, user, kind: action || 'register' };
      }
      return { ok: false, code: parsed.code, error: ERROR_TEXT[parsed.code] || `ошибка сервера (код ${parsed.code})` };
    }
  } finally {
    ws.close();
  }
}

/** Один запрос метода v2 на соединении БЕЗ Auth (канал PRE): { ok } | { code }. */
export async function v2RequestWithoutAuth(gatewayUrl, method, body, timeoutMs = 5000) {
  const ws = new WebSocket(gatewayUrl);
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('gateway ws error')), { once: true });
  });
  const frames = [];
  let wake;
  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data));
    wake?.();
  });
  const next = async () => {
    const deadline = Date.now() + timeoutMs + 5000;
    while (!frames.length) {
      if (Date.now() > deadline) throw new Error(`gateway v2: нет ответа на ${method}`);
      await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 200); });
    }
    return frames.shift();
  };
  try {
    ws.send(helloFrame());
    const welcome = await next();
    if (!fields(welcome).has(11)) throw new Error('gateway не ответил Welcome v2');
    ws.send(requestFrame(1, method, body, timeoutMs));
    for (;;) {
      const parsed = parseResponse(await next(), 1);
      if (parsed) return parsed;
    }
  } finally {
    ws.close();
  }
}

// ── Ключ восстановления через бота (spec 015) ───────────────────────────────

/** «Бот» забирает сообщения для владельцев (`identity.telegram.pull`): массив
 * `{ id, telegramId, kind, user, recoveryKey, client }`; `acks` — уже доставленные. */
export async function botPullV2(gatewayUrl, secret, acks = [], waitMs = 0) {
  const body = cat([...fStr(1, secret)], ...acks.map((id) => [...fVarint(2, id)]), [...fVarint(3, waitMs)]);
  const parsed = await v2RequestWithoutAuth(gatewayUrl, 'identity.telegram.pull', body, waitMs + 3000);
  if (!parsed.ok) throw new Error(`identity.telegram.pull: код ${parsed.code}`);
  const dec = new TextDecoder();
  const text = (f, num) => (f.has(num) ? dec.decode(first(f, num)) : '');
  return (fields(parsed.ok).get(1) || []).map((raw) => {
    const f = fields(raw);
    return {
      id: Number(first(f, 1) ?? 0n),
      telegramId: Number(first(f, 2) ?? 0n),
      kind: text(f, 3),
      user: text(f, 4),
      recoveryKey: text(f, 5),
      client: text(f, 6),
    };
  });
}

/** «Бот» передаёт ответ владельца (`identity.telegram.reply`): `{ result, user }` | `{ code }`. */
export async function botReplyV2(gatewayUrl, secret, telegramId, text) {
  const body = cat([...fStr(1, secret)], [...fVarint(2, telegramId)], [...fStr(3, text)]);
  const parsed = await v2RequestWithoutAuth(gatewayUrl, 'identity.telegram.reply', body);
  if (!parsed.ok) return { code: parsed.code };
  const f = fields(parsed.ok);
  const dec = new TextDecoder();
  return {
    result: f.has(1) ? dec.decode(first(f, 1)) : '',
    user: f.has(2) ? dec.decode(first(f, 2)) : '',
  };
}
