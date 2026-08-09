// Живая демонстрация: два реальных окна браузера (Alice и Bob), оба залогинены
// и с открытым чатом друг к другу. Окна остаются открытыми для ручной проверки
// базового функционала и UI. Завершение — Ctrl-C в терминале.
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { openPrivateChat, preparePage } from './e2e_web_helpers.mjs';

const PASSWORD = 'demo-password';
const suffix = `${Date.now()}`;
const alice = `alice-${suffix}@local`;
const bob = `bob-${suffix}@local`;

// Два отдельных окна браузера, разнесённые по экрану, с доступом к
// микрофону/камере (чтобы можно было проверить и звонки)
async function launchClient(x, title) {
  const browser = await chromium.launch({
    headless: false,
    args: [
      `--window-position=${x},40`,
      '--window-size=955,1000',
      // Реальные камера/микрофон (без fake-устройств), разрешения выданы
      // через context.permissions — чтобы голос и кружок были настоящими
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  // viewport: null — приложение заполняет реальное окно (без белых полей),
  // а ширина >925px включает статичный список чатов (десктоп-раскладка)
  const context = await browser.newContext({
    viewport: null,
    permissions: ['microphone', 'camera'],
  });
  return { browser, context, title };
}

const aliceClient = await launchClient(20, 'Alice');
const bobClient = await launchClient(800, 'Bob');

try {
  const aliceSession = await preparePage(aliceClient.context, alice, PASSWORD);
  const bobSession = await preparePage(bobClient.context, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  Два клиента готовы и переписка открыта:');
  console.log(`   • Левое окно  — Alice (${alice})`);
  console.log(`   • Правое окно — Bob   (${bob})`);
  console.log('  Пароль обоих (если попросит после reload): demo-password');
  console.log('  Пишите, шлите медиа, звоните — всё вживую.');
  console.log('  Останов: Ctrl-C в этом терминале.');
  console.log('════════════════════════════════════════════════════════════\n');

  // Держим процесс живым, пока пользователь не остановит
  await new Promise(() => {});
} finally {
  await aliceClient.browser.close().catch(() => {});
  await bobClient.browser.close().catch(() => {});
}
