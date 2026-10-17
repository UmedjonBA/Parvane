// Федерация (spec 028) в браузере: Аня на сервере A, Борис на сервере B (одна сборка web, у каждого свой
// gateway). Аня находит Бориса по полному адресу `ник@сервер`, пишет ему; Борис видит чат и отвечает.
// Запуск: scripts/run_web_federation_e2e.sh (поднимает оба сервера).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog, findMessage, preparePage, sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-federation-e2e-1';
const STEP_TIMEOUT_MS = 30000;
const gatewayB = process.env.PARVANE_E2E_GATEWAY_URL_B;
const domainA = process.env.PARVANE_E2E_DOMAIN_A;
const domainB = process.env.PARVANE_E2E_DOMAIN_B;
assert(gatewayB && domainA && domainB, 'нужны PARVANE_E2E_GATEWAY_URL_B, PARVANE_E2E_DOMAIN_A, PARVANE_E2E_DOMAIN_B');

const suffix = Date.now().toString(36);
const anya = `anya-${suffix}@${domainA}`;
const boris = `boris-${suffix}@${domainB}`;
const nick = (address) => address.split('@')[0];

/** Открыть чат по полному адресу (поиск находит пользователя другого сервера у его сервера). */
async function openByAddress(page, address) {
  const search = page.locator('#telegram-search-input');
  const pane = page.locator('.LeftSearch');
  for (let attempt = 0; attempt < 3; attempt++) {
    await search.click();
    if (await pane.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) break;
    await search.evaluate((el) => el.blur());
  }
  await search.fill(address);
  const result = page.locator('.LeftSearch .search-result').filter({ hasText: nick(address) }).first();
  await result.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await result.locator('.ListItem-button').click();
  await page.locator('#editable-message-text[contenteditable="true"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('.MiddleHeader').getByText(nick(address)).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

const browser = await chromium.launch();
let a;
let b;
try {
  a = await preparePage(await browser.newContext(), anya, PASSWORD);
  b = await preparePage(await browser.newContext(), boris, PASSWORD, { gatewayUrl: gatewayB });
  const consoleA = [];
  a.page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleA.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  globalThis.__fedConsoleA = consoleA;
  await dismissRecoveryKeyDialog(a.page).catch(() => undefined);
  await dismissRecoveryKeyDialog(b.page).catch(() => undefined);

  // Аня пишет Борису на другой сервер
  await openByAddress(a.page, boris);
  console.log('OK: пользователь другого сервера найден по полному адресу');
  await sendText(a.page, 'привет с сервера A');

  // Борис видит чат с Аней и сообщение
  const chat = b.page.locator('#LeftColumn .ListItem').filter({ hasText: nick(anya) }).first();
  await chat.waitFor({ state: 'visible', timeout: 60000 });
  await chat.click();
  await findMessage(b.page, 'привет с сервера A').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: письмо дошло до сервера B');

  // Ответ Бориса — Ане на сервер A
  await b.page.locator('#editable-message-text[contenteditable="true"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sendText(b.page, 'ответ с сервера B');
  await findMessage(a.page, 'ответ с сервера B').first().waitFor({ state: 'visible', timeout: 60000 });
  console.log('OK: ответ дошёл до сервера A');

  // Перезагрузка: история у обоих на месте
  await a.page.reload({ waitUntil: 'domcontentloaded' });
  await a.page.locator('#LeftColumn .ListItem').filter({ hasText: nick(boris) }).first().click({ timeout: 60000 });
  await findMessage(a.page, 'ответ с сервера B').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: история переписки между серверами пережила перезагрузку');
  for (const s of [a, b]) {
    assert.deepEqual(s.errors || [], [], 'ошибки страницы');
  }
  console.log('OK');
} catch (error) {
  // Журналы провайдера обеих сторон — для разбора
  console.error(`--- консоль Ани ---\n${(globalThis.__fedConsoleA || []).slice(-40).join('\n')}`);
  for (const [who, s] of [['Аня (A)', a], ['Борис (B)', b]]) {
    if (s?.logs) console.error(`--- журнал ${who} ---\n${s.logs.slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
