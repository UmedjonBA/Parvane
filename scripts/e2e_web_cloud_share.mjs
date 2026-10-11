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
const ARCHIVE = 'Архив b93c';

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
    return { grants, leaks: [FOLDER, CONTENT, 'план.txt', 'от Боба', ARCHIVE, 'отчёт.txt', 'глубоко'].filter((w) => texts.some((t) => t.includes(w))) };
  } finally {
    db.close();
  }
}

// Блобы облака владельца на сервере (bucket 1): перенос не должен оставлять лишних копий
function driveBlobs(owner) {
  const db = new DatabaseSync(`${BACKEND_DIR}/cloud.db`, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM files WHERE owner = ? AND bucket = 1').get(owner).n;
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

  // ── Обычная папка личного диска становится совместной со всем содержимым ──
  const createFolder = async (name) => {
    await ac.add('New folder');
    await a.locator('#parvane-cloud-name').fill(name);
    await a.getByRole('button', { name: 'Create', exact: true }).click();
    await ac.item(name).waitFor({ state: 'visible', timeout: STEP });
  };
  const toMyFiles = () => ac.cloud.locator('nav').getByRole('button', { name: 'My files' }).first().click();
  const moveTo = async (name, placeName) => {
    await ac.menu(name, 'Move');
    const dialog = a.locator('.Modal .modal-dialog').filter({ hasText: 'Move to' });
    await dialog.getByRole('button', { name: 'Cloud', exact: true }).click();
    await dialog.getByRole('listitem').filter({ hasText: placeName }).click();
    await dialog.getByRole('button', { name: 'Move here', exact: true }).click();
    await ac.item(name).waitFor({ state: 'detached', timeout: SYNC });
  };
  await a.locator('.Modal.open').getByRole('button', { name: 'Close', exact: true }).last().click().catch(() => undefined);
  await toMyFiles();
  const blobsBefore = driveBlobs(alice);
  await createFolder(ARCHIVE);
  await ac.item(ARCHIVE).click();
  await ac.upload('отчёт.txt', 'данные архива');
  await createFolder('Вложенная');
  await ac.item('Вложенная').click();
  await ac.upload('глубоко.txt', 'файл в глубине');
  await toMyFiles();
  await ac.menu(ARCHIVE, 'Sharing');
  await a.locator('.Modal').getByRole('button', { name: 'Make shared', exact: true }).click();
  const archiveDialog = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: ARCHIVE });
  await archiveDialog.waitFor({ state: 'visible', timeout: SYNC });
  await archiveDialog.locator('[role="radiogroup"][aria-label="Add people"]').getByRole('radio', { name: 'Reader' }).click();
  await archiveDialog.getByRole('button', { name: 'Add people', exact: true }).click();
  await a.locator('.Modal .ChatOrUserPicker-item').filter({ hasText: bobName }).first().click();
  await archiveDialog.locator(`[data-member="${bob}"]`).waitFor({ state: 'visible', timeout: STEP });
  await archiveDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  assert.equal(await ac.item(ARCHIVE).count(), 0, 'обычной папки на диске больше нет');
  assert.equal(await ac.folderRow(ARCHIVE).getAttribute('data-container-kind'), 'owned', 'папка стала совместной');
  await ac.folderRow(ARCHIVE).click();
  assert.equal((await ac.download('отчёт.txt')).toString(), 'данные архива', 'файл папки цел у владельца');
  const archiveInvite = bc.folderRow(ARCHIVE);
  await archiveInvite.waitFor({ state: 'visible', timeout: SYNC });
  await archiveInvite.getByRole('button', { name: 'Open', exact: true }).click();
  await b.locator('.Modal').getByRole('button', { name: 'Accept', exact: true }).click();
  await bc.item('отчёт.txt').waitFor({ state: 'visible', timeout: SYNC });
  await bc.item('Вложенная').click();
  assert.equal((await bc.download('глубоко.txt')).toString(), 'файл в глубине', 'участник читает вложенный файл');
  await bc.cloud.locator('nav').getByRole('button', { name: ARCHIVE }).click();
  console.log('OK: обычная папка стала совместной вместе с вложенным, участник читает файлы');

  // ── Перенос между личным диском и совместной папкой в обе стороны ─────────
  await toMyFiles();
  await ac.upload('личный.txt', 'с личного диска');
  await moveTo('личный.txt', ARCHIVE);
  await bc.item('личный.txt').waitFor({ state: 'visible', timeout: SYNC });
  assert.equal((await bc.download('личный.txt')).toString(), 'с личного диска', 'участник читает перенесённый файл');
  await ac.folderRow(ARCHIVE).click();
  await ac.item('личный.txt').waitFor({ state: 'visible', timeout: STEP });
  await moveTo('отчёт.txt', 'My files');
  await bc.item('отчёт.txt').waitFor({ state: 'detached', timeout: SYNC });
  await toMyFiles();
  assert.equal((await ac.download('отчёт.txt')).toString(), 'данные архива', 'файл вернулся на личный диск целым');
  // Три файла — три блоба: копии источника стёрты
  await waitFor(
    () => Promise.resolve(driveBlobs(alice) - blobsBefore), (n) => n === 3, 'после переноса остались лишние блобы',
  );
  console.log('OK: перенос между личным диском и совместной папкой в обе стороны, лишних блобов нет');

  // ── Совместная папка снова становится обычной: содержимое на диске, участник теряет доступ ──
  await ac.folderRow(ARCHIVE).getByRole('button', { name: 'Sharing', exact: true }).click();
  await archiveDialog.getByRole('button', { name: 'Make private', exact: true }).click();
  await a.locator('.Modal').filter({ hasText: 'becomes a regular folder' })
    .getByRole('button', { name: 'Make private', exact: true }).click();
  await ac.item(ARCHIVE).waitFor({ state: 'visible', timeout: SYNC });
  await ac.folderRow(ARCHIVE).waitFor({ state: 'detached', timeout: SYNC });
  await ac.item(ARCHIVE).click();
  assert.equal((await ac.download('личный.txt')).toString(), 'с личного диска', 'файл на месте в обычной папке');
  await ac.item('Вложенная').click();
  assert.equal((await ac.download('глубоко.txt')).toString(), 'файл в глубине', 'вложенный файл на месте');
  await toMyFiles();
  await bc.cloud.getByText('No one has shared a folder with you yet').waitFor({ state: 'visible', timeout: SYNC });
  await waitFor(() => Promise.resolve(serverView().grants), (g) => g.length === 0, 'грант не снят после закрытия доступа');
  await waitFor(
    () => Promise.resolve(driveBlobs(alice) - blobsBefore), (n) => n === 3, 'после закрытия доступа остались лишние блобы',
  );
  console.log('OK: совместная папка снова обычная — содержимое на диске, участник потерял доступ');

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
