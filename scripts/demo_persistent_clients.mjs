// Персистентное демо: два окна (Alice, Bob) с ПОСТОЯННЫМИ профилями браузера
// (userDataDir) — E2E-ключи и кэш сообщений переживают перезапуск, поэтому
// видна прошлая переписка. Аккаунты фиксированные; первый запуск регистрирует,
// последующие — логинят. Останов: Ctrl-C.
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

const BASE_URL = process.env.PARVANE_E2E_BASE_URL;
const GATEWAY_URL = process.env.PARVANE_E2E_GATEWAY_URL;
const PROFILES_DIR = process.env.PARVANE_DEMO_PROFILES;
const PASSWORD = 'demo-password';
const LOGIN_TIMEOUT_MS = 60000;

if (!BASE_URL || !GATEWAY_URL || !PROFILES_DIR) {
  throw new Error('PARVANE_E2E_BASE_URL, PARVANE_E2E_GATEWAY_URL, PARVANE_DEMO_PROFILES обязательны');
}

async function launchClient(profile, x, address) {
  // Постоянный контекст: хранит localStorage + IndexedDB (E2E-ключи, история)
  const context = await chromium.launchPersistentContext(`${PROFILES_DIR}/${profile}`, {
    headless: false,
    viewport: null,
    permissions: ['microphone', 'camera'],
    args: [
      `--window-position=${x},40`,
      '--window-size=955,1000',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  // Адрес gateway кладём до загрузки приложения (порт стабильный, но на всякий)
  await context.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, GATEWAY_URL);

  const page = context.pages()[0] || await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  if (process.env.PARVANE_DEMO_DIAG) {
    page.on('console', (msg) => {
      const t = msg.text();
      if (/E2E|prekey|encrypt|decrypt|Error|ошибк|не удал/i.test(t)) {
        console.log(`[${profile}:console] ${t}`);
      }
    });
  }
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await loginOrRegister(page, address);
  return { context, page, errors };
}

// Идемпотентно и устойчиво к переходам: на каждом шаге смотрим, какая форма
// сейчас активна, и действуем — пока не окажемся внутри (LeftColumn).
async function loginOrRegister(page, address) {
  const addressInput = page.locator('.Transition_slide-active > #auth-phone-number-form input');
  const passwordInput = page.locator('.Transition_slide-active > #auth-password-form #sign-in-password');
  const leftColumn = page.locator('#LeftColumn');
  const nextButton = () => page.locator('.Transition_slide-active').getByRole('button', { name: 'Next' });

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let addressDone = false;
  let passwordDone = false;
  while (Date.now() < deadline) {
    if (await leftColumn.isVisible().catch(() => false)) return;
    if (!addressDone && await addressInput.isVisible().catch(() => false)) {
      await addressInput.fill(address).catch(() => {});
      await nextButton().click().catch(() => {});
      addressDone = true;
      await page.waitForTimeout(500);
      continue;
    }
    if (!passwordDone && await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill(PASSWORD).catch(() => {});
      await nextButton().click().catch(() => {});
      passwordDone = true;
      await page.waitForTimeout(500);
      continue;
    }
    await page.waitForTimeout(300);
  }
  await leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function openPrivateChat(page, address) {
  const displayName = address.split('@')[0];
  // Если чат уже в списке (есть история) — просто открываем его
  const existing = page.locator('#LeftColumn .ListItem').filter({ hasText: displayName }).first();
  if (await existing.isVisible().catch(() => false)) {
    await existing.locator('.ListItem-button').click();
    await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    return;
  }
  // Иначе ищем через поиск
  const search = page.locator('#telegram-search-input');
  await search.click();
  await page.locator('.LeftSearch').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(250);
  await search.fill(displayName);
  const result = page.locator('.LeftSearch .search-result').filter({ hasText: displayName }).first();
  await result.waitFor({ state: 'visible', timeout: 15000 });
  await result.locator('.ListItem-button').click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

const alice = 'alice@local';
const bob = 'bob@local';

const aliceClient = await launchClient('alice', 20, alice);
const bobClient = await launchClient('bob', 800, bob);

try {
  await openPrivateChat(aliceClient.page, bob);
  await openPrivateChat(bobClient.page, alice);

  if (process.env.PARVANE_DEMO_DIAG) {
    // Диагностика: alice шлёт → проверяем, дошло ли до bob
    const probe = `diag-${Date.now()}`;
    const input = aliceClient.page.locator('#editable-message-text');
    await input.fill(probe);
    await input.press('Enter');
    await aliceClient.page.waitForTimeout(6000);
    const gotByBob = await bobClient.page
      .locator('.Transition_slide-active > .MessageList .Message .text-content')
      .filter({ hasText: probe }).count();
    console.log(`[diag] alice→bob "${probe}" получено bob: ${gotByBob}`);
    const bobProbe = `diagb-${Date.now()}`;
    const bInput = bobClient.page.locator('#editable-message-text');
    await bInput.fill(bobProbe);
    await bInput.press('Enter');
    await bobClient.page.waitForTimeout(6000);
    const gotByAlice = await aliceClient.page
      .locator('.Transition_slide-active > .MessageList .Message .text-content')
      .filter({ hasText: bobProbe }).count();
    console.log(`[diag] bob→alice "${bobProbe}" получено alice: ${gotByAlice}`);
  }

  if (process.env.PARVANE_DEMO_VERIFY) {
    // Проверка персиста: сколько прошлых сообщений загрузилось после входа
    await aliceClient.page.waitForTimeout(4000);
    const aliceMsgs = await aliceClient.page
      .locator('.Transition_slide-active > .MessageList .Message').count();
    const bobMsgs = await bobClient.page
      .locator('.Transition_slide-active > .MessageList .Message').count();
    console.log(`[verify] прошлых сообщений после входа — alice: ${aliceMsgs}, bob: ${bobMsgs}`);
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  Персистентное демо: два постоянных аккаунта с историей');
  console.log('   • Левое окно  — Alice (alice@local)');
  console.log('   • Правое окно — Bob   (bob@local)');
  console.log('  Пароль: demo-password');
  console.log('  Переписка сохраняется между перезапусками (профили + серверные БД).');
  console.log('  Останов: Ctrl-C в этом терминале.');
  console.log('════════════════════════════════════════════════════════════\n');

  await new Promise(() => {});
} finally {
  await aliceClient.context.close().catch(() => {});
  await bobClient.context.close().catch(() => {});
}
