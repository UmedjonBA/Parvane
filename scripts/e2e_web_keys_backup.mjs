// C1: перенос E2E-ключей. Боб экспортирует ключи (Настройки → Privacy),
// логинится на «новом устройстве» (свежий контекст без IndexedDB) — старая
// sealed-история нечитаема и скрыта; после импорта бэкапа история читается.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  findMessage,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-keys-e2e-password';
const BACKUP_PASSWORD = 'backup-secret-phrase';

async function openPrivacySettings(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Privacy and Security' }).click();
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
// «Новое устройство» Боба — полностью чистый контекст
const bobNewDeviceContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `keys-alice-${suffix}@local`;
  const bob = `keys-bob-${suffix}@local`;
  const secretMessage = `secret-history-${suffix}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);

  // Sealed-история: Алиса пишет Бобу
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, secretMessage);
  await openPrivateChat(bobSession.page, alice);
  await findMessage(bobSession.page, secretMessage).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Экспорт ключей у Боба ──────────────────────────────────────────────────
  bobSession.page.on('dialog', (dialog) => dialog.accept(BACKUP_PASSWORD));
  await openPrivacySettings(bobSession.page);
  const downloadPromise = bobSession.page.waitForEvent('download', { timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'Export E2E Keys' }).click();
  const download = await downloadPromise;
  const backupDir = await mkdtemp(join(tmpdir(), 'parvane-keys-'));
  const backupPath = join(backupDir, 'parvane-e2e-keys.json');
  await download.saveAs(backupPath);
  await bobSession.page.locator('.Notification').filter({ hasText: 'exported' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── «Новое устройство»: история скрыта (ключей нет) ────────────────────────
  const newDevice = await preparePage(bobNewDeviceContext, bob, PASSWORD);
  await newDevice.page.waitForTimeout(4000);
  assert.equal(
    await findMessage(newDevice.page, secretMessage).count(),
    0,
    'sealed history must be unreadable on a fresh device before key import',
  );

  // ── Импорт бэкапа → ресинк → история читается ──────────────────────────────
  newDevice.page.on('dialog', (dialog) => dialog.accept(BACKUP_PASSWORD));
  await openPrivacySettings(newDevice.page);
  const fileChooserPromise = newDevice.page.waitForEvent('filechooser');
  await newDevice.page.getByRole('button', { name: 'Import E2E Keys' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(backupPath);
  await newDevice.page.locator('.Notification').filter({ hasText: 'imported' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Перезапуск после импорта (реальный флоу миграции): импортированные ключи
  // персистентны, история читается после обычного входа
  await newDevice.page.reload({ waitUntil: 'domcontentloaded' });
  const passwordScreen = newDevice.page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await newDevice.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(newDevice.page, alice);
  await findMessage(newDevice.page, secretMessage).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);
  assert.deepEqual(newDevice.errors, [], `New device page errors: ${newDevice.errors.join('; ')}`);

  console.log('OK: экспорт E2E-ключей, свежее устройство не читает sealed, импорт бэкапа возвращает историю');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext], ['newdevice', bobNewDeviceContext]]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}keys-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
