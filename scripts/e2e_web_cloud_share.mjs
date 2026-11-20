// Совместные папки облака (spec 016, US6): владелец создаёт папку и зовёт
// участника читателем — тот получает сообщение-приглашение, принимает его
// строкой вверху списка раздела, папка появляется в «Доступных мне», он видит и
// скачивает файлы, но менять не может; поиск идёт по всем папкам; редактор загружает и
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
// Доступ к одиночному файлу копией (CLOUD-3)
const SHARED_FILE = 'регламент-обновлений.md';
const SHARED_TEXT = 'Регламент обновлений c42d';

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
    const words = [FOLDER, CONTENT, 'план.txt', 'от Боба', ARCHIVE, 'отчёт.txt', 'глубоко', SHARED_FILE, SHARED_TEXT];
    return { grants, leaks: words.filter((w) => texts.some((t) => t.includes(w))) };
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
  const aliceName = alice.split('@')[0];
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
  // Пока Боб не принял приглашение, он у Алисы — в «Приглашениях · ждёт ответа» с «Отменить» (сервер владельца)
  const invited = shareDialog.locator(`[data-invited="${bob}"]`);
  // Бобу — к чату с Алисой из любого раздела (карточка приглашения — в переписке)
  const openBobChat = async () => {
    await b.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
    await openPrivateChatStrict(b, alice);
  };

  const invite = async (role) => {
    await shareDialog.locator('select[data-new-role]').selectOption({ label: role });
    await shareDialog.getByRole('button', { name: 'Add people', exact: true }).click();
    const picker = a.locator('.Modal').filter({ has: a.locator('.ChatOrUserPicker-item') });
    await picker.locator('.ChatOrUserPicker-item').filter({ hasText: bobName }).first().click();
    await invited.waitFor({ state: 'visible', timeout: STEP });
  };

  // ── Алиса создаёт совместную папку, кладёт файл, зовёт Боба читателем ─────
  await ac.open();
  await ac.add('New shared folder');
  await a.locator('#parvane-cloud-shared-name').fill(FOLDER);
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  await shareDialog.waitFor({ state: 'visible', timeout: STEP });
  await shareDialog.getByText('Only you have access so far').waitFor({ state: 'visible', timeout: STEP });
  await invite('Reader');
  assert.equal(await invited.getAttribute('data-role'), 'reader');
  await invited.getByText('waiting for an answer · Reader').waitFor({ state: 'visible' });
  await invited.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await member.count(), 0, 'не принявший — не участник');
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await ac.folderRow(FOLDER).click();
  await ac.upload('план.txt', CONTENT);
  console.log('OK: совместная папка создана, участник приглашён читателем');

  // ── Боб получает приглашение карточкой в чате и принимает его в разделе ──
  await openPrivateChatStrict(b, alice);
  const firstCard = b.locator(`[data-cloud-invite="${FOLDER}"]`);
  await firstCard.waitFor({ state: 'visible', timeout: SYNC });
  await firstCard.getByText('Folder invite · Reader').waitFor({ state: 'visible' });
  await firstCard.getByRole('button', { name: 'Accept', exact: true }).waitFor({ state: 'visible', timeout: SYNC });
  await firstCard.getByRole('button', { name: 'Decline', exact: true }).waitFor({ state: 'visible' });
  await bc.open();
  // Приглашение — карточкой в «Доступных мне», ответ прямо в ней; в колонке мест — счётчик
  await bc.cloud.locator('[data-virtual="shared"][data-count="1"]').waitFor({ state: 'visible', timeout: SYNC });
  await bc.openShared();
  const inviteRow = bc.folderRow(FOLDER);
  await inviteRow.waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await inviteRow.getAttribute('data-container-kind'), 'invite', 'до принятия — приглашение');
  await inviteRow.getByText(`${aliceName} invites you to “${FOLDER}”`).waitFor({ state: 'visible' });
  await inviteRow.getByRole('button', { name: 'Decline', exact: true }).waitFor({ state: 'visible' });
  assert.equal(
    await bc.cloud.locator('[role="list"] > [role="listitem"]').first().getAttribute('data-container-kind'), 'invite',
    'приглашение стоит первой строкой',
  );
  await inviteRow.getByRole('button', { name: 'Accept', exact: true }).click();
  await bc.item('план.txt').waitFor({ state: 'visible', timeout: SYNC });
  assert.deepEqual(await bc.crumbs(), ['Shared with me', FOLDER], 'принятая папка лежит в «Доступных мне»');
  await bc.root();
  assert.equal(await bc.folderRow(FOLDER).count(), 0, 'чужой папки в диске нет');
  assert.equal(await bc.virtual('shared').getAttribute('data-count'), '1');
  await bc.openShared();
  assert.deepEqual(await bc.crumbs(), ['Shared with me']);
  assert.equal(await bc.folderRow(FOLDER).getAttribute('data-container-kind'), 'shared', 'после принятия — чужая папка');
  assert.equal(await bc.hasFolderMenuAction(FOLDER, 'Leave folder'), true, '«Покинуть папку» — в меню строки');
  await bc.folderRow(FOLDER).click();
  await bc.item('план.txt').waitFor({ state: 'visible', timeout: STEP });
  assert.equal((await bc.download('план.txt')).toString(), CONTENT, 'читатель скачивает файл');
  // Читатель: ни загрузки, ни переименования, ни удаления
  assert.equal(await bc.cloud.getByRole('button', { name: 'Upload', exact: true }).count(), 0, 'у читателя нет загрузки');
  assert.equal(await bc.hasMenuAction('план.txt', 'Rename'), false, 'у читателя нет переименования');
  assert.equal(await bc.hasMenuAction('план.txt', 'Move to trash'), false, 'у читателя нет удаления');
  assert.deepEqual(serverView().grants, ['bob:1'], 'сервер знает состав и уровень чтения');
  // Алиса видит, что приглашение принято: Боб — участник, «Приглашений» больше нет
  await ac.cloud.locator('[data-share-banner="owned"]').click();
  await member.waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await invited.count(), 0, 'принятое приглашение ушло из «Приглашений»');
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  console.log('OK: приглашение сообщением, принятие, читатель смотрит и скачивает, но не меняет');

  // ── Редактор: загрузка Боба видна Алисе ───────────────────────────────────
  await ac.cloud.locator('[data-share-banner="owned"]').click();
  await member.locator('select').selectOption({ label: 'Editor' });
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
  await ac.cloud.locator('[data-share-banner="owned"]').click();
  await member.locator('select').selectOption({ label: 'Reader' });
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
  await ac.cloud.locator('[data-share-banner="owned"]').click();
  await member.getByRole('button', { name: 'Remove' }).click();
  await member.waitFor({ state: 'detached', timeout: STEP });
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await ac.upload('после удаления.txt', 'только для владельца');
  await bc.cloud.getByText('No one has shared a folder with you yet').waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await bc.item('после удаления.txt').count(), 0);
  await waitFor(() => Promise.resolve(serverView().grants), (g) => g.length === 0, 'грант не снят на сервере');
  console.log('OK: удалённый участник теряет папку и не получает новое');

  // ── Вторая папка: Боб редактор и уходит сам ───────────────────────────────
  await ac.root();
  await ac.add('New shared folder');
  await a.locator('#parvane-cloud-shared-name').fill('Фото');
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  const second = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: 'Фото' });
  await second.waitFor({ state: 'visible', timeout: STEP });
  await second.locator('select[data-new-role]').selectOption({ label: 'Editor' });
  await second.getByRole('button', { name: 'Add people', exact: true }).click();
  await a.locator('.Modal .ChatOrUserPicker-item').filter({ hasText: bobName }).first().click();
  await second.locator(`[data-invited="${bob}"]`).waitFor({ state: 'visible', timeout: STEP });
  // Боб принимает карточкой в чате: владелец видит его участником, карточка ведёт в «Файлы»
  await openBobChat();
  const photoCard = b.locator('[data-cloud-invite="Фото"]');
  await photoCard.getByText('Folder invite · Editor').waitFor({ state: 'visible', timeout: SYNC });
  await photoCard.getByRole('button', { name: 'Accept', exact: true }).click();
  await photoCard.getByRole('button', { name: 'In Files · open', exact: true }).waitFor({ state: 'visible', timeout: SYNC });
  await second.locator(`[data-member="${bob}"]`).waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await second.locator(`[data-invited="${bob}"]`).count(), 0, 'принятое карточкой — не в «Приглашениях»');
  await photoCard.getByRole('button', { name: 'In Files · open', exact: true }).click();
  await bc.cloud.locator('nav').getByRole('button', { name: 'Фото', exact: true }).waitFor({ state: 'visible', timeout: SYNC });
  // «Покинуть папку» — в меню «⋯» строки «Доступных мне»
  await bc.root();
  await bc.openShared();
  await bc.folderMenu('Фото', 'Leave folder');
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
  const toMyFiles = () => ac.root();
  const moveTo = async (name, placeName) => {
    await ac.menu(name, 'Move');
    // Дерево назначения показывает сразу все места: личный диск («Cloud») и совместные папки
    const dialog = a.locator('.Modal .modal-dialog').filter({ hasText: 'Move here' });
    await dialog.locator(`[data-place-id][role="listitem"]`).filter({ hasText: placeName }).click();
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
  await ac.menu(ARCHIVE, 'Share');
  await a.locator('.Modal').getByRole('button', { name: 'Make shared', exact: true }).click();
  // Окно подтверждения закрывается с анимацией и до конца держит фокус у себя: поле ника — после него
  await a.locator('.Modal').filter({ has: a.getByRole('button', { name: 'Make shared', exact: true }) })
    .waitFor({ state: 'detached', timeout: SYNC });
  const archiveDialog = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: ARCHIVE });
  await archiveDialog.waitFor({ state: 'visible', timeout: SYNC });
  await archiveDialog.locator('select[data-new-role]').selectOption({ label: 'Reader' });
  // Приглашение по нику (доска `PhFilesMore`): неизвестный ник — ошибка в окне, известный — участник
  const nickInput = archiveDialog.locator('[data-share-nick] input');
  assert.equal((await archiveDialog.locator('[data-share-nick-submit]').innerText()).trim(), 'From contacts');
  await nickInput.fill('@no-such-person-e2e');
  await nickInput.press('Enter');
  await archiveDialog.locator('[data-share-nick] [role="alert"]').waitFor({ state: 'visible', timeout: SYNC });
  await nickInput.fill(`@${bob.split('@')[0]}`);
  assert.equal((await archiveDialog.locator('[data-share-nick-submit]').innerText()).trim(), 'Invite');
  await nickInput.press('Enter');
  const archiveInvited = archiveDialog.locator(`[data-invited="${bob}"]`);
  await archiveInvited.waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await nickInput.inputValue(), '', 'поле ника очищено после приглашения');
  await archiveDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  assert.equal(await ac.item(ARCHIVE).count(), 0, 'обычной папки на диске больше нет');
  assert.equal(await ac.folderRow(ARCHIVE).getAttribute('data-container-kind'), 'owned', 'папка стала совместной');
  await ac.folderRow(ARCHIVE).click();
  assert.equal((await ac.download('отчёт.txt')).toString(), 'данные архива', 'файл папки цел у владельца');
  await bc.root();
  await bc.openShared();
  const archiveInvite = bc.folderRow(ARCHIVE);
  await archiveInvite.waitFor({ state: 'visible', timeout: SYNC });
  await archiveInvite.getByRole('button', { name: 'Accept', exact: true }).click();
  await bc.item('отчёт.txt').waitFor({ state: 'visible', timeout: SYNC });
  await bc.item('Вложенная').click();
  assert.equal((await bc.download('глубоко.txt')).toString(), 'файл в глубине', 'участник читает вложенный файл');
  await bc.cloud.locator('nav').getByRole('button', { name: ARCHIVE }).click();
  // Поиск идёт по всем папкам: участник находит файл чужой папки, владелец — своей совместной
  const bobSearch = bc.cloud.getByRole('searchbox');
  await bobSearch.fill('глубоко');
  await bc.item('глубоко.txt').getByText(`Shared with me / ${ARCHIVE} / Вложенная`).waitFor({ state: 'visible', timeout: STEP });
  await bobSearch.fill('');
  await bc.item('отчёт.txt').waitFor({ state: 'visible', timeout: STEP });
  console.log('OK: обычная папка стала совместной вместе с вложенным, участник читает файлы');

  // ── Перенос между личным диском и совместной папкой в обе стороны ─────────
  await toMyFiles();
  await ac.upload('личный.txt', 'с личного диска');
  const aliceSearch = ac.cloud.getByRole('searchbox');
  await aliceSearch.fill('.txt');
  await ac.item('глубоко.txt').getByText(`My drive / ${ARCHIVE} / Вложенная`).waitFor({ state: 'visible', timeout: STEP });
  await ac.item('личный.txt').getByText('My drive', { exact: true }).waitFor({ state: 'visible' });
  const found = await ac.names();
  for (const name of ['глубоко.txt', 'личный.txt', 'отчёт.txt', 'план.txt']) {
    assert.ok(found.includes(name), `поиск по всем папкам должен найти ${name}: ${found.join(', ')}`);
  }
  await aliceSearch.fill('');
  await ac.item('личный.txt').waitFor({ state: 'visible', timeout: STEP });
  // Вторая версия файла (CLOUD-3): перенос уносит историю — обе версии копиями блобов
  await a.evaluate(async (node) => {
    const state = await window.__parvaneDiagCallApi('parvaneCloudState');
    const done = await window.__parvaneDiagCallApi('parvaneCloudWriteText', {
      container: state.rootId, node, name: 'личный.txt', text: 'вторая версия', mime: 'text/plain',
    });
    if (!done?.ok) throw new Error(`версия не записана: ${JSON.stringify(done)}`);
  }, await ac.item('личный.txt').getAttribute('data-node-id'));
  const versionRows = a.locator('[data-cloud-versions] [data-version]');
  const expectVersions = async (what) => {
    await ac.menu('личный.txt', 'Version history');
    await a.waitForFunction(
      () => document.querySelectorAll('[data-cloud-versions] [data-version]').length === 2, undefined, { timeout: SYNC },
    ).catch(() => assert.fail(what));
    await versionRows.nth(1).locator('[data-version-open]').click();
    await a.locator('[data-cloud-versions] [data-version-text]').getByText('с личного диска')
      .waitFor({ state: 'visible', timeout: STEP });
    await a.keyboard.press('Escape');
    await a.locator('[data-cloud-versions]').waitFor({ state: 'hidden', timeout: STEP });
  };
  await expectVersions('у файла личного диска нет двух версий');
  await moveTo('личный.txt', ARCHIVE);
  await bc.item('личный.txt').waitFor({ state: 'visible', timeout: SYNC });
  assert.equal((await bc.download('личный.txt')).toString(), 'вторая версия', 'участник читает перенесённый файл');
  await ac.folderRow(ARCHIVE).click();
  await ac.item('личный.txt').waitFor({ state: 'visible', timeout: STEP });
  await expectVersions('перенос в совместную папку потерял историю версий');
  await moveTo('отчёт.txt', 'My drive');
  await bc.item('отчёт.txt').waitFor({ state: 'detached', timeout: SYNC });
  await toMyFiles();
  assert.equal((await ac.download('отчёт.txt')).toString(), 'данные архива', 'файл вернулся на личный диск целым');
  // Три файла, у одного две версии, — четыре блоба: копии источника стёрты
  await waitFor(
    () => Promise.resolve(driveBlobs(alice) - blobsBefore), (n) => n === 4, 'после переноса остались лишние блобы',
  );
  console.log('OK: перенос между личным диском и совместной папкой в обе стороны с историей версий, лишних блобов нет');

  // ── Совместная папка снова становится обычной: содержимое на диске, участник теряет доступ ──
  await ac.folderRow(ARCHIVE).getByRole('button', { name: 'Sharing', exact: true }).click();
  await archiveDialog.getByRole('button', { name: 'Make private', exact: true }).click();
  await a.locator('.Modal').filter({ hasText: 'becomes a regular folder' })
    .getByRole('button', { name: 'Make private', exact: true }).click();
  await ac.item(ARCHIVE).waitFor({ state: 'visible', timeout: SYNC });
  await ac.folderRow(ARCHIVE).waitFor({ state: 'detached', timeout: SYNC });
  await ac.item(ARCHIVE).click();
  assert.equal((await ac.download('личный.txt')).toString(), 'вторая версия', 'файл на месте в обычной папке');
  await expectVersions('закрытие доступа к папке потеряло историю версий');
  await ac.item('Вложенная').click();
  assert.equal((await ac.download('глубоко.txt')).toString(), 'файл в глубине', 'вложенный файл на месте');
  await toMyFiles();
  await bc.cloud.getByText('No one has shared a folder with you yet').waitFor({ state: 'visible', timeout: SYNC });
  await waitFor(() => Promise.resolve(serverView().grants), (g) => g.length === 0, 'грант не снят после закрытия доступа');
  // Версия «личного» переехала вместе с ним: блобов по-прежнему четыре
  await waitFor(
    () => Promise.resolve(driveBlobs(alice) - blobsBefore), (n) => n === 4, 'после закрытия доступа остались лишние блобы',
  );
  console.log('OK: совместная папка снова обычная — содержимое на диске, участник потерял доступ');

  // ── «Отклонить» в карточке чата: у владельца приглашение уходит, грант снят ──
  await ac.root();
  await ac.add('New shared folder');
  await a.locator('#parvane-cloud-shared-name').fill('Отказ');
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  const declineDialog = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: 'Отказ' });
  await declineDialog.locator('[data-share-nick] input').waitFor({ state: 'visible', timeout: SYNC });
  await declineDialog.locator('[data-share-nick] input').fill(`@${bob.split('@')[0]}`);
  await declineDialog.locator('[data-share-nick] input').press('Enter');
  const declineInvited = declineDialog.locator(`[data-invited="${bob}"]`);
  await declineInvited.waitFor({ state: 'visible', timeout: SYNC });
  await openBobChat();
  const declineCard = b.locator('[data-cloud-invite="Отказ"]');
  await declineCard.getByRole('button', { name: 'Decline', exact: true }).click({ timeout: SYNC });
  await declineCard.getByRole('button', { name: 'Accept', exact: true }).waitFor({ state: 'detached', timeout: SYNC });
  await declineInvited.waitFor({ state: 'detached', timeout: SYNC });
  await waitFor(() => Promise.resolve(serverView().grants), (g) => g.length === 0, 'отклонённое приглашение осталось на сервере');
  // Пригласить снова после отказа: приглашение доходит с названием папки (ключ нового гранта принят)
  await declineDialog.locator('[data-share-nick] input').fill(`@${bob.split('@')[0]}`);
  await declineDialog.locator('[data-share-nick] input').press('Enter');
  await declineInvited.waitFor({ state: 'visible', timeout: SYNC });
  await declineDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await bc.open();
  await bc.root();
  await bc.openShared();
  await bc.folderRow('Отказ').waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await bc.folderRow('Отказ').getAttribute('data-container-kind'), 'invite', 'приглашение после отказа дошло');
  await bc.folderRow('Отказ').getByRole('button', { name: 'Decline', exact: true }).click();
  await bc.folderRow('Отказ').waitFor({ state: 'detached', timeout: SYNC });
  await waitFor(() => Promise.resolve(serverView().grants), (g) => g.length === 0, 'второй отказ не снял грант');
  console.log('OK: приглашение отклонено карточкой в чате, у владельца оно ушло; новое приглашение после отказа доходит');

  // ── «Отменить» ждущее ответа приглашение: грант снят, у получателя приглашения нет ──
  await ac.root();
  await ac.add('New shared folder');
  await a.locator('#parvane-cloud-shared-name').fill('Отмена');
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  const cancelDialog = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: 'Отмена' });
  await cancelDialog.locator('[data-share-nick] input').waitFor({ state: 'visible', timeout: SYNC });
  await cancelDialog.locator('[data-share-nick] input').fill(`@${bob.split('@')[0]}`);
  await cancelDialog.locator('[data-share-nick] input').press('Enter');
  const cancelInvited = cancelDialog.locator(`[data-invited="${bob}"]`);
  await cancelInvited.waitFor({ state: 'visible', timeout: SYNC });
  await cancelInvited.getByRole('button', { name: 'Cancel', exact: true }).click();
  await cancelInvited.waitFor({ state: 'detached', timeout: SYNC });
  await waitFor(() => Promise.resolve(serverView().grants), (g) => g.length === 0, 'отменённое приглашение осталось на сервере');
  // Пригласить снова сразу после отмены: новое приглашение доходит
  await cancelDialog.locator('[data-share-nick] input').fill(`@${bob.split('@')[0]}`);
  await cancelDialog.locator('[data-share-nick] input').press('Enter');
  await cancelInvited.waitFor({ state: 'visible', timeout: SYNC });
  await cancelDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await bc.open();
  await bc.root();
  await bc.openShared();
  await bc.folderRow('Отмена').waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await bc.folderRow('Отмена').getAttribute('data-container-kind'), 'invite', 'повторное приглашение дошло');
  console.log('OK: ждущее ответа приглашение отменено владельцем; новое приглашение после отмены доходит');

  // ── Доступ к одиночному файлу копией (CLOUD-3): у Боба копия в «Доступных мне» → «Файлы», у Алисы файл на месте ──
  await ac.open();
  await ac.root();
  await ac.upload(SHARED_FILE, SHARED_TEXT, 'text/markdown');
  const bobBlobsBefore = driveBlobs(bob);
  await ac.menu(SHARED_FILE, 'Share with people…');
  const copyForm = a.locator('[data-share-copy]');
  await copyForm.locator('input').waitFor({ state: 'visible', timeout: STEP });
  await copyForm.locator('input').fill(`@${bobName}`);
  await copyForm.locator('input').press('Enter');
  await copyForm.waitFor({ state: 'detached', timeout: SYNC });
  await bc.open();
  await bc.openShared();
  await bc.cloud.locator('[data-shared-files]').waitFor({ state: 'visible', timeout: SYNC });
  await bc.item(SHARED_FILE).waitFor({ state: 'visible', timeout: SYNC });
  assert.match(await bc.item(SHARED_FILE).innerText(), new RegExp(aliceName), 'в строке копии нет отправителя');
  assert.equal((await bc.download(SHARED_FILE)).toString(), SHARED_TEXT, 'копия у Боба с другим содержимым');
  assert.ok(driveBlobs(bob) > bobBlobsBefore, 'копия не легла в квоту Боба');
  await bc.root();
  assert.ok(!(await bc.names()).includes(SHARED_FILE), 'копия видна и в корне «Моего диска»');
  // У Алисы файл остаётся на месте, общей папки не появилось
  await ac.item(SHARED_FILE).waitFor({ state: 'visible', timeout: STEP });
  assert.equal(await ac.folderRow(SHARED_FILE).count(), 0, 'файл ушёл в общую папку');
  // Боб кладёт копию в корзину — она уходит из «Доступных мне», у Алисы файл остаётся
  await bc.openShared();
  await bc.menu(SHARED_FILE, 'Move to trash');
  await bc.item(SHARED_FILE).waitFor({ state: 'detached', timeout: SYNC });
  await ac.item(SHARED_FILE).waitFor({ state: 'visible', timeout: STEP });
  console.log('OK: файл отдан копией — у получателя в «Доступных мне», у владельца на месте');

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
