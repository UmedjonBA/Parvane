// Лимит частоты на gateway (протокол v2): соединение без входа, флуд
// `server.describe` (класс RATE_CLASS_PRE: burst 20, 1/с по умолчанию) →
// после всплеска ответы с ERROR_CODE_RATE_LIMITED; обычный темп проходит.
// Без браузера, кадры v2 — кодеком из e2e_tg_confirm_v2.mjs.
import assert from 'node:assert/strict';

import { helloFrame, parseResponse, requestFrame } from './e2e_tg_confirm_v2.mjs';

const ERROR_CODE_RATE_LIMITED = 5;
const METHOD = 'server.describe';
const FLOOD = 60;
const CALM_REQUESTS = 3;
const CALM_PAUSE_MS = 1200;

const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
assert(gatewayUrl, 'PARVANE_E2E_GATEWAY_URL is required');

const ws = new WebSocket(gatewayUrl);
ws.binaryType = 'arraybuffer';
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('gateway ws error')), { once: true });
});

// Ответы по id запроса: { ok } | { code }
const answers = new Map();
let welcomed = false;
let wake;
ws.addEventListener('message', (event) => {
  if (!(event.data instanceof ArrayBuffer)) return;
  const frame = new Uint8Array(event.data);
  for (const id of answers.keys()) {
    if (answers.get(id) !== undefined) continue;
    const parsed = parseResponse(frame, id);
    if (parsed) { answers.set(id, parsed); break; }
  }
  if (!welcomed && !answers.size) welcomed = true;
  wake?.();
});

async function waitFor(check, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 100); });
  }
}

ws.send(helloFrame());
await waitFor(() => welcomed, 'Welcome v2');

let nextId = 1;
function send() {
  const id = nextId++;
  answers.set(id, undefined);
  ws.send(requestFrame(id, METHOD, new Uint8Array(), 5000));
  return id;
}

// Всплеск: лимит считается на соединение до разбора тела
const floodIds = Array.from({ length: FLOOD }, send);
await waitFor(() => floodIds.every((id) => answers.get(id) !== undefined), 'ответы на всплеск');
const limited = floodIds.filter((id) => answers.get(id).code === ERROR_CODE_RATE_LIMITED).length;
const passed = floodIds.filter((id) => answers.get(id).ok).length;
const other = FLOOD - limited - passed;
assert(limited > 0, 'флуд не ограничен: ни одного RATE_LIMITED');
assert(passed > 0, 'все запросы отклонены — лимит слишком жёсткий');
assert.equal(other, 0, `прочих ошибок ${other}`);
console.log(`OK: из ${FLOOD} запросов ${METHOD} отклонено ${limited} (RATE_LIMITED), прошло ${passed}`);

// Обычный темп: ведро пополняется, запросы с паузой проходят
for (let i = 0; i < CALM_REQUESTS; i++) {
  await new Promise((resolve) => { setTimeout(resolve, CALM_PAUSE_MS); });
  const id = send();
  await waitFor(() => answers.get(id) !== undefined, `ответ на спокойный запрос ${i + 1}`);
  assert(answers.get(id).ok, `обычный темп попал под лимит (код ${answers.get(id).code})`);
}
console.log('OK: обычный темп запросов не ограничивается');
ws.close();
