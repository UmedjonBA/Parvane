// История v1 от отозванного устройства на новом устройстве (T196, найдено на проде).
// Все на протоколе v1. bob на двух устройствах; bob2 пишет alice (bob1 получает копию
// от «соседнего» своего устройства). bob1 завершает сеанс bob2 — его ключа в каталоге
// больше нет. bob3 — новое устройство, привязано от bob1: сообщение, отправленное с
// отозванного bob2, должно быть в истории (раньше отбрасывалось как подмена отправителя:
// новое устройство перепроверяло автора по текущему каталогу).
// Запуск: scripts/run_protocol_mixed_e2e.sh relink-v1
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  closeSettings,
  dumpDiagJournal,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openDevicesScreen,
  openPrivateChatStrict,
  preparePage,
  sendText,
  terminateSessionWithPassword,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v1-relink-password';
const V1_SEED = { 'parvane:proto': 'v1' };
// DEVICE_LIST_TTL_MS клиента + запас
const CATALOG_TTL_MS = 17000;

const browser = await chromium.launch();
const names = ['alice', 'bob1', 'bob2', 'bob3'];
const contexts = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await browser.newContext()])));
const logs = Object.fromEntries(names.map((n) => [n, []]));
const sessions = {};

names.forEach((who) => {
  contexts[who].on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane]')) logs[who].push(t.slice(0, 300));
    });
  });
});

async function waitLog(who, needle, from = 0, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs[who].slice(from).some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`${who}: нет записи «${needle}»`);
}

// Привязка по v1: коды сверки совпадают, старое устройство передаёт историю
async function linkDevice(oldPage, newPage, newWho) {
  const mark = logs[newWho].length;
  const newScreen = await openDevicesScreen(newPage);
  const oldScreen = await openDevicesScreen(oldPage);
  const pendingText = newScreen.getByText(/confirm code \d{4} \d{4} \d{4}/);
  await pendingText.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const newCode = (await pendingText.textContent()).match(/(\d{4} \d{4} \d{4})/)[1];
  const offerItem = oldScreen.locator('.ListItem').filter({ hasText: /Code: \d{4}/ }).first();
  await offerItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal((await offerItem.textContent()).match(/Code: (\d{4} \d{4} \d{4})/)[1], newCode, 'коды не совпали');
  await offerItem.locator('.ListItem-button').click();
  const transferButton = oldPage.getByRole('button', { name: 'Transfer', exact: true });
  await transferButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await transferButton.click();
  await oldPage.getByText('History transferred').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitLog(newWho, 'линковка: история получена и импортирована', mark);
  await closeSettings(newPage);
  await closeSettings(oldPage);
}

async function expectMessages(page, who, texts) {
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop
    await findMessage(page, text).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })
      .catch(() => { throw new Error(`${who}: нет сообщения «${text}»`); });
  }
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `r1a-${suffix}@local`;
  const bob = `r1b-${suffix}@local`;
  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD, { seedLocalStorage: V1_SEED });
  sessions.bob1 = await preparePage(contexts.bob1, bob, PASSWORD, { seedLocalStorage: V1_SEED });
  const alicePage = sessions.alice.page;
  const bob1Page = sessions.bob1.page;

  const first = `r1-first-${suffix}`;
  const firstIn = `r1-first-in-${suffix}`;
  await openPrivateChatStrict(bob1Page, alice);
  await sendText(bob1Page, first);
  await openPrivateChatStrict(alicePage, bob);
  await findMessage(alicePage, first).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(alicePage, firstIn);
  await findMessage(bob1Page, firstIn).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  sessions.bob2 = await preparePage(contexts.bob2, bob, PASSWORD, { seedLocalStorage: V1_SEED });
  const bob2Page = sessions.bob2.page;
  await linkDevice(bob1Page, bob2Page, 'bob2');
  await openPrivateChatStrict(bob2Page, alice);
  await expectMessages(bob2Page, 'bob2 после привязки', [first, firstIn]);

  // Сообщение с «соседнего» устройства: bob1 получает его копией
  const sibling = `r1-sibling-${suffix}`;
  await sendText(bob2Page, sibling);
  await findMessage(alicePage, sibling).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(bob1Page, alice);
  await expectMessages(bob1Page, 'bob1 (копия от своего устройства)', [sibling]);

  // bob1 завершает сеанс bob2: ключа bob2 в каталоге больше нет
  const dev1 = await openDevicesScreen(bob1Page);
  const otherSession = dev1.locator('.ListItem:has(.title-with-date)').first();
  await otherSession.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await terminateSessionWithPassword(bob1Page, otherSession, PASSWORD);
  await closeSettings(bob1Page);
  await contexts.bob2.close();
  delete sessions.bob2;

  // bob1 перечитывает каталог своих устройств (он обновляется при отправке, не чаще
  // раза в 15 с): отозванного bob2 в нём больше нет — как у пользователя, который
  // после отзыва продолжал переписываться
  await bob1Page.waitForTimeout(CATALOG_TTL_MS);
  const afterRevoke = `r1-after-revoke-${suffix}`;
  await openPrivateChatStrict(bob1Page, alice);
  await sendText(bob1Page, afterRevoke);
  await findMessage(alicePage, afterRevoke).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // bob3 — новое устройство, привязано от bob1
  sessions.bob3 = await preparePage(contexts.bob3, bob, PASSWORD, { seedLocalStorage: V1_SEED });
  const bob3Page = sessions.bob3.page;
  await linkDevice(bob1Page, bob3Page, 'bob3');
  await openPrivateChatStrict(bob3Page, alice);
  await expectMessages(bob3Page, 'bob3 (новое устройство)', [firstIn, first, sibling]);
  assert.ok(!logs.bob3.some((l) => l.includes('ОТКЛОНЕНО')), `bob3 отбросил историю: ${logs.bob3.filter((l) => l.includes('ОТКЛОНЕНО')).join(' | ')}`);
  console.log('e2e_protocol_relink_v1: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const who of names) {
    const session = sessions[who];
    if (!session) continue;
    // eslint-disable-next-line no-await-in-loop
    await session.page.screenshot({ path: `${shotDir}/protocol-relink-v1-${who}.png` }).catch(() => undefined);
    // eslint-disable-next-line no-await-in-loop
    await dumpDiagJournal(session.page, who, 30);
    console.error(`журнал ${who}:\n${logs[who].slice(-50).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
