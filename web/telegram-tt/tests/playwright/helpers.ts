import { expect, type Page } from '@playwright/test';

export const LOGIN_TIMEOUT_MS = 60000;

export function requireGatewayUrl(): string {
  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  expect(gatewayUrl, 'The live-stack runner must provide PARVANE_E2E_GATEWAY_URL').toBeTruthy();
  return gatewayUrl!;
}

export async function openApp(page: Page, gatewayUrl: string): Promise<string[]> {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.route(/https:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/_websync_/, async (route) => {
    await route.fulfill({ contentType: 'application/javascript', body: '' });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  return pageErrors;
}

export async function submitAddress(page: Page, user: string) {
  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const addressInput = addressScreen.getByLabel('Address (user@server)');
  await expect(addressInput).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  // Экран может перемонтироваться сразу после появления (например, после
  // logout) и сбросить введённое — повторяем ввод, пока не появится кнопка
  await expect(async () => {
    await addressInput.fill(user);
    await expect(addressScreen.getByRole('button', { name: 'Next' })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: LOGIN_TIMEOUT_MS });
  await addressScreen.getByRole('button', { name: 'Next' }).click();
}

export async function submitPassword(page: Page, password: string) {
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await expect(passwordScreen).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  await expect(async () => {
    await passwordScreen.locator('#sign-in-password').fill(password);
    await expect(passwordScreen.getByRole('button', { name: 'Next' })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
}

export async function expectSignedIn(page: Page) {
  await expect(page.locator('#LeftColumn')).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
}

export async function registerAndSignIn(page: Page, user: string, password: string) {
  await submitAddress(page, user);
  await submitPassword(page, password);
  await expectSignedIn(page);
}

export function uniqueUser(prefix: string, projectName: string) {
  const slug = projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return `${prefix}-${slug}-${Date.now()}@local`;
}

export type SecureStateSnapshot = {
  hasKey: boolean;
  hasState: boolean;
  hasLoginAddress: boolean;
  loginAddress?: string;
  legacyE2eKeyCount: number;
};

export async function readSecureStateSnapshot(page: Page, address: string): Promise<SecureStateSnapshot> {
  return page.evaluate(async (user) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('parvane-e2e-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (key: string) => new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('secure-state').objectStore('secure-state').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [key, state] = await Promise.all([read(`key:${user}`), read(`state:${user}`)]);
    db.close();
    const loginAddress = localStorage.getItem('parvane:login-address') ?? undefined;
    return {
      hasKey: key !== undefined,
      hasState: state !== undefined,
      hasLoginAddress: loginAddress !== undefined,
      loginAddress,
      legacyE2eKeyCount: Object.keys(localStorage).filter((name) => name.startsWith('parvane:e2e:')).length,
    };
  }, address);
}
