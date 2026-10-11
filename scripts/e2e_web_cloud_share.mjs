// Совместные папки облака (spec 016, US6): владелец создаёт папку и зовёт
// участника читателем — тот получает сообщение-приглашение, принимает его в
// разделе, видит и скачивает файлы, но менять не может; редактор загружает и
// владелец это видит; понижение снова запрещает запись; удалённый участник
// теряет папку и не получает новое; участник покидает папку сам; сервер видит
// состав, но не имена и не содержимое.
// Запуск: scripts/run_web_cloud_share_e2e.sh
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
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-cloud-share-1';
const WIDE = { width: 1440, height: 900 };
const SYNC = 30000;
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert.ok(BACKEND_DIR, 'нужен PARVANE_E2E_BACKEND_LOG_DIR (каталог баз стенда)');

const FOLDER = 'Общий проект';
const CONTENT = 'Содержимое общего файла a71b';

function serverView() {
  const db = new DatabaseSync(`${BACKEND_DIR}/domains.db-v2.db`, { readOnly: true });
  try {
    const grants = db.prepare('SELECT grantee, level FROM container_grants ORDER BY grantee').all()
      .map((g) => `${String(g.grantee).split('@')[0].split('-')[1]}:${g.level}`);
    const texts = [];
    for (const sql of ['SELECT op AS b FROM container_log', 'SELECT snapshot AS b FROM container_snapshots']) {
      for (const row of db.prepare(sql).all()) {
        const bytes = Buffer.from(row.b || '');
        texts.push(bytes.toString('latin1'), bytes.toString('utf8'));
      }
    }
    return { grants, leaks: [FOLDER, CONTENT, 'план.txt', 'от Боба'].filter((w) => texts.some((t) => t.includes(w))) };
  } finally {
    db.close();
  }
}

