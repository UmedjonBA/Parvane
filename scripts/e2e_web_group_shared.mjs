// «Общее в группе» (доска `ZpChat2`): общая папка «Файлов», привязанная к группе записью её журнала. Владелец
// выбирает папку из своих в сведениях группы — участники группы получают приглашение; участник без доступа видит
// строку «нет доступа», после принятия приглашения строка ведёт в папку. Снятие привязки убирает строку у участника.
// Запуск: scripts/run_web_group_shared_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { CLOUD_STEP_TIMEOUT_MS as STEP, cloudDriver } from './e2e_web_cloud_lib.mjs';
import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  exchangeMessages,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-group-shared-1';
const WIDE = { width: 1440, height: 900 };
const SYNC = 45000;
const FOLDER = 'Сборки';
const FILE = 'сборка-ночная.txt';

const browser = await chromium.launch();
const sessions = {};

// Сведения группы в правой колонке
async function openGroupInfo(page, title) {
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  // Название группы есть и в превью приглашения в личном чате — строку чата ищем по её заголовку
  const item = page.locator('#LeftColumn .ListItem').filter({ has: page.locator('.fullName', { hasText: title }) }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('.MiddleHeader').getByText(title).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const right = page.locator('#RightColumn');
  // Панель могла ещё открываться либо закрываться после прежнего шага: щёлкаем по шапке, пока сведения не
  // простоят открытыми полсекунды
  const media = right.locator('[data-group-media]');
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!(await media.isVisible().catch(() => false))) {
      await page.locator('.MiddleHeader .ChatInfo').click();
      await media.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
    }
    await page.waitForTimeout(600);
    if (await media.isVisible().catch(() => false)) return right;
  }
  await media.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return right;
}

try {
  const suffix = Date.now().toString(36);
  const alice = `gs-alice-${suffix}@local`;
  const bob = `gs-bob-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const group = `Linux-чат ${suffix.slice(-4)}`;
  sessions.alice = await preparePage(await browser.newContext({ viewport: WIDE }), alice, PASSWORD);
  sessions.bob = await preparePage(await browser.newContext({ viewport: WIDE }), bob, PASSWORD);
  const a = sessions.alice.page;
  const b = sessions.bob.page;
  await dismissRecoveryKeyDialog(a).catch(() => undefined);
  await dismissRecoveryKeyDialog(b).catch(() => undefined);
  await exchangeMessages(a, alice, b, bob, 'gshared');
  await createGroupViaUi(a, group, [bobName]);
  const ac = cloudDriver(a);
  const bc = cloudDriver(b);

  // ── Алиса заводит общую папку с файлом ─────────────────────────────────────
  await ac.open();
  await ac.add('New shared folder');
  await a.locator('#parvane-cloud-shared-name').fill(FOLDER);
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  const shareDialog = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: FOLDER });
  await shareDialog.waitFor({ state: 'visible', timeout: STEP });
  await shareDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await ac.folderRow(FOLDER).click();
  await ac.upload(FILE, 'ночная сборка 4f1a');

  // ── В сведениях группы у владельца — строки «не выбрано»; у участника их нет ──
  const aInfo = await openGroupInfo(a, group);
  const aFolder = aInfo.locator('[data-group-shared="folder"]');
  await aInfo.locator('[data-group-shared="folder"][data-group-shared-state="none"]').waitFor({ state: 'visible', timeout: STEP });
  await aInfo.locator('[data-group-shared="playlist"][data-group-shared-state="none"]').waitFor({ state: 'visible', timeout: STEP });
  const bInfo = await openGroupInfo(b, group);
  assert.equal(await bInfo.locator('[data-group-shared]').count(), 0, 'у участника без права менять сведения пустых строк нет');

  // ── Владелец привязывает папку: строка с названием и числом файлов ─────────
  await aFolder.click();
  const picker = a.locator('[data-group-shared-picker="folder"]');
  await picker.waitFor({ state: 'visible', timeout: STEP });
  assert.equal(await picker.locator('[data-group-shared-pick="none"]').getAttribute('aria-checked'), 'true');
  await picker.getByText(FOLDER, { exact: true }).click();
  const aOpen = aInfo.locator('[data-group-shared="folder"][data-group-shared-state="open"]');
  await aOpen.waitFor({ state: 'visible', timeout: SYNC });
  await aOpen.getByText(`Folder “${FOLDER}”`).waitFor({ state: 'visible', timeout: STEP });
  await aOpen.getByText('shared folder in Files').waitFor({ state: 'visible', timeout: STEP });
  assert.equal(await aOpen.locator('[data-group-shared-count]').innerText(), '1');
  console.log('OK: владелец привязал общую папку к группе — строка с названием и числом файлов');

  // ── Участник: до принятия приглашения — «нет доступа»; после — строка ведёт в папку ──
  const bNoAccess = bInfo.locator('[data-group-shared="folder"][data-group-shared-state="no-access"]');
  await bNoAccess.waitFor({ state: 'visible', timeout: SYNC });
  await bNoAccess.getByText(/^no access/).waitFor({ state: 'visible', timeout: STEP });
  await bc.open();
  await bc.cloud.locator('[data-virtual="shared"][data-count="1"]').waitFor({ state: 'visible', timeout: SYNC });
  await bc.openShared();
  const inviteRow = bc.folderRow(FOLDER);
  await inviteRow.waitFor({ state: 'visible', timeout: SYNC });
  await inviteRow.getByRole('button', { name: 'Accept', exact: true }).click();
  await bc.item(FILE).waitFor({ state: 'visible', timeout: SYNC });
  await bc.root();
  const bInfo2 = await openGroupInfo(b, group);
  const bOpen = bInfo2.locator('[data-group-shared="folder"][data-group-shared-state="open"]');
  await bOpen.waitFor({ state: 'visible', timeout: SYNC });
  assert.equal(await bOpen.locator('[data-group-shared-count]').innerText(), '1');
  assert.equal(await bOpen.locator('[data-group-shared-change]').count(), 0, 'участник привязку не меняет');
  await bOpen.click();
  await bc.item(FILE).waitFor({ state: 'visible', timeout: SYNC });
  assert.deepEqual(await bc.crumbs(), ['Shared with me', FOLDER], 'строка группы открывает общую папку в «Файлах»');
  console.log('OK: участник принял приглашение — строка группы открывает папку');

  // ── Владелец снимает привязку: у участника строка исчезает, папка остаётся в «Файлах» ──
  const aInfo2 = await openGroupInfo(a, group);
  await aInfo2.locator('[data-group-shared-change="folder"]').click();
  await a.locator('[data-group-shared-picker="folder"] [data-group-shared-pick="none"]').click();
  await aInfo2.locator('[data-group-shared="folder"][data-group-shared-state="none"]').waitFor({ state: 'visible', timeout: SYNC });
  const bInfo3 = await openGroupInfo(b, group);
  await bInfo3.locator('[data-group-shared="folder"]').waitFor({ state: 'detached', timeout: SYNC });
  console.log('OK: привязка снята — строка пропала у участника');

  assertNoPageErrors(sessions);
  console.log('OK: общая папка группы — привязка, приглашение участников, переход в «Файлы», снятие');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  for (const [name, session] of Object.entries(sessions)) {
    if (shotDir) await session.page.screenshot({ path: `${shotDir}/group-shared-${name}.png` }).catch(() => {});
    console.error(`журнал ${name}:\n${session.logs.slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
