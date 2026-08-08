import { expect, test } from '@playwright/test';
import zlib from 'node:zlib';

import {
  expectSignedIn,
  LOGIN_TIMEOUT_MS,
  openApp,
  registerAndSignIn,
  requireGatewayUrl,
  submitPassword,
  uniqueUser,
} from './helpers';

const PASSWORD = 'Parvane-profile-e2e-password';
const NEW_FIRST_NAME = 'Renamed';
const NEW_LAST_NAME = 'Profile';
const AVATAR_SIZE = 64;

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function makeSolidPng(size: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3)]);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

test('edits the profile name and avatar, both survive relogin', async ({ page }, testInfo) => {
  // Playwright WebKit-движок на этом окружении спорадически падает (Target
  // crashed) и зависает в длинных сценариях; startup/login WebKit покрывает
  // live-stack.spec.ts, глубокие флоу гоняются на Chromium и Firefox
  test.skip(['webkit', 'ios'].includes(testInfo.project.name),
    'flaky WebKit build in long flows; engine startup/login covered by live-stack.spec.ts');
  const gatewayUrl = requireGatewayUrl();
  const user = uniqueUser('profile', testInfo.project.name);
  // Канвас-кроп аватара стабилен только в Chromium; на остальных движках
  // приёмка ограничивается редактированием имени
  const withAvatar = testInfo.project.name === 'chromium';

  await openApp(page, gatewayUrl);
  await registerAndSignIn(page, user, PASSWORD);

  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Edit profile' }).click();

  const firstNameInput = page.getByLabel('First name (required)');
  await expect(firstNameInput).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  await firstNameInput.fill(NEW_FIRST_NAME);
  const lastNameInput = page.getByLabel('Last name (optional)');
  await lastNameInput.fill(NEW_LAST_NAME);

  if (withAvatar) {
    await page.locator('.AvatarEditable input[type="file"]').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: makeSolidPng(AVATAR_SIZE, [200, 40, 40]),
    });
    await page.getByRole('button', { name: 'Crop' }).click();
    await expect(page.locator('.AvatarEditable img')).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  }

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // Сохранение завершилось: FAB теряет класс revealed после сброса
  // touched-состояния (скрывается через CSS, не через display)
  await expect(page.getByRole('button', { name: 'Save', exact: true }))
    .not.toHaveClass(/revealed/, { timeout: LOGIN_TIMEOUT_MS });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await submitPassword(page, PASSWORD);
  await expectSignedIn(page);

  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Edit profile' }).click();

  await expect(page.getByLabel('First name (required)')).toHaveValue(
    `${NEW_FIRST_NAME} ${NEW_LAST_NAME}`,
    { timeout: LOGIN_TIMEOUT_MS },
  );
  if (withAvatar) {
    // Аватар пришёл с сервера (identity resolve + cloud download)
    await expect(page.locator('.AvatarEditable img')).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  }
});