async function waitFor(read, isDone, message, timeout = SYNC) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await read();
    if (isDone(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

const browser = await chromium.launch();
const sessions = {};

try {
  const suffix = Date.now().toString(36);
  const alice = `cs-alice-${suffix}@local`;
  const bob = `cs-bob-${suffix}@local`;
  const bobName = bob.split('@')[0];
  sessions.alice = await preparePage(await browser.newContext({ viewport: WIDE, acceptDownloads: true }), alice, PASSWORD);
  sessions.bob = await preparePage(await browser.newContext({ viewport: WIDE, acceptDownloads: true }), bob, PASSWORD);
  const a = sessions.alice.page;
  const b = sessions.bob.page;
  await dismissRecoveryKeyDialog(a).catch(() => undefined);
  await dismissRecoveryKeyDialog(b).catch(() => undefined);
  await exchangeMessages(a, alice, b, bob, 'share');
  const ac = cloudDriver(a);
  const bc = cloudDriver(b);
  const shareDialog = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: FOLDER });
  const member = shareDialog.locator(`[data-member="${bob}"]`);

  const invite = async (role) => {
    await shareDialog.locator('[role="radiogroup"][aria-label="Add people"]').getByRole('radio', { name: role }).click();
    await shareDialog.getByRole('button', { name: 'Add people', exact: true }).click();
    const picker = a.locator('.Modal').filter({ has: a.locator('.ChatOrUserPicker-item') });
    await picker.locator('.ChatOrUserPicker-item').filter({ hasText: bobName }).first().click();
    await member.waitFor({ state: 'visible', timeout: STEP });
  };

  // ── Алиса создаёт совместную папку, кладёт файл, зовёт Боба читателем ─────
  await ac.open();
  await ac.add('New shared folder');
  await a.locator('#parvane-cloud-shared-name').fill(FOLDER);
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  await shareDialog.waitFor({ state: 'visible', timeout: STEP });
  await shareDialog.getByText('Only you have access so far').waitFor({ state: 'visible', timeout: STEP });
  await invite('Reader');
  assert.equal(await member.getAttribute('data-role'), 'reader');
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await ac.folderRow(FOLDER).click();
  await ac.upload('план.txt', CONTENT);
  console.log('OK: совместная папка создана, участник приглашён читателем');

  // ── Боб получает приглашение сообщением и принимает его в разделе ─────────
  await openPrivateChatStrict(b, alice);
  await findMessageContainer(b, `Invitation to the folder “${FOLDER}” (reader)`).waitFor({ state: 'visible', timeout: SYNC });
  await bc.open();
  await bc.tab('Shared with me').click();
  const inviteRow = bc.folderRow(FOLDER);
  await inviteRow.waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await inviteRow.getAttribute('data-container-kind'), 'invite', 'до принятия — приглашение');
  await inviteRow.getByRole('button', { name: 'Open', exact: true }).click();
  await b.locator('.Modal').getByRole('button', { name: 'Accept', exact: true }).click();
  await bc.item('план.txt').waitFor({ state: 'visible', timeout: SYNC });
  assert.equal((await bc.download('план.txt')).toString(), CONTENT, 'читатель скачивает файл');
  // Читатель: ни загрузки, ни переименования, ни удаления
  assert.equal(await bc.cloud.getByRole('button', { name: 'Upload', exact: true }).count(), 0, 'у читателя нет загрузки');
  assert.equal(await bc.hasMenuAction('план.txt', 'Rename'), false, 'у читателя нет переименования');
  assert.equal(await bc.hasMenuAction('план.txt', 'Delete'), false, 'у читателя нет удаления');
  assert.deepEqual(serverView().grants, ['bob:1'], 'сервер знает состав и уровень чтения');
  console.log('OK: приглашение сообщением, принятие, читатель смотрит и скачивает, но не меняет');

  // ── Редактор: загрузка Боба видна Алисе ───────────────────────────────────
  await ac.cloud.locator('nav').getByRole('button', { name: 'Sharing', exact: true }).click();
  await member.getByRole('radio', { name: 'Editor' }).click();
  await a.waitForFunction(
    (address) => document.querySelector(`[data-member="${address}"]`)?.dataset.role === 'editor', bob, { timeout: STEP },
  );
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await bc.cloud.getByRole('button', { name: 'Upload', exact: true }).waitFor({ state: 'visible', timeout: SYNC });
  await bc.upload('от Боба.txt', 'файл редактора');
  await ac.item('от Боба.txt').waitFor({ state: 'visible', timeout: SYNC });
  assert.equal((await ac.download('от Боба.txt')).toString(), 'файл редактора', 'владелец читает файл редактора');
  console.log('OK: редактор загружает, владелец видит и скачивает');

  // ── Понижение до читателя: запись снова недоступна, чтение нового — есть ──
  await ac.cloud.locator('nav').getByRole('button', { name: 'Sharing', exact: true }).click();
  await member.getByRole('radio', { name: 'Reader' }).click();
  await a.waitForFunction(
    (address) => document.querySelector(`[data-member="${address}"]`)?.dataset.role === 'reader', bob, { timeout: STEP },
  );
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await bc.cloud.getByRole('button', { name: 'Upload', exact: true }).waitFor({ state: 'detached', timeout: SYNC });
  await ac.upload('после понижения.txt', 'новая эпоха');
  await bc.item('после понижения.txt').waitFor({ state: 'visible', timeout: SYNC });
  assert.equal((await bc.download('после понижения.txt')).toString(), 'новая эпоха', 'читатель читает и в новой эпохе');
  console.log('OK: понижение до читателя — запись закрыта, чтение осталось');

  // ── Алиса убирает Боба: папка у него исчезает, новое он не получает ───────
  await ac.cloud.locator('nav').getByRole('button', { name: 'Sharing', exact: true }).click();
  await member.getByRole('button', { name: 'Remove' }).click();
  await member.waitFor({ state: 'detached', timeout: STEP });
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await ac.upload('после удаления.txt', 'только для владельца');
  await bc.cloud.getByText('No one has shared a folder with you yet').waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await bc.item('после удаления.txt').count(), 0);
  await waitFor(() => Promise.resolve(serverView().grants), (g) => g.length === 0, 'грант не снят на сервере');
  console.log('OK: удалённый участник теряет папку и не получает новое');

  // ── Вторая папка: Боб редактор и уходит сам ───────────────────────────────
  await ac.cloud.locator('nav').getByRole('button', { name: 'My files' }).click();
  await ac.add('New shared folder');
  await a.locator('#parvane-cloud-shared-name').fill('Фото');
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  const second = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: 'Фото' });
  await second.waitFor({ state: 'visible', timeout: STEP });
  await second.locator('[role="radiogroup"][aria-label="Add people"]').getByRole('radio', { name: 'Editor' }).click();
  await second.getByRole('button', { name: 'Add people', exact: true }).click();
  await a.locator('.Modal .ChatOrUserPicker-item').filter({ hasText: bobName }).first().click();
  await second.locator(`[data-member="${bob}"]`).waitFor({ state: 'visible', timeout: STEP });
  const photoInvite = bc.folderRow('Фото');
  await photoInvite.waitFor({ state: 'visible', timeout: SYNC });
  await photoInvite.getByRole('button', { name: 'Open', exact: true }).click();
  await b.locator('.Modal').getByRole('button', { name: 'Accept', exact: true }).click();
  await bc.cloud.locator('nav').getByRole('button', { name: 'Sharing', exact: true }).click();
  await b.locator('.Modal').getByRole('button', { name: 'Leave folder', exact: true }).click();
  await b.locator('.Modal').filter({ hasText: 'You will lose access' }).getByRole('button', { name: 'Leave folder', exact: true }).click();
  await bc.cloud.getByText('No one has shared a folder with you yet').waitFor({ state: 'visible', timeout: SYNC });
  // Владелец видит, что участников не осталось
  await waitFor(() => Promise.resolve(serverView().grants), (g) => g.length === 0, 'выход не записан на сервере');
  await a.waitForFunction(
    (address) => !document.querySelector(`[data-member="${address}"]`), bob, { timeout: SYNC },
  );
  console.log('OK: участник покинул папку сам, владелец это видит');

  // ── Сервер видит состав, но не имена и не содержимое ──────────────────────
  assert.deepEqual(serverView().leaks, [], 'в базе сервера найден открытый текст');
  console.log('OK: в базе сервера нет имён папок, файлов и содержимого');

  for (const [name, s] of Object.entries(sessions)) {
    assert.deepEqual(s.errors, [], `${name}: ошибки страницы: ${s.errors.join('; ')}`);
  }
  console.log('OK: совместные папки — приглашение, роли, удаление участника, выход');
} catch (err) {
  for (const [name, s] of Object.entries(sessions)) {
    await s.page.screenshot({ path: `${BACKEND_DIR}/cloud-share-${name}.png` }).catch(() => undefined);
    console.log(`--- ${name}`);
    console.log((s.logs || []).filter((l) => l.includes('облако') || l.includes('v2:')).slice(-25).join('\n'));
  }
  throw err;
} finally {
  await browser.close();
}
