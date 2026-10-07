import { expect, test } from '@playwright/test';

import {
  LOGIN_TIMEOUT_MS,
  openApp,
  requireGatewayUrl,
  submitAddress,
  submitPassword,
  uniqueUser,
} from './helpers';

// Протокол v2 (spec 007, T042): клиент ниже `min_supported` сервера получает
// UPGRADE_REQUIRED в ответ на Hello. С T110 вход тоже идёт по v2: экран ника к
// серверу не ходит, первый запрос (server.info/session.issue) уходит после
// пароля — там и показывается текст «версия не поддерживается» вместо
// «неверный пароль» (после входа — нативный диалог). Нужен gateway с завышенным
// PARVANE_V2_MIN_MINOR — его поднимает scripts/run_web_protocol_upgrade_e2e.sh
// (он же выставляет флаг ниже)
const PASSWORD = 'Parvane-upgrade-e2e-password';

test('v2 client below min_supported shows the native update dialog', async ({ page }, testInfo) => {
  test.skip(!process.env.PARVANE_E2E_EXPECT_UPGRADE, 'needs gateway with PARVANE_V2_MIN_MINOR above the client');
  test.skip(testInfo.project.name !== 'chromium', 'Version negotiation is browser-independent');
  const gatewayUrl = requireGatewayUrl();
  await openApp(page, gatewayUrl);
  await submitAddress(page, uniqueUser('upgrade', testInfo.project.name));
  // Первый же запрос входа получает UPGRADE_REQUIRED — отказ объяснён на экране пароля
  await submitPassword(page, PASSWORD);
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await expect(passwordScreen.getByText('no longer supported')).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  // Сессии нет
  await expect(page.locator('#LeftColumn')).toHaveCount(0);
});
