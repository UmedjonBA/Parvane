// Пересылка фото в другой чат: файл в облаке выдан только участникам исходного
// чата, поэтому при пересылке блоб перевыгружается под новым ключом с грантами
// для нового получателя — у него фото должно ЗАГРУЗИТЬСЯ (раньше не грузилось).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  findMessageContainers,
  forwardMessage,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-forward-photo-e2e-password';
// 1×1 PNG — достаточно, чтобы <img> отрисовался (naturalWidth > 0)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function attachPhoto(page, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'e2e-photo.png', mimeType: 'image/png', buffer: PNG });
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

async function expectPhotoLoaded(page, caption, who) {
  const container = findMessageContainers(page, caption).first();
  await container.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const img = container.locator('img').first();
  await img.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForFunction(
    (el) => el && el.complete && el.naturalWidth > 0 && (el.currentSrc || el.src).startsWith('blob:'),
    await img.elementHandle(),
    { timeout: LOGIN_TIMEOUT_MS },
  ).catch(() => {});
  const loaded = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
  assert(loaded, `фото «${caption}» не загрузилось у ${who}`);
}

const browser = await chromium.launch();
const contexts = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
let sessions = [];

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => `fwd-${n}-${suffix}@local`);
  sessions = await Promise.all([
    preparePage(contexts[0], alice, PASSWORD),
    preparePage(contexts[1], bob, PASSWORD),
    preparePage(contexts[2], carol, PASSWORD),
  ]);
  const [a, b, c] = sessions;
  const caption = `fwd-photo-${suffix}`;

  await openPrivateChat(a.page, bob);
  await attachPhoto(a.page, caption);
  await openPrivateChat(b.page, alice);
  await expectPhotoLoaded(b.page, caption, 'Боба (исходный получатель)');
  console.log('OK: фото дошло до исходного получателя');

  // Кэрол знакомится с Бобом (пикер пересылки показывает только существующие чаты)
  await openPrivateChat(c.page, bob);
  await sendText(c.page, `hi-${suffix}`);
  await openPrivateChat(b.page, carol);
  await findMessageContainers(b.page, `hi-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(b.page, alice);

  // Боб пересылает фото Кэрол — она не участник исходного чата
  await forwardMessage(b.page, caption, carol);
  await openPrivateChat(c.page, bob);
  await expectPhotoLoaded(c.page, caption, 'Кэрол (получатель пересылки)');
  console.log('OK: пересланное фото загрузилось у нового получателя');

  // После reload у Кэрол фото тоже грузится (ключи из истории, доступ в облаке)
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await c.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(c.page, bob);
  await expectPhotoLoaded(c.page, caption, 'Кэрол после reload');
  console.log('OK: пересланное фото грузится после reload');

  assertNoPageErrors({ alice: a, bob: b, carol: c });
  console.log('OK: пересылка фото между чатами');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  if (shotDir) await Promise.all(sessions.map((s, i) => s?.page.screenshot({ path: `${shotDir}/forward-photo-${i}.png` }).catch(() => {})));
  throw error;
} finally {
  await browser.close();
}
