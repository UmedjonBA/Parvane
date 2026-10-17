// Вход через Tor (spec 025 И1), локальная модель: на сервере Caddy отдаёт web-клиент и `/ws` с одного адреса
// для скрытого сервиса — здесь то же делает маленький прокси, а Firefox настроен как Tor Browser (`.onion` —
// безопасный контекст, имя ведёт на прокси). Приложение само выбирает gateway `ws://<onion>/ws`, входит и
// переписывается; звонок честно отказывает («через Tor звонки не работают»).
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { chromium, firefox } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  expectToast,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  requireEnv,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-tor-e2e-password';
const ONION_HOST = 'parvanetestxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion';

// Прокси «скрытого сервиса» — как Tor для браузера: Firefox шлёт все запросы через него (прокси браузера), адрес
// `.onion` никуда не резолвится. HTTP к `.onion` — в web-сервер, `/ws` — в gateway (сырой поток после
// рукопожатия), туннели CONNECT (WebSocket через прокси) — обратно в этот же прокси
function startOnionProxy(baseUrl, gatewayUrl) {
  const web = new URL(baseUrl);
  const gateway = new URL(gatewayUrl);
  // `localhost` у Node может уйти в IPv6, а стенд слушает IPv4
  const ipv4 = (host) => (host === 'localhost' ? '127.0.0.1' : host);
  const pathOf = (url) => (url.startsWith('http://') ? new URL(url).pathname + new URL(url).search : url);
  const server = http.createServer((req, res) => {
    const upstream = http.request({
      host: ipv4(web.hostname), port: web.port, method: req.method, path: pathOf(req.url),
      headers: { ...req.headers, host: web.host },
    }, (answer) => {
      if ((answer.statusCode || 0) >= 400) console.error(`прокси .onion: ${req.url} → ${answer.statusCode}`);
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', (error) => {
      console.error(`прокси .onion: ${req.url}: ${String(error)}`);
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!pathOf(req.url || '').startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const target = net.connect(Number(gateway.port), ipv4(gateway.hostname), () => {
      const lines = [`GET ${gateway.pathname || '/'} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        lines.push(`${name}: ${name.toLowerCase() === 'host' ? gateway.host : req.rawHeaders[i + 1]}`);
      }
      target.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });
  // WebSocket через HTTP-прокси идёт туннелем CONNECT к `.onion` — замыкаем его на этот же прокси
  server.on('connect', (req, socket, head) => {
    const target = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const { baseUrl, gatewayUrl } = requireEnv();
const proxy = await startOnionProxy(baseUrl, gatewayUrl);
const onionUrl = `http://${ONION_HOST}:${proxy.address().port}/`;
const browser = await firefox.launch({
  // Как Tor Browser: все запросы — через прокси (у Tor Browser — SOCKS Tor), `.onion` — безопасный контекст
  proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
  firefoxUserPrefs: {
    'dom.securecontext.allowlist_onions': true,
    'network.dns.blockDotOnion': false,
  },
});
// Собеседник — обычный браузер без прокси
const plainBrowser = await chromium.launch();
const sessions = {};
const gatewayRequests = [];

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `tor-alice-${suffix}@local`;
  const bob = `tor-bob-${suffix}@local`;
  const aliceContext = await browser.newContext();
  aliceContext.on('page', (page) => page.on('websocket', (ws) => gatewayRequests.push(ws.url())));
  sessions.alice = await preparePage(aliceContext, alice, PASSWORD, { startUrl: onionUrl, noGatewaySeed: true });
  sessions.bob = await preparePage(await plainBrowser.newContext(), bob, PASSWORD);
  const { page: a } = sessions.alice;
  const { page: b } = sessions.bob;
  assert(gatewayRequests.length && gatewayRequests.every((url) => url === `ws://${ONION_HOST}:${proxy.address().port}/ws`),
    `gateway не через .onion: ${JSON.stringify(gatewayRequests)}`);
  console.log('OK: страница .onion ходит в gateway по ws://<onion>/ws');

  await openPrivateChatStrict(a, bob);
  await sendText(a, `over-tor-${suffix}`);
  await openPrivateChatStrict(b, alice);
  await findMessage(b, `over-tor-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(b, `reply-${suffix}`);
  await findMessage(a, `reply-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: переписка через .onion в обе стороны');

  await a.getByRole('button', { name: 'Call', exact: true }).click();
  await expectToast(a, 'Calls do not work over Tor');
  console.log('OK: звонок через Tor честно отказывает');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий входа через Tor пройден');
} finally {
  await browser.close();
  await plainBrowser.close();
  proxy.close();
}
