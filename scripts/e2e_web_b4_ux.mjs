// B4-хвосты: (1) shared media в профиле пира — вкладки Media/Files/Links
// наполняются реальными сообщениями; (2) честный web-push fallback — без
// серверного пуша тумблер Offline Notifications выключен и помечен
// «Not supported»; (3) мобильный smoke — свежий логин на 375px без
// горизонтального переполнения, чат открывается, композер доступен.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  findMessage,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-b4-e2e-password';

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeInt32BE(zlib.crc32(body) | 0, 0);
  return Buffer.concat([length, body, crc]);
}

function makeSolidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3)]);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

async function attachFile(page, menuItemName, file, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: menuItemName }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(file);
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext({ permissions: ['notifications'] });
const bobContext = await browser.newContext();
const mobileContext = await browser.newContext({
  viewport: { width: 375, height: 720 },
  isMobile: true,
  hasTouch: true,
});

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `b4-alice-${suffix}@local`;
  const bob = `b4-bob-${suffix}@local`;
  const mobileUser = `b4-mobile-${suffix}@local`;
  const photoCaption = `photo-${suffix}`;
  const fileCaption = `doc-${suffix}`;
  const fileName = `notes-${suffix}.txt`;
  const linkText = `link-${suffix}`;

  const fixturesDir = await mkdtemp(join(tmpdir(), 'parvane-b4-'));
  const pngPath = join(fixturesDir, `photo-${suffix}.png`);
  const txtPath = join(fixturesDir, fileName);
  await writeFile(pngPath, makeSolidPng(64, [200, 60, 60]));
  await writeFile(txtPath, `shared media e2e payload ${suffix}\n`);

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  // ── Наполнение shared media: фото, документ, ссылка ────────────────────────
  await attachFile(aliceSession.page, 'Photo or Video', pngPath, photoCaption);
  await findMessage(bobSession.page, photoCaption).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await attachFile(aliceSession.page, 'Document', txtPath, fileCaption);
  await findMessage(bobSession.page, fileCaption).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(aliceSession.page, `${linkText} https://example.com/b4/${suffix}`);
  await findMessage(bobSession.page, linkText).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Профиль пира у получателя: вкладки Media/Files/Links ───────────────────
  await bobSession.page.locator('.MiddleHeader .chat-info-wrapper').click();
  const rightColumn = bobSession.page.locator('#RightColumn');
  await rightColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await rightColumn.locator('.Media').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Табы шаред-медиа — модульные (хэшированные) классы и дубли в Transition:
  // кликаем по точному тексту самого глубокого узла внутри .shared-media-tabs
  const clickSharedMediaTab = (title) => bobSession.page.evaluate((label) => {
    const container = document.querySelector('#RightColumn .shared-media-tabs');
    if (!container) throw new Error('shared-media tabs container not found');
    const target = Array.from(container.querySelectorAll('*')).reverse()
      .find((el) => el.textContent?.trim() === label);
    if (!target) throw new Error(`shared-media tab not found: ${label}`);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, title);

  await clickSharedMediaTab('Files');
  await rightColumn.getByText(fileName).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await clickSharedMediaTab('Links');
  await rightColumn.locator('.WebLink').filter({ hasText: 'example.com' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Честный push-fallback: Offline Notifications выключен и «Not supported»
  await aliceSession.page.getByRole('button', { name: 'Open menu' }).first().click();
  await aliceSession.page.getByRole('menuitem', { name: 'Settings' }).click();
  await aliceSession.page.getByRole('button', { name: 'Notifications' }).click();
  const webRow = aliceSession.page.locator('.Checkbox').filter({ hasText: 'Web Notifications' }).first();
  await webRow.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const offlineRow = aliceSession.page.locator('.Checkbox').filter({ hasText: 'Offline Notifications' }).first();
  await offlineRow.getByText('Not supported').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await offlineRow.locator('input').isDisabled(), true, 'offline push toggle must be disabled');
  assert.equal(await offlineRow.locator('input').isChecked(), false, 'offline push toggle must be off');

  // ── Push-шард: VAPID-ключ отдаётся, регистрация требует валидный JWT ───────
  if (process.env.PARVANE_E2E_NATS_URL) {
    const natsReq = (subject, payload) => JSON.parse(execFileSync('nats', [
      'req', subject, payload, '--server', process.env.PARVANE_E2E_NATS_URL, '--raw',
    ], { encoding: 'utf8' }));
    const vapid = natsReq('push.vapid.get', '{}');
    assert.equal(vapid.ok, true, 'push shard must serve the VAPID key');
    assert.ok(vapid.public_key?.length > 40, 'VAPID public key looks too short');
    const badRegister = natsReq('push.device.register', JSON.stringify({
      token: 'invalid-jwt',
      subscription: { endpoint: 'https://example.com/ep', keys: { p256dh: 'x', auth: 'y' } },
    }));
    assert.equal(badRegister.ok, false, 'push register must reject an invalid JWT');
  }

  // ── Мобильный smoke: 375px, без горизонтального скролла, чат открывается ───
  const mobileSession = await preparePage(mobileContext, mobileUser, PASSWORD);
  const hasOverflow = await mobileSession.page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(hasOverflow, false, 'mobile layout must not overflow horizontally');
  await openPrivateChat(mobileSession.page, alice);
  await sendText(mobileSession.page, `mobile-${suffix}`);
  await findMessage(mobileSession.page, `mobile-${suffix}`).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);
  assert.deepEqual(mobileSession.errors, [], `Mobile page errors: ${mobileSession.errors.join('; ')}`);

  console.log('OK: shared media профиль (Media/Files/Links), честный push-fallback, мобильный smoke без переполнения');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext], ['mobile', mobileContext]]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}b4-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
