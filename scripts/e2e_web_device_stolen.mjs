// «Устройство украдено» (ENG-04, ревью 7 окт 2026; мастер — доски `ZdProfileY`, `RpProfileC`, spec 041).
// 1) Второе устройство bob выходит само; на первом оно в списке с «Украдено» — мастер (шаг «Отметить украденным»,
//    смена пароля пропущена) отзывает его своей рукой, ключ подписи устройств меняется сам (корень на устройстве).
// 2) Третье устройство живо; «Украдено» у его строки: мастер завершает сеанс со сменой ключей (пароль), затем окно
//    «Сменить пароль» и новый ключ восстановления. Третье устройство показывает «Это устройство вышло из аккаунта»,
//    вход прежним паролем на нём не проходит.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  expectToast,
  LOGIN_TIMEOUT_MS,
  linkSecondDevice,
  logOut,
  openProfile,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-stolen-e2e-password';
const NEW_PASSWORD = 'Parvane-stolen-e2e-password-2';
// Экран «Устройства» перечитывает журнал своих устройств раз в несколько секунд
const LEFT_DEVICE_TIMEOUT_MS = 45000;
const SIGNED_OUT_TIMEOUT_MS = 60000;

const browser = await chromium.launch();
const device1Context = await browser.newContext();
const device2Context = await browser.newContext();
const device3Context = await browser.newContext();

async function openDevices(page) {
  await openProfile(page);
  await page.locator('[data-profile-item="devices"]:visible').click();
  const screen = page.locator('.SettingsActiveSessions');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return screen;
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const bob = `ds-bob-${suffix}@local`;
  const device1 = await preparePage(device1Context, bob, PASSWORD);
  const device2 = await preparePage(device2Context, bob, PASSWORD);
  await linkSecondDevice(device1.page, device2.page);

  // ── 1. Вышедшее само устройство ──
  await logOut(device2.page);
  let screen = await openDevices(device1.page);
  const left = screen.locator('[data-left-device]');
  await left.first().waitFor({ state: 'visible', timeout: LEFT_DEVICE_TIMEOUT_MS });
  assert.equal(await left.count(), 1, 'одно вышедшее устройство');
  // Обычный выход ключ подписи не раскрывает
  assert.equal(await screen.getByText('Device signing key', { exact: true }).count(), 0, 'смена ключа не нужна');

  await left.first().click();
  let wizard = device1.page.locator('[data-stolen-wizard]');
  await wizard.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Кадр мастера для сверки с доской `ZdProfileY` (смена ширины через границу телефона закрыла бы окно)
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await device1.page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/stolen-desk.png` });
  }
  assert.match(await wizard.innerText(), /Mark «.+» as stolen/, 'шаг 1 вышедшего — отметка украденным');
  assert.equal(await wizard.locator('[data-stolen-password]').count(), 0, 'пароль для отметки не нужен');
  assert.equal(await wizard.locator('[data-stolen-sign-out-only]').count(), 0, '«Просто выйти» вышедшему не нужно');
  await wizard.locator('[data-stolen-step="password"]').uncheck();
  await wizard.locator('[data-stolen-submit]').click();
  await expectToast(device1.page, 'its keys are changed');
  await left.first().waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  // Корень аккаунта хранится на этом устройстве (здесь аккаунт создан): ключ подписи устройств меняется сразу,
  // просьбы сменить его с вводом ключа восстановления нет
  await device1.page.waitForTimeout(3000);
  assert.equal(await screen.getByText('Device signing key', { exact: true }).count(), 0, 'смена ключа подписи не прошла сама');
  assert.equal(await device1.page.locator('[data-password-form]').count(), 0, 'шаг пароля пропущен');

  // ── 2. Живой сеанс третьего устройства ──
  const device3 = await preparePage(device3Context, bob, PASSWORD);
  await linkSecondDevice(device1.page, device3.page);
  screen = await openDevices(device1.page);
  const stolen = screen.locator('[data-session-stolen]');
  await stolen.first().waitFor({ state: 'visible', timeout: LEFT_DEVICE_TIMEOUT_MS });
  assert.equal(await stolen.count(), 1, '«Украдено» у живого сеанса другого устройства');
  assert.equal(
    await screen.locator('[data-session-current] [data-session-stolen]').count(), 0, 'у этого устройства «Украдено» нет',
  );
  await stolen.first().click();
  wizard = device1.page.locator('[data-stolen-wizard]');
  await wizard.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await wizard.locator('[data-stolen-step="signOut"]').isChecked(), true);
  assert.equal(await wizard.locator('[data-stolen-step="password"]').isChecked(), true);
  assert.equal(await wizard.locator('[data-stolen-step="key"]').isChecked(), false, 'новый ключ — по желанию');
  assert.equal(await wizard.locator('[data-stolen-submit]').isDisabled(), true, 'без пароля не завершить');
  // Корень на устройстве — поля ключа восстановления нет
  assert.equal(await wizard.locator('[data-stolen-recovery-key]').count(), 0);
  await wizard.locator('[data-stolen-step="key"]').check();
  // Неверный пароль — окно остаётся с ошибкой
  await wizard.locator('[data-stolen-password]').fill(`${PASSWORD}-wrong`);
  await wizard.locator('[data-stolen-submit]').click();
  await wizard.locator('[data-stolen-error]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await wizard.locator('[data-stolen-password]').fill(PASSWORD);
  await wizard.locator('[data-stolen-submit]').click();
  await expectToast(device1.page, 'its keys are changed');

  // Шаг 2 — окно «Сменить пароль»
  const passwordForm = device1.page.locator('[data-password-form]');
  await passwordForm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordForm.locator('[data-password-field="old"]').fill(PASSWORD);
  await passwordForm.locator('[data-password-field="new"]').fill(NEW_PASSWORD);
  await passwordForm.locator('[data-password-field="repeat"]').fill(NEW_PASSWORD);
  await device1.page.locator('.Modal').getByRole('button', { name: 'Change password', exact: true }).click();
  await passwordForm.waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // Шаг 3 — новый ключ восстановления (корень на устройстве: спрашивается пароль аккаунта — уже новый)
  const renewPassword = device1.page.locator('[data-renew-password]');
  await renewPassword.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await renewPassword.fill(NEW_PASSWORD);
  await device1.page.locator('.Modal').getByRole('button', { name: 'Create new key', exact: true }).click();
  // Экран нового ключа закрывает обработчик хелперов сам — сверяем по журналу провайдера
  await dismissRecoveryKeyDialog(device1.page, 5000);
  const renewDeadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (!device1.logs.some((line) => line.includes('ключ восстановления заменён новым'))) {
    assert(Date.now() < renewDeadline, 'новый ключ восстановления не выпущен');
    await device1.page.waitForTimeout(300);
  }

  // Третье устройство отключено: на нём — «Это устройство вышло из аккаунта»
  await screen.locator('[data-session-stolen]').first().waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await device3.page.locator('[data-signed-out]').waitFor({ state: 'visible', timeout: SIGNED_OUT_TIMEOUT_MS });

  // «Пароль · менялся …» — время смены приходит с сервера (поле identity), строка появляется без перезагрузки
  await device1.page.locator('[data-account-row="password"] [data-account-password-changed]')
    .getByText(/^changed \S+/).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assertNoPageErrors({ 'bob-device-1': device1 });
  console.log('OK: «Украдено» — мастер для вышедшего и для живого устройства: отзыв со сменой ключей, пароль, новый ключ');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['bob-dev1', device1Context], ['bob-dev2', device2Context], ['bob-dev3', device3Context]]) {
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
