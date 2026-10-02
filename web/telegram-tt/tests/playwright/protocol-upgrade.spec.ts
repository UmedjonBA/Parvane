import { expect, test } from '@playwright/test';

import {
  LOGIN_TIMEOUT_MS,
  openApp,
  registerAndSignIn,
  requireGatewayUrl,
  uniqueUser,
} from './helpers';

// Протокол v2 (spec 007, T042): клиент ниже `min_supported` сервера получает
// UPGRADE_REQUIRED в ответ на Hello и показывает нативный диалог ошибки.
// Нужен gateway с завышенным PARVANE_V2_MIN_MINOR — его поднимает
// scripts/run_web_protocol_upgrade_e2e.sh (он же выставляет флаг ниже)
const PASSWORD = 'Parvane-upgrade-e2e-password';

test('v2 client below min_supported shows the native update dialog', async ({ page }, testInfo) => {
  test.skip(!process.env.PARVANE_E2E_EXPECT_UPGRADE, 'needs gateway with PARVANE_V2_MIN_MINOR above the client');
  test.skip(testInfo.project.name !== 'chromium', 'Version negotiation is browser-independent');
  const gatewayUrl = requireGatewayUrl();
  await page.addInitScript(() => {
    localStorage.setItem('parvane:proto', 'v2');
  });
  await openApp(page, gatewayUrl);
  // Вход идёт по v1 и работает; v2-стек поднимается после входа и упирается
  // в UPGRADE_REQUIRED
  await registerAndSignIn(page, uniqueUser('upgrade', testInfo.project.name), PASSWORD);
  const dialog = page.locator('.Modal .modal-dialog').filter({ hasText: 'no longer supported' });
  await expect(dialog).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
});
