// «Кто отреагировал» (spec 024 И2): в группе из трёх каждый ставит реакцию на
// сообщение Алисы — пункт меню открывает список с тремя строками; снятая реакция
// пропадает из списка; после перезагрузки страницы список и счётчики прежние
// (раньше авторы реакций жили только в памяти вкладки, и счётчики «плыли»).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  addReaction,
  assertNoPageErrors,
  createGroupViaUi,
  findMessageContainer,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
  openMessageMenu,
  openPrivateChat,
  preparePage,
  reloadPage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-reactors-e2e-password';

async function readReactorList(page, text) {
  await openMessageMenu(page, text);
  const item = page.locator('.MessageContextMenu .MenuItem').filter({ has: page.locator('.icon-heart-outline') }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.click();
  // Корень `.Modal` Playwright видимым не считает — ждём сам диалог
  const modal = page.locator('.ReactorListModal .modal-dialog');
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Строки списка — ListItem с именем участника
  await page.waitForTimeout(500);
  const rows = await modal.locator('.ListItem').allInnerTexts();
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
  // Окно Telegram показывает и тех, кто только прочитал (без реакции) — считаем строки с реакцией
  return rows.map((row) => row.replace(/\s+/g, ' ').trim()).filter((row) => /👍|❤|🔥/.test(row));
}

const browser = await chromium.launch();
const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `reactors-alice-${suffix}@local`;
  const bob = `reactors-bob-${suffix}@local`;
  const carol = `reactors-carol-${suffix}@local`;
  const [bobName, carolName] = [bob, carol].map((address) => address.split('@')[0]);
  const title = `Reactors ${suffix}`;
  const target = `react-to-me-${suffix}`;

  sessions.alice = await preparePage(contexts[0], alice, PASSWORD);
  sessions.bob = await preparePage(contexts[1], bob, PASSWORD);
  sessions.carol = await preparePage(contexts[2], carol, PASSWORD);
  const { page: a } = sessions.alice;
  const { page: b } = sessions.bob;
  const { page: c } = sessions.carol;

  for (const peer of [bob, carol]) {
    await openPrivateChat(a, peer);
    await sendText(a, `hello-${peer.split('-')[1]}-${suffix}`);
  }
  await createGroupViaUi(a, title, [bobName, carolName]);
  await openGroupChatByTitle(a, title);
  await sendText(a, target);
  for (const page of [b, c]) {
    await openGroupChatByTitle(page, title);
    await findMessageContainer(page, target).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }

  await addReaction(b, target, '👍');
  await addReaction(c, target, '❤️');
  await addReaction(a, target, '👍');
  await a.waitForFunction(({ text }) => {
    const bubble = Array.from(document.querySelectorAll('.Message')).find((m) => m.textContent?.includes(text));
    return bubble && bubble.querySelectorAll('.message-reaction').length >= 2;
  }, { text: target }, { timeout: LOGIN_TIMEOUT_MS });

  let rows = await readReactorList(a, target);
  assert.equal(rows.length, 3, `в списке три строки: ${rows.join(' | ')}`);
  for (const name of [bobName, carolName]) {
    assert(rows.some((row) => row.includes(name)), `${name} в списке: ${rows.join(' | ')}`);
  }
  console.log('OK: «кто отреагировал» — три участника в списке');

  // Кэрол снимает реакцию — у Алисы строка пропадает
  await addReaction(c, target, '❤️');
  await a.waitForFunction(({ text }) => {
    const bubble = Array.from(document.querySelectorAll('.Message')).find((m) => m.textContent?.includes(text));
    return bubble && bubble.querySelectorAll('.message-reaction').length === 1;
  }, { text: target }, { timeout: LOGIN_TIMEOUT_MS });
  rows = await readReactorList(a, target);
  assert.equal(rows.length, 2, `после снятия две строки: ${rows.join(' | ')}`);
  assert(!rows.some((row) => row.includes(carolName)), 'снятая реакция Кэрол пропала');
  console.log('OK: снятая реакция пропадает из списка');

  // Перезагрузка: список и счётчик из сохранённой строки
  await reloadPage(a);
  await openGroupChatByTitle(a, title);
  await findMessageContainer(a, target).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  rows = await readReactorList(a, target);
  assert.equal(rows.length, 2, `после перезагрузки две строки: ${rows.join(' | ')}`);
  // Новая реакция после перезагрузки не сбрасывает счётчик к единице
  await addReaction(c, target, '🔥');
  await a.waitForFunction(({ text }) => {
    const bubble = Array.from(document.querySelectorAll('.Message')).find((m) => m.textContent?.includes(text));
    return bubble && bubble.querySelectorAll('.message-reaction').length === 2;
  }, { text: target }, { timeout: LOGIN_TIMEOUT_MS });
  // Прежде счётчики после перезагрузки начинались с пустой карты: новая
  // реакция оставляла одну строку вместо трёх
  rows = await readReactorList(a, target);
  assert.equal(rows.length, 3, `после новой реакции три строки: ${rows.join(' | ')}`);
  console.log('OK: после перезагрузки список и счётчики прежние');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий «кто отреагировал» пройден');
} finally {
  await browser.close();
}
