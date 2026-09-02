// Двухбраузерный сценарий доводки опросов (в группе — как в Telegram, в 1-1
// опросов нет): публичный опрос со списком реально проголосовавших (панель
// результатов), quiz с правильным ответом и пояснением после неверного голоса,
// персист агрегата после reload.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  relogin,
  LOGIN_TIMEOUT_MS,
  findMessageContainers,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-polls-e2e-password';

async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name })
    .first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const checkedRows = `${containerSelector} .PeerPickerItem input[type="checkbox"]:checked, `
    + `${containerSelector} .ItemPickerItem input[type="checkbox"]:checked`;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await page.locator(checkedRows).count()) return;
    if (attempt % 2 === 0) {
      await row.press(' ').catch(() => {});
    } else {
      await row.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  assert.fail(`picker row for ${name} is never selected in ${containerSelector}`);
}

async function openGroupChat(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}


async function openPollModal(page) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  await page.getByRole('menuitem', { name: 'Poll' }).click();
  const questionInput = page.getByLabel('Ask a Question');
  await questionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return questionInput;
}

async function fillPollOptions(page, options) {
  for (const option of options) {
    await page.getByPlaceholder('Add an Option').fill(option);
    await page.waitForFunction((value) => Array.from(document.querySelectorAll('input'))
      .some((input) => input.placeholder === 'Option' && input.value === value), option);
  }
}

async function voteInPoll(poll, optionText) {
  const option = poll.getByText(optionText, { exact: true }).first();
  await option.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await option.click();
  const voteButton = poll.getByText('Vote', { exact: true });
  if (await voteButton.isVisible().catch(() => false)) {
    await voteButton.click();
  }
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `polls-alice-${suffix}@local`;
  const bob = `polls-bob-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const groupTitle = `Polls ${suffix}`;
  const publicQuestion = `public-poll-${suffix}`;
  const quizQuestion = `quiz-${suffix}`;
  const quizSolution = `explanation-${suffix}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, `hello-${suffix}`);

  // Опросы доступны только в группах — создаём группу с Бобом
  await aliceSession.page.mouse.move(800, 360);
  await aliceSession.page.waitForTimeout(200);
  await aliceSession.page.locator('#LeftColumn').hover();
  await aliceSession.page.getByRole('button', { name: 'New Message' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = aliceSession.page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(bobName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', bobName);
  await aliceSession.page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = aliceSession.page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Create Group' }).click();
  await aliceSession.page.locator('#editable-message-text')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChat(aliceSession.page, groupTitle);
  await openGroupChat(bobSession.page, groupTitle);

  // ── Публичный опрос: голос Боба виден в панели результатов ────────────────
  const publicQuestionInput = await openPollModal(aliceSession.page);
  await publicQuestionInput.fill(publicQuestion);
  await fillPollOptions(aliceSession.page, ['Da', 'Net']);
  await aliceSession.page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();

  const bobPublicPoll = findMessageContainers(bobSession.page, publicQuestion).first();
  await bobPublicPoll.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await voteInPoll(bobPublicPoll, 'Da');

  // View Results виден только проголосовавшему — Алиса голосует сама
  const alicePublicPoll = findMessageContainers(aliceSession.page, publicQuestion).first();
  await voteInPoll(alicePublicPoll, 'Da');
  await alicePublicPoll.getByText('View Results', { exact: true }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await alicePublicPoll.getByText('View Results', { exact: true }).first().click();
  // Панель результатов: имя Боба доказывает применение УДАЛЁННОГО голоса
  const rightColumn = aliceSession.page.locator('#RightColumn');
  await rightColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await rightColumn.getByText(bobName).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.keyboard.press('Escape');

  // ── Quiz: неверный ответ Боба → пояснение, верный вариант помечен ─────────
  const quizQuestionInput = await openPollModal(aliceSession.page);
  await quizQuestionInput.fill(quizQuestion);
  await fillPollOptions(aliceSession.page, ['Da', 'Net']);
  const pollDialog = aliceSession.page.getByRole('dialog');
  await pollDialog.getByText('Set Correct Answer', { exact: true }).click();
  // Quiz — одиночный выбор: выключаем включённый по умолчанию multiple,
  // чтобы селектор правильного ответа стал радио-кнопками
  await pollDialog.getByText('Allow Multiple Answers', { exact: true }).click();
  // Правильный ответ — первый вариант (Da): радио в его строке
  await pollDialog.locator('input[type="radio"]').first().click({ force: true });
  await pollDialog.getByLabel('Explanation').fill(quizSolution);
  await pollDialog.getByRole('button', { name: 'Send', exact: true }).click();

  const bobQuiz = findMessageContainers(bobSession.page, quizQuestion).first();
  await bobQuiz.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await voteInPoll(bobQuiz, 'Net');
  // После голоса quiz раскрывает пояснение: лампочка → текст решения
  const lampButton = bobQuiz.getByRole('button', { name: 'Show solution' });
  await lampButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await lampButton.click();
  await bobSession.page.getByText(quizSolution).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Персист: после reload Боб видит агрегат (View Results у публичного) ────
  await relogin(bobSession.page, PASSWORD);
  await openGroupChat(bobSession.page, groupTitle);
  await findMessageContainers(bobSession.page, publicQuestion).first()
    .getByText('View Results', { exact: true }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: публичный опрос со списком голосовавших, quiz с пояснением после неверного ответа, персист после reload');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}polls-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
