// Жалобы (spec 024 И5, spec 041 REPORT-2): окно одной формой (причина, комментарий, «Кому»); на сообщение группы —
// карточка у админа группы и список «Жалобы» на экране «Тип группы» (число пожаловавшихся, «Отклонить» помнится
// после перезагрузки, «Удалить сообщение» удаляет у всех и закрывает жалобу); «Заблокировать в группе» банит автора;
// на пользователя — только администратору сервера: база identity хранит шифртекст, утилита администратора его открывает.
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
  openGroupManagement,
  openPrivateChatStrict,
  preparePage,
  relogin,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-reports-e2e-password';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ADMIN_KEY = path.join(ROOT, 'scripts/e2e_report_admin.key');
const ESCROW_ADMIN = path.join(ROOT, 'backend/target/debug/escrow_admin');

// Окно жалобы одной формой: причина чипом, комментарий, адресат (`admins` | `server`), «Отправить»
async function fileReport(page, sourceText, { reason, comment, target, targets }) {
  await openMessageMenu(page, sourceText);
  await page.getByRole('menuitem', { name: 'Report' }).click();
  const modal = page.locator('.Modal .modal-dialog').filter({ has: page.locator('[data-report-send]') }).first();
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await modal.locator(`[data-report-reason="${reason}"]`).click();
  await modal.locator('[data-report-comment]').fill(comment);
  if (targets) {
    const shown = await modal.locator('[data-report-target]').evaluateAll((list) => list.map((b) => b.dataset.reportTarget));
    assert.deepEqual(shown, targets, 'адресаты жалобы');
  }
  if (target) await modal.locator(`[data-report-target="${target}"]`).click();
  await modal.locator('[data-report-send]').click();
}

// Профиль группы → Edit → «Group Type» → «Жалобы участников»
async function openReports(page, title) {
  const right = await openGroupManagement(page, title);
  await right.locator('.ListItem').filter({ hasText: 'Group Type' }).first().click();
  await right.locator('[data-reports-entry]').first().click();
  const screen = right.locator('[data-reports-screen]');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return screen;
}

const browser = await chromium.launch();
const names = ['alice', 'carol', 'dave', 'mallory'];
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
  const { page: d } = sessions.dave;
  const spam2 = `buy-giraffe-${suffix}`;

  for (const peer of ['carol', 'dave', 'mallory']) {
    await openPrivateChatStrict(a, address(peer));
    await sendText(a, `hi-${peer}-${suffix}`);
  }
  await createGroupViaUi(a, title, ['carol', 'dave', 'mallory'].map((n) => address(n).split('@')[0]));
  await openGroupChatByTitle(m, title);
  await sendText(m, spam);
  await sendText(m, spam2);
  await openGroupChatByTitle(c, title);
  await findMessage(c, spam2).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChatByTitle(d, title);
  await findMessage(d, spam).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Жалобы на сообщения группы: двое на одно, одна на другое; адресат по умолчанию — админы ──
  await fileReport(c, spam, {
    reason: 'spam', comment: `реклама ${suffix}`, targets: ['admins', 'server'],
  });
  await expectToast(c, 'Report sent. Thank you!');
  await fileReport(d, spam, { reason: 'fraud', comment: '', target: 'admins' });
  await expectToast(d, 'Report sent. Thank you!');
  await fileReport(c, spam2, { reason: 'insult', comment: '', target: 'admins' });
  await expectToast(c, 'Report sent. Thank you!');
  await openPrivateChatStrict(a, address('carol'));
  const card = a.locator('[data-mod-report="spam"]').last();
  await card.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert((await card.innerText()).includes(spam), 'в карточке текст сообщения');
  assert((await card.innerText()).includes(`реклама ${suffix}`), 'в карточке комментарий');
  console.log('OK: жалоба на сообщение группы пришла админу карточкой');

  // ── Список «Жалобы» у админа: одна строка на сообщение, двое пожаловались ──
  await openPrivateChatStrict(a, address('dave'));
  await a.locator('[data-mod-report="fraud"]').last().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  let reports = await openReports(a, title);
  const itemOf = (screen, text) => screen.locator('[data-report-item]').filter({ hasText: text }).first();
  await itemOf(reports, spam).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await itemOf(reports, spam2).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await reports.locator('[data-report-item]').count(), 2, 'по строке на сообщение');
  assert((await itemOf(reports, spam).locator('[data-report-meta]').innerText()).includes('2 reports'), 'двое пожаловались');
  assert((await itemOf(reports, spam).innerText()).includes(`реклама ${suffix}`), 'комментарий в списке');
  assert.equal(await itemOf(reports, spam2).locator('[data-report-reason]').getAttribute('data-report-reason'), 'insult');
  console.log('OK: список жалоб у админа сведён по сообщениям');

  // «Отклонить» закрывает жалобу; закрытая не возвращается после перезагрузки (журнал личного состояния)
  await itemOf(reports, spam2).locator('[data-report-action="dismiss"]').click();
  await itemOf(reports, spam2).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await relogin(a, PASSWORD);
  reports = await openReports(a, title);
  await itemOf(reports, spam).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await itemOf(reports, spam2).count(), 0, 'отклонённая жалоба вернулась после перезагрузки');
  console.log('OK: «Отклонить» помнится после перезагрузки');

  // «Удалить сообщение» из списка — у всех участников, жалоба закрыта
  await itemOf(reports, spam).locator('[data-report-action="delete"]').click();
  await reports.locator('[data-reports-empty]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChatByTitle(c, title);
  await findMessageContainer(c, spam).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS * 2 }).catch(async () => {
    // Удалённое показывается заглушкой — исходного текста быть не должно
    assert.equal(await findMessage(c, spam).count(), 0, 'сообщение не удалено у участников');
  });
  console.log('OK: «Удалить сообщения» удалило у участников');

  // Карточка второй жалобы (её сообщение не удалено) — блокировка автора
  await openPrivateChatStrict(a, address('carol'));
  const banCard = a.locator('[data-mod-report="insult"]').last();
  await banCard.locator('[data-mod-action="ban"]').click();
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
  // Личный чат: адресат один — администратор сервера
  await fileReport(c, `private-spam-${suffix}`, {
    reason: 'fraud', comment: `не тот, за кого себя выдаёт ${suffix}`, targets: ['server'],
  });
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
  // Вывод open-report: первая строка — JSON жалобы, далее — проверка подписи каждого приложенного сообщения (A0008-2)
  const [reportJson, ...verdicts] = execFileSync(ESCROW_ADMIN, ['open-report', ADMIN_KEY, row.reporter, row.sealed])
    .toString().trim().split('\n');
  const opened = JSON.parse(reportJson);
  assert(verdicts.length > 0 && verdicts.every((line) => line.includes('подтверждено подписью устройства')),
    `подписи приложенных сообщений не подтверждены: ${verdicts.join(' | ')}`);
  assert.equal(opened.reason, 'fraud');
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
