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
  // Протокол v2 по умолчанию (T135): диалог ключа восстановления появляется
  // после первого входа в произвольный момент и перекрывает интерфейс
  // (диалог выхода тоже упоминает ключ восстановления — отличаем по кнопке OK)
  const recoveryDialog = page.locator('.Modal .modal-dialog')
    .filter({ hasText: /recovery key|ключ восстановления/i })
    .filter({ has: page.getByRole('button', { name: 'OK', exact: true }) });
  await page.addLocatorHandler(recoveryDialog, async (dialog) => {
    await dialog.getByRole('button', { name: 'OK' }).click();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  return pageErrors;
}

export type SubmitAddressOptions = {
  // «Keep me signed in» по умолчанию включён (сессия ~сутки, пароль сохранён
  // зашифрованным): после reload вход без пароля. Тесты, проверяющие экран
  // пароля после reload, снимают галку.
  keepSignedIn?: boolean;
};

export async function submitAddress(page: Page, user: string, options: SubmitAddressOptions = {}) {
  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const addressInput = addressScreen.getByLabel('Nickname');
  await expect(addressInput).toBeVisible({ timeout: LOGIN_TIMEOUT_MS });
  // Экран может перемонтироваться сразу после появления (например, после
  // logout) и сбросить введённое — повторяем ввод, пока не появится кнопка
  await expect(async () => {
    await addressInput.fill(user);
    await expect(addressScreen.getByRole('button', { name: 'Next' })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: LOGIN_TIMEOUT_MS });
  if (options.keepSignedIn === false) {
    // input чекбокса визуально скрыт — кликаем по его label
    const keep = addressScreen.locator('#sign-in-keep-session');
    if (await keep.isChecked()) {
      await addressScreen.locator('label:has(#sign-in-keep-session)').click();
      await expect(keep).not.toBeChecked({ timeout: 3000 });
    }
  }
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

export async function registerAndSignIn(
  page: Page, user: string, password: string, options: SubmitAddressOptions = {},
) {
  await submitAddress(page, user, options);
  await submitPassword(page, password);
  await expectSignedIn(page);
}

const PROFILE_STEP_TIMEOUT_MS = 5000;

// «Профиль» — главный экран настроек: кнопка `Profile` боковой панели (компьютер) либо нижней панели
// (телефон). Диалог ключа восстановления (v2) появляется в произвольный момент после входа и перекрывает
// кнопку — нажатие повторяется, пока экран не откроется
export async function openProfile(page: Page) {
  const rail = page.locator('#FoldersSidebar').getByRole('button', { name: 'Profile' });
  const bar = page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Profile' });
  const screen = page.locator('.settings-main-scroll');
  await expect(async () => {
    if (!(await screen.isVisible())) await rail.or(bar).first().click({ timeout: PROFILE_STEP_TIMEOUT_MS });
    await expect(screen).toBeVisible({ timeout: PROFILE_STEP_TIMEOUT_MS });
  }).toPass({ timeout: LOGIN_TIMEOUT_MS });
}

// Правка своего профиля: карандаша в шапке «Профиля» нет — путь через карточку аккаунта («My Profile») и
// карандаш в шапке открывшегося профиля
export async function openEditProfile(page: Page) {
  await openProfile(page);
  await page.locator('.settings-main-scroll').getByRole('button', { name: 'My Profile', exact: true }).click();
  await page.locator('#RightColumn .RightHeader').getByRole('button', { name: 'Edit', exact: true }).click();
}

export function uniqueUser(prefix: string, projectName: string) {
  const slug = projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return `${prefix}-${slug}-${Date.now()}@local`;
}

export type SecureStateSnapshot = {
  // Профиль хранилища движка (spec 035): указатель `profile/<адрес>` каталога `parvane-store-v3`
  profileId?: string;
  // Non-extractable ключ WebCrypto профиля в `parvane-store-v3-keys`
  hasKey: boolean;
  keyExtractable?: boolean;
  // Корень хранилища (`root`) в базе профиля `parvane-store-v3-<id>`
  hasRoot: boolean;
  // Состояние движка v2 — запись `g<поколение>/engine-core/v2-engine-bin` (значение — шифртекст движка)
  hasState: boolean;
  // Число записей базы профиля (после выхода — 0)
  recordCount: number;
  // Строка `secret` нашлась в значениях базы профиля или в localStorage
  secretLeaked: boolean;
  hasLoginAddress: boolean;
  loginAddress?: string;
  legacyE2eKeyCount: number;
};

export type SecureStateSnapshotOptions = {
  // Профиль, снятый прежним снимком: после выхода указателя `profile/<адрес>` уже нет
  profileId?: string;
  secret?: string;
};

// Снимок хранилища устройства прямым чтением IndexedDB: работает и до входа, и после выхода (на экране входа
// провайдер своих диаг-хуков ещё не выставил). Записи по имени не расшифровываются — только ключи носителя;
// что запись открывается ключом профиля, проверяет диаг-метод `parvaneDiagHasSecureRecord`
export async function readSecureStateSnapshot(
  page: Page, address: string, options: SecureStateSnapshotOptions = {},
): Promise<SecureStateSnapshot> {
  return page.evaluate(async ({ user, knownProfileId, secret }) => {
    // Базы нет — не создаём пустую (приложение открывает её со своей схемой)
    const openExisting = (name: string) => new Promise<IDBDatabase | undefined>((resolve, reject) => {
      const request = indexedDB.open(name);
      let isMissing = false;
      request.onupgradeneeded = () => {
        isMissing = true;
        request.transaction!.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => (isMissing ? resolve(undefined) : reject(request.error));
    });
    const readAll = (db: IDBDatabase, storeName: string) => new Promise<[string, unknown][]>((resolve, reject) => {
      if (!db.objectStoreNames.contains(storeName)) {
        resolve([]);
        return;
      }
      const store = db.transaction(storeName).objectStore(storeName);
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      valuesRequest.onsuccess = () => resolve(
        keysRequest.result.map((key, n) => [typeof key === 'string' ? key : '', valuesRequest.result[n]]),
      );
      valuesRequest.onerror = () => reject(valuesRequest.error);
    });
    const toText = (value: unknown) => {
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) return new TextDecoder().decode(value);
      return typeof value === 'string' ? value : '';
    };

    const directory = await openExisting('parvane-store-v3');
    const entries = directory ? await readAll(directory, 'records') : [];
    directory?.close();
    const pointer = entries.find(([key]) => key === `profile/${user}`);
    const profileId = pointer ? toText(pointer[1]) : undefined;
    const id = profileId || knownProfileId;

    let key: CryptoKey | undefined;
    let records: [string, unknown][] = [];
    if (id) {
      const keys = await openExisting('parvane-store-v3-keys');
      const keyEntries = keys ? await readAll(keys, 'keys') : [];
      key = keyEntries.find(([name]) => name === id)?.[1] as CryptoKey | undefined;
      keys?.close();
      const profile = await openExisting(`parvane-store-v3-${id}`);
      records = profile ? await readAll(profile, 'records') : [];
      profile?.close();
    }
    const localEntries = Object.keys(localStorage).map((name) => [name, localStorage.getItem(name)]);
    const loginAddress = localStorage.getItem('parvane:login-address') ?? undefined;
    return {
      profileId,
      hasKey: key !== undefined,
      keyExtractable: key?.extractable,
      hasRoot: records.some(([name]) => name === 'root'),
      hasState: records.some(([name]) => /^g\d+\/engine-core\/v2-engine-bin$/.test(name)),
      recordCount: records.length,
      secretLeaked: Boolean(secret) && (
        records.some(([, value]) => toText(value).includes(secret!))
        || JSON.stringify(localEntries).includes(secret!)
      ),
      hasLoginAddress: loginAddress !== undefined,
      loginAddress,
      legacyE2eKeyCount: localEntries.filter(([name]) => name!.startsWith('parvane:e2e:')).length,
    };
  }, { user: address, knownProfileId: options.profileId, secret: options.secret });
}

// Метод провайдера диаг-сборки (`VITE_PARVANE_DIAG_HOOKS=1`; раннер `scripts/run_web_e2e.sh` собирает такую)
export async function callDiagApi<T>(page: Page, method: string, params: unknown): Promise<T> {
  await page.waitForFunction(() => typeof (window as unknown as {
    __parvaneDiagCallApi?: unknown;
  }).__parvaneDiagCallApi === 'function', undefined, { timeout: LOGIN_TIMEOUT_MS });
  return page.evaluate(([name, args]) => (window as unknown as {
    __parvaneDiagCallApi: (fn: string, payload: unknown) => Promise<unknown>;
  }).__parvaneDiagCallApi(name, args), [method, params] as const) as Promise<T>;
}
