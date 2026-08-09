// Трёхбраузерный сценарий инвайт-ссылок: владелец видит постоянную ссылку
// группы в профиле, шлёт её третьему пользователю, тот вступает кликом по
// ссылке и получает групповые сообщения.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  findMessage,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-invites-e2e-password';

async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name })
    .first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const checkedRows = `${containerSelector} .PeerPickerItem input[type="checkbox"]:checked, `
    + `${containerSelector} .ItemPickerItem input[type="checkbox"]:checked`;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await page.locator(checkedRows).count()) return;
    if (attempt % 2 === 0) {
      await row.press(' ').catch(() => {});
    } else {
      await row.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  assert.fail(`picker row for ${name} is never selected in ${containerSelector}`);
}

async function openGroupChat(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// openPrivateChat завершает ожидание по видимому композеру — если чат уже был
// открыт, промах клика по результату поиска остаётся незамеченным. Проверяем
// заголовок и повторяем
async function openPrivateChatStrict(page, address) {
  const name = address.split('@')[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    await openPrivateChat(page, address).catch(() => {});
    const isOpen = await page.locator('.MiddleHeader').getByText(name).first()
      .isVisible().catch(() => false);
    if (isOpen) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  assert.fail(`chat with ${address} did not open`);
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const charlieContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `inv-alice-${suffix}@local`;
  const bob = `inv-bob-${suffix}@local`;
  const charlie = `inv-charlie-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const groupTitle = `Invites ${suffix}`;
  const groupHello = `group-hello-${suffix}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  const charlieSession = await preparePage(charlieContext, charlie, PASSWORD);

  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, `hi-bob-${suffix}`);
  await openPrivateChatStrict(aliceSession.page, charlie);
  await sendText(aliceSession.page, `hi-charlie-${suffix}`);

  // ── Группа с Бобом ─────────────────────────────────────────────────────────
  await aliceSession.page.mouse.move(800, 360);
  await aliceSession.page.waitForTimeout(200);
  await aliceSession.page.locator('#LeftColumn').hover();
  await aliceSession.page.getByRole('button', { name: 'New Message' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = aliceSession.page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(bobName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', bobName);
  await aliceSession.page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = aliceSession.page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Create Group' }).click();
  await aliceSession.page.locator('#editable-message-text')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChat(aliceSession.page, groupTitle);

  // ── Инвайт-ссылка в профиле группы у владельца ─────────────────────────────
  await aliceSession.page.locator('.MiddleHeader .chat-info-wrapper').click();
  const rightColumn = aliceSession.page.locator('#RightColumn');
  await rightColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const linkRow = rightColumn.getByText(/parvane\.invite\//).first();
  await linkRow.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const linkText = (await linkRow.innerText()).trim();
  const inviteUrl = linkText.startsWith('http') ? linkText : `https://${linkText}`;
  assert.match(inviteUrl, /parvane\.invite\/.+/, 'invite link is empty');
  await aliceSession.page.keyboard.press('Escape');

  // ── Чарли вступает по клику на ссылку ──────────────────────────────────────
  await openPrivateChatStrict(aliceSession.page, charlie);
  await sendText(aliceSession.page, inviteUrl);
  await openPrivateChatStrict(charlieSession.page, alice);
  const inviteLink = charlieSession.page
    .locator('.Transition_slide-active > .MessageList a', { hasText: 'parvane.invite' }).first();
  await inviteLink.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await inviteLink.click();
  // Вступление открывает группу
  await charlieSession.page.locator('.MiddleHeader').getByText(groupTitle)
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Вступивший постит первым: это же доносит его членство до остальных
  // (их клиенты обновляют состав по входящему кадру) ─────────────────────────
  const charlieHello = `charlie-joined-${suffix}`;
  // После вступления смонтированы два слайда Transition (1-1 и группа) —
  // шлём через композер активного слайда
  const charlieComposer = charlieSession.page
    .locator('.Transition_slide-active #editable-message-text').last();
  await charlieComposer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await charlieComposer.fill(charlieHello);
  await charlieComposer.press('Enter');
  await openGroupChat(aliceSession.page, groupTitle);
  await findMessage(aliceSession.page, charlieHello).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Ответ владельца доходит вступившему по ссылке ──────────────────────────
  // Ждём конвергенции ростера у Алисы (иначе SKDM не уйдёт Чарли)
  await aliceSession.page.locator('.MiddleHeader').getByText(/3 members/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(aliceSession.page, groupHello);
  await findMessage(charlieSession.page, groupHello).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // И Боб (изначальный участник) тоже видит
  await openGroupChat(bobSession.page, groupTitle);
  await findMessage(bobSession.page, groupHello).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);
  assert.deepEqual(charlieSession.errors, [], `Charlie page errors: ${charlieSession.errors.join('; ')}`);

  console.log('OK: инвайт-ссылка в профиле, вступление по клику и доставка групповых сообщений новому участнику');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext], ['charlie', charlieContext]]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}invites-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
