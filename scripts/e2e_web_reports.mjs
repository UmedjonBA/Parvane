// Жалобы (spec 024 И5): на сообщение группы — карточка у админа группы («Удалить сообщения» удаляет у всех,
// «Заблокировать в группе» банит автора); на пользователя — администратору сервера: база identity хранит
// шифртекст (текста жалобы в ней нет), утилита администратора его открывает.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  createGroupViaUi,
  expectToast,
  findMessage,
  findMessageContainer,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
  openMessageMenu,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-reports-e2e-password';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ADMIN_KEY = path.join(ROOT, 'scripts/e2e_report_admin.key');
const ESCROW_ADMIN = path.join(ROOT, 'backend/target/debug/escrow_admin');

// Окно жалобы: причина → комментарий → «Отправить жалобу»
async function fileReport(page, reason, comment) {
  const modal = page.locator('.Modal .modal-dialog').filter({ hasText: reason }).first();
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await modal.getByText(reason, { exact: true }).first().click();
  const field = page.locator('.Modal textarea#option');
  await field.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await field.fill(comment);
  await page.locator('.Modal').getByRole('button', { name: 'Send Report' }).click();
}

const browser = await chromium.launch();
const names = ['alice', 'carol', 'mallory'];
const contexts = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await browser.newContext()])));
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const address = (name) => `rep-${name}-${suffix}@local`;
  const title = `Reports ${suffix}`;
  const spam = `buy-elephant-${suffix}`;
  for (const name of names) sessions[name] = await preparePage(contexts[name], address(name), PASSWORD);
  const { page: a } = sessions.alice;
  const { page: c } = sessions.carol;
  const { page: m } = sessions.mallory;

  for (const peer of ['carol', 'mallory']) {
    await openPrivateChatStrict(a, address(peer));
    await sendText(a, `hi-${peer}-${suffix}`);
  }
  await createGroupViaUi(a, title, [address('carol').split('@')[0], address('mallory').split('@')[0]]);
  await openGroupChatByTitle(m, title);
  await sendText(m, spam);
  await openGroupChatByTitle(c, title);
  await findMessage(c, spam).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Жалоба на сообщение группы → карточка у владельца ─────────────────────
  await openMessageMenu(c, spam);
  await c.getByRole('menuitem', { name: 'Report' }).click();
  await c.getByText(/go to the group admins/).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await fileReport(c, 'Spam', `реклама ${suffix}`);
  await expectToast(c, 'Report sent. Thank you!');
  await openPrivateChatStrict(a, address('carol'));
  const card = a.locator('[data-mod-report="spam"]').last();
  await card.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert((await card.innerText()).includes(spam), 'в карточке текст сообщения');
  assert((await card.innerText()).includes(`реклама ${suffix}`), 'в карточке комментарий');
  console.log('OK: жалоба на сообщение группы пришла админу карточкой');

  await card.locator('[data-mod-action="delete"]').click();
  await card.locator('[data-mod-done]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChatByTitle(c, title);
  await findMessageContainer(c, spam).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS * 2 }).catch(async () => {
    // Удалённое показывается заглушкой — исходного текста быть не должно
    assert.equal(await findMessage(c, spam).count(), 0, 'сообщение не удалено у участников');
  });
  console.log('OK: «Удалить сообщения» удалило у участников');

  await openPrivateChatStrict(a, address('carol'));
  await card.locator('[data-mod-action="ban"]').click();
  await a.waitForFunction(({ t, who }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === t);
    const members = global.chats.fullInfoById[chat?.id]?.members || [];
    const user = Object.values(global.users.byId).find((u) => u.usernames?.some(({ username }) => username === who));
    return chat && user && !members.some((member) => member.userId === user.id);
  }, { t: title, who: address('mallory').split('@')[0] }, { timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: «Заблокировать в группе» убрало автора');

  // ── Жалоба на пользователя → администратору сервера ──────────────────────
  await openPrivateChatStrict(m, address('carol'));
  await sendText(m, `private-spam-${suffix}`);
  await openPrivateChatStrict(c, address('mallory'));
  await findMessage(c, `private-spam-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openMessageMenu(c, `private-spam-${suffix}`);
  await c.getByRole('menuitem', { name: 'Report' }).click();
  await c.getByText(/go to the server administrator/).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await fileReport(c, 'Fake account', `не тот, за кого себя выдаёт ${suffix}`);
  await expectToast(c, 'Report sent. Thank you!');

  const logDir = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  assert(logDir, 'нет PARVANE_E2E_BACKEND_LOG_DIR');
  const db = new DatabaseSync(path.join(logDir, 'identity.db-v2.db'), { readOnly: true });
  const rows = db.prepare('SELECT reporter, hex(sealed) AS sealed FROM reports').all();
  db.close();
  const row = rows.find((r) => r.reporter === address('carol'));
  assert(row, `жалобы Кэрол нет в базе: ${JSON.stringify(rows.map((r) => r.reporter))}`);
  assert(!Buffer.from(row.sealed, 'hex').toString('utf8').includes(suffix), 'текст жалобы виден серверу');
  if (!fs.existsSync(ESCROW_ADMIN)) {
    execFileSync('cargo', ['build', '-q', '--manifest-path', path.join(ROOT, 'backend/Cargo.toml'),
      '-p', 'parvane-protocol', '--bin', 'escrow_admin'], { stdio: 'inherit' });
  }
  const opened = JSON.parse(execFileSync(ESCROW_ADMIN, ['open-report', ADMIN_KEY, row.reporter, row.sealed]).toString());
  assert.equal(opened.reason, 'fake');
  assert(opened.comment.includes(suffix), 'комментарий в жалобе');
  assert.equal(opened.target, address('mallory'), 'на кого жалоба');
  assert(opened.messages.some((msg) => msg.text === `private-spam-${suffix}` && msg.author === address('mallory')),
    'приложенное сообщение');
  console.log('OK: жалоба администратору хранится шифртекстом и открывается его ключом');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий жалоб пройден');
} finally {
  await browser.close();
}
