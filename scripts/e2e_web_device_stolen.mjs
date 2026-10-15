// ENG-04 (ревью 7 окт 2026): второе устройство bob выходит из аккаунта само; на первом в «Устройствах»
// оно видно в «Signed-out devices», его можно отметить украденным — после этого ключ подписи устройств
// считается раскрытым и экран предлагает его сменить по ключу восстановления.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  dumpDiagJournal,
  expectToast,
  LOGIN_TIMEOUT_MS,
  linkSecondDevice,
  logOut,
  openProfile,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-stolen-e2e-password';
// Экран «Устройства» перечитывает журнал своих устройств раз в несколько секунд
const LEFT_DEVICE_TIMEOUT_MS = 45000;

const browser = await chromium.launch();
const device1Context = await browser.newContext();
const device2Context = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const bob = `ds-bob-${suffix}@local`;
  const device1 = await preparePage(device1Context, bob, PASSWORD);
  const device2 = await preparePage(device2Context, bob, PASSWORD);
  await linkSecondDevice(device1.page, device2.page);

  // Второе устройство выходит само (запись выхода в журнале — своей подписью)
  await logOut(device2.page);

  await openProfile(device1.page);
  await device1.page.getByRole('button', { name: 'Devices' }).click();
  const screen = device1.page.locator('.SettingsActiveSessions');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const left = screen.locator('[data-left-device]');
  await left.first().waitFor({ state: 'visible', timeout: LEFT_DEVICE_TIMEOUT_MS });
  assert.equal(await left.count(), 1, 'одно вышедшее устройство');
  // Обычный выход ключ подписи не раскрывает
  assert.equal(await screen.getByText('Device signing key', { exact: true }).count(), 0, 'смена ключа не нужна');

  await left.first().click();
  await device1.page.locator('.Modal').getByRole('button', { name: 'This device was stolen' }).click();
  await expectToast(device1.page, 'Device marked as stolen');
  await screen.getByText('Device signing key', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await left.first().waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  assertNoPageErrors({ 'bob-device-1': device1 });
  console.log('OK: вышедшее устройство видно в «Signed-out devices», отметка «украдено» требует смены ключа подписи устройств');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['bob-dev1', device1Context], ['bob-dev2', device2Context]]) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: `${dir}device-stolen-${name}.png` }).catch(() => {});
      await dumpDiagJournal(page, name, 60);
    }
  }
  throw err;
} finally {
  await browser.close();
}
