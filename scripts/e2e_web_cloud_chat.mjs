// Облако и чаты (spec 016, US5): файл из облака уходит в чат («Из облака» во
// вложениях и «Отправить в чат» из раздела) без загрузки с устройства;
// получатель сохраняет файл сообщения в своё облако («Сохранить в облако») и
// скачивает его; копии независимы — удаление из облака отправителя не ломает
// ни сообщение, ни копию получателя.
// Запуск: scripts/run_web_cloud_chat_e2e.sh
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { CLOUD_STEP_TIMEOUT_MS as STEP, cloudDriver } from './e2e_web_cloud_lib.mjs';
import {
  dismissRecoveryKeyDialog,
  exchangeMessages,
  findMessageContainer,
  openPrivateChatStrict,
  preparePage,
  selectMessageActionOn,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-cloud-chat-1';
const WIDE = { width: 1440, height: 900 };
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert.ok(BACKEND_DIR, 'нужен PARVANE_E2E_BACKEND_LOG_DIR (каталог баз стенда)');

const CONTENT = 'Содержимое файла из облака в чат 5d2e';
const SECOND = 'Второй файл, отправленный из раздела';

function blobCounts() {
  const db = new DatabaseSync(`${BACKEND_DIR}/cloud.db`, { readOnly: true });
  try {
    const rows = db.prepare('SELECT owner, bucket, COUNT(*) AS n FROM files GROUP BY owner, bucket').all();
    return Object.fromEntries(rows.map((r) => [`${r.owner.split('@')[0].split('-')[1]}:${r.bucket}`, r.n]));
  } finally {
    db.close();
  }
}

const browser = await chromium.launch();
const sessions = {};

try {
  const suffix = Date.now().toString(36);
  const alice = `cc-alice-${suffix}@local`;
  const bob = `cc-bob-${suffix}@local`;
  sessions.alice = await preparePage(await browser.newContext({ viewport: WIDE, acceptDownloads: true }), alice, PASSWORD);
  sessions.bob = await preparePage(await browser.newContext({ viewport: WIDE, acceptDownloads: true }), bob, PASSWORD);
  const a = sessions.alice.page;
  const b = sessions.bob.page;
  await dismissRecoveryKeyDialog(a).catch(() => undefined);
  await dismissRecoveryKeyDialog(b).catch(() => undefined);
  await exchangeMessages(a, alice, b, bob, 'cloud');

  // ── Алиса кладёт файлы в облако ───────────────────────────────────────────
  const ac = cloudDriver(a);
  await ac.open();
  await ac.upload('договор.txt', CONTENT);
  await ac.upload('смета.txt', SECOND);
  await ac.close();
  assert.equal(blobCounts()['alice:1'], 2, 'два блоба в облаке Алисы');
  console.log('OK: файлы в облаке отправителя');

  // ── «Из облака» во вложениях: файл уходит в чат копией на сервере ─────────
  await openPrivateChatStrict(a, bob);
  await a.getByRole('button', { name: 'Add an attachment' }).click();
  await a.getByRole('menuitem', { name: 'From Cloud', exact: true }).click();
  const picker = a.locator('.Modal').filter({ hasText: 'Choose files' });
  await picker.locator('[data-name="договор.txt"]').click();
  await picker.getByRole('button', { name: 'Send', exact: true }).click();
  await picker.waitFor({ state: 'detached', timeout: STEP });
  await findMessageContainer(a, 'договор.txt').waitFor({ state: 'visible', timeout: STEP });
  await openPrivateChatStrict(b, alice);
  const received = findMessageContainer(b, 'договор.txt');
  await received.waitFor({ state: 'visible', timeout: STEP });
  assert.equal(blobCounts()['alice:0'] >= 1, true, 'сообщение ссылается на свою копию блоба в медиа чатов');
  console.log('OK: «Из облака» — собеседник получил обычное сообщение с файлом');

  // ── «Отправить в чат» из раздела ──────────────────────────────────────────
  await ac.open();
  await ac.menu('смета.txt', 'Send to chat');
  const recipients = a.locator('.Modal').filter({ has: a.locator('.ChatOrUserPicker-item') });
  await recipients.locator('.ChatOrUserPicker-item').filter({ hasText: bob.split('@')[0] }).first().click();
  await ac.cloud.getByText('Sent', { exact: true }).waitFor({ state: 'visible', timeout: STEP });
  await ac.close();
  await findMessageContainer(b, 'смета.txt').waitFor({ state: 'visible', timeout: STEP });
  console.log('OK: «Отправить в чат» из раздела');

  // ── Боб сохраняет файл сообщения в своё облако и скачивает его оттуда ─────
  await selectMessageActionOn(b, received, 'Save to Cloud');
  const saveDialog = b.locator('.Modal').filter({ hasText: 'Choose a folder' });
  await saveDialog.getByRole('button', { name: 'Save here', exact: true }).click();
  await b.locator('.Notification-container').getByText('Saved to Cloud').first().waitFor({ state: 'visible', timeout: STEP });
  const bc = cloudDriver(b);
  await bc.open();
  await bc.item('договор.txt').waitFor({ state: 'visible', timeout: STEP });
  assert.equal((await bc.download('договор.txt')).toString(), CONTENT, 'файл в облаке получателя совпадает с исходным');
  assert.equal(blobCounts()['bob:1'], 1, 'у Боба своя копия в его облаке');
  console.log('OK: «Сохранить в облако» — файл чужого сообщения в облаке получателя');

  // ── Копии независимы: Алиса стирает файл из облака навсегда ───────────────
  await ac.open();
  await ac.menu('договор.txt', 'Delete');
  await ac.tab('Trash').click();
  await ac.menu('договор.txt', 'Delete forever');
  await a.locator('.Modal').getByRole('button', { name: 'Delete forever', exact: true }).click();
  await ac.item('договор.txt').waitFor({ state: 'detached', timeout: STEP });
  const started = Date.now();
  while (blobCounts()['alice:1'] !== 1 && Date.now() - started < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const after = blobCounts();
  assert.equal(after['alice:1'], 1, 'блоб стёртого файла убран из облака Алисы');
  assert.ok(after['alice:0'] >= 2, 'копии сообщений остались');
  assert.equal(after['bob:1'], 1, 'копия Боба осталась');
  assert.equal((await bc.download('договор.txt')).toString(), CONTENT, 'облако получателя не пострадало');
  // Сообщение в чате по-прежнему открывается: файл скачивается из сообщения
  await bc.close();
  await openPrivateChatStrict(b, alice);
  const [fromChat] = await Promise.all([
    b.waitForEvent('download', { timeout: STEP }),
    selectMessageActionOn(b, findMessageContainer(b, 'договор.txt'), 'Download'),
  ]);
  assert.ok(await fromChat.path(), 'файл сообщения скачался после удаления из облака отправителя');
  console.log('OK: удаление из облака не ломает ни сообщение, ни копию получателя');

  for (const [name, s] of Object.entries(sessions)) {
    assert.deepEqual(s.errors, [], `${name}: ошибки страницы: ${s.errors.join('; ')}`);
  }
  console.log('OK: облако и чаты — отправка из облака, сохранение в облако, независимые копии');
} catch (err) {
  for (const [name, s] of Object.entries(sessions)) {
    await s.page.screenshot({ path: `${BACKEND_DIR}/cloud-chat-${name}.png` }).catch(() => undefined);
    console.log(`--- ${name}`);
    console.log((s.logs || []).filter((l) => l.includes('облако') || l.includes('v2:')).slice(-25).join('\n'));
  }
  throw err;
} finally {
  await browser.close();
}
