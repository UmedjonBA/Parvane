// Лимит частоты на gateway: авторизованная сессия, флуд msg.chat.send
// (fire-and-forget) → после всплеска приходят err-фреймы rate_limited; обычный
// темп проходит. Без браузера: регистрация + JWT через pre-auth запросы.
import assert from 'node:assert/strict';

const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
assert(gatewayUrl, 'PARVANE_E2E_GATEWAY_URL is required');

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('gateway ws error')), { once: true });
  });
}

function request(ws, subject, payload, id = String(Math.random())) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${subject}`)), 10000);
    const onMessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.id !== id) return;
      ws.removeEventListener('message', onMessage);
      clearTimeout(timer);
      if (frame.op === 'err') reject(new Error(frame.error));
      else resolve(JSON.parse(frame.payload || '{}'));
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ op: 'req', id, subject, payload: JSON.stringify(payload), timeout_ms: 5000 }));
  });
}

const user = `rl-${Date.now()}@local`;
const password = 'Parvane-rate-limit-e2e';
const pre = await connect();
const reg = await request(pre, 'identity.user.register', { user, password, invite: '', email: '' });
assert.equal(reg.ok, true, `register: ${JSON.stringify(reg)}`);
const issued = await request(pre, 'identity.token.issue', { user, password });
assert.equal(issued.ok, true, `issue: ${JSON.stringify(issued)}`);
pre.close();

const ws = await connect();
const authOk = new Promise((resolve, reject) => {
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.op === 'auth_ok') resolve();
    if (frame.op === 'auth_err') reject(new Error(frame.error));
  }, { once: true });
});
ws.send(JSON.stringify({ op: 'auth', token: issued.token }));
await authOk;

let rateLimited = 0;
let otherErrors = 0;
ws.addEventListener('message', (event) => {
  const frame = JSON.parse(String(event.data));
  if (frame.op !== 'err') return;
  if ((frame.error || '').startsWith('rate_limited')) rateLimited += 1;
  else otherErrors += 1;
});

// Полезная нагрузка не важна: лимит срабатывает ДО разбора; чтобы шард не
// ругался на мусор, шлём заведомо непроходящий (пустой) конверт
const flood = 200;
for (let i = 0; i < flood; i++) {
  ws.send(JSON.stringify({ op: 'pub', subject: 'msg.chat.send', payload: '{}' }));
}
await new Promise((resolve) => { setTimeout(resolve, 1500); });
assert(rateLimited > 0, 'флуд не ограничен: ни одного rate_limited');
assert(rateLimited < flood, 'все кадры отклонены — лимит слишком жёсткий');
console.log(`OK: из ${flood} publish отклонено ${rateLimited} (rate_limited), прочих ошибок ${otherErrors}`);

// Обычный темп: 3 запроса в секунду проходят без rate_limited
rateLimited = 0;
for (let i = 0; i < 5; i++) {
  const info = await request(ws, 'identity.server.info', {});
  assert(info.domain, 'server.info без домена');
  await new Promise((resolve) => { setTimeout(resolve, 350); });
}
assert.equal(rateLimited, 0, 'обычный темп попал под лимит');
console.log('OK: обычный темп запросов не ограничивается');
ws.close();
