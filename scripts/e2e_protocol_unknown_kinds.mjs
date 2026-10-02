// Протокол v2 (spec 007, T041, FR-004): неизвестный вид содержимого.
// Получатель — web на v2 (parvane:proto=v2). Отправитель — тестовый Rust-инжектор
// (backend/tests/integration/tests/v2_inject.rs, ядро parvane-protocol с фичей
// `test-inject`): 10 sealed-сообщений с Content, у которого только поле с
// номером, которого нет в content.proto, затем одно обычное текстовое.
// Ожидание: 10 нативных заглушек MessageUnsupported («This message is not
// supported by your version of Parvane…»), журнал не застревает — обычное
// сообщение доставлено и показано ПОСЛЕ заглушек.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  LOGIN_TIMEOUT_MS,
  dumpDiagJournal,
  findMessage,
  openPrivateChatStrict,
  preparePage,
} from './e2e_web_helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'Parvane-v2-e2e-password';
const V2_SEED = { 'parvane:proto': 'v2' };
const UNKNOWN_COUNT = 10;
const STUB_TEXT = 'This message is not supported by your version of Parvane';

const tcpUrl = process.env.PARVANE_E2E_GATEWAY_TCP_URL;
assert(tcpUrl, 'PARVANE_E2E_GATEWAY_TCP_URL is required');

function runInjector(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', [
      'test', '-p', 'parvane-integration', '--test', 'v2_inject', '--', '--ignored', '--nocapture',
    ], { cwd: path.join(ROOT, 'backend'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && out.includes('INJECT OK')) resolve(out);
      else reject(new Error(`инжектор завершился с кодом ${code}:\n${out.slice(-6000)}`));
    });
  });
}

const browser = await chromium.launch();
const context = await browser.newContext();
const logs = [];
const consoleTail = [];
context.on('page', (page) => {
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[parvane] v2')) logs.push(t);
    consoleTail.push(`${m.type()}: ${t.slice(0, 300)}`);
    if (consoleTail.length > 80) consoleTail.shift();
  });
  page.on('pageerror', (e) => consoleTail.push(`pageerror: ${String(e).slice(0, 500)}`));
});

async function waitLog(needle, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs.some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`нет записи «${needle}» (журнал v2: ${logs.join(' | ')})`);
}

let session;
try {
  const suffix = `${Date.now()}-${process.pid}`;
  const receiver = `v2uk-${suffix}@local`;
  const injector = `v2inj-${suffix}@local`;
  const finalText = `v2-after-unknown-${suffix}`;

  session = await preparePage(context, receiver, PASSWORD, { seedLocalStorage: V2_SEED });
  // Журнал устройств и сертификат получателя опубликованы — инжектор их найдёт.
  await waitLog('v2: готов');
  await dismissRecoveryKeyDialog(session.page);

  const out = await runInjector({
    PARVANE_INJECT_GATEWAY_TCP: tcpUrl,
    PARVANE_INJECT_FROM: injector,
    PARVANE_INJECT_TO: receiver,
    PARVANE_INJECT_TEXT: finalText,
    PARVANE_INJECT_COUNT: String(UNKNOWN_COUNT),
  });
  console.log(out.split('\n').filter((l) => l.startsWith('INJECT')).join('\n'));

  await openPrivateChatStrict(session.page, injector);
  const { page } = session;
  // Обычное сообщение после неизвестных — доставлено (курсор не застрял).
  await findMessage(page, finalText).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const stubs = page.locator('.Transition_slide-active > .MessageList .Message .content-unsupported');
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while ((await stubs.count()) < UNKNOWN_COUNT && Date.now() < deadline) {
    await page.waitForTimeout(300);
  }
  const count = await stubs.count();
  assert.equal(count, UNKNOWN_COUNT, `заглушек «не поддерживается»: ${count}, ожидалось ${UNKNOWN_COUNT}`);
  const texts = await stubs.allInnerTexts();
  assert.ok(texts.every((t) => t.includes(STUB_TEXT)), `текст заглушки: ${JSON.stringify(texts.slice(0, 2))}`);
  // Порядок: обычное сообщение — последнее, после всех заглушек.
  const order = await page.locator('.Transition_slide-active > .MessageList .Message').evaluateAll(
    (els, needle) => els.map((el) => (el.querySelector('.content-unsupported') ? 'stub'
      : (el.textContent || '').includes(needle) ? 'text' : 'other')),
    finalText,
  );
  const lastStub = order.lastIndexOf('stub');
  const textAt = order.indexOf('text');
  assert.ok(textAt > lastStub, `порядок сообщений: ${order.join(',')}`);
  assert.ok(!logs.some((l) => l.includes('запуск не удался')), logs.join(' | '));
  console.log(`e2e_protocol_unknown_kinds: OK (${count} заглушек, затем «${finalText}»)`);
} catch (error) {
  if (session) await dumpDiagJournal(session.page, 'receiver');
  console.error(`консоль:\n${consoleTail.join('\n')}`);
  console.error(`v2 журнал: ${logs.join('\n')}`);
  throw error;
} finally {
  await browser.close();
}
