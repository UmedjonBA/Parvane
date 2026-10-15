// Превью ссылки в чате с картинкой (16 окт 2026): отправитель берёт у шарда preview `og:image`, уменьшает её на
// устройстве и шлёт вложением `LinkPreview.image` (секрет скачивания, CAP-1); получатель видит карточку с фото, в том
// числе после перезагрузки. Ссылка — живой github.com (картинка ~600 КБ: проверяет и предел шарда 1 МиБ) — нужен
// интернет. Запуск: scripts/run_web_link_preview_image_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS, openPrivateChatStrict, preparePage, relogin, sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-link-preview-1';
const URL_WITH_IMAGE = process.env.PARVANE_E2E_PREVIEW_URL || 'https://github.com/';
const IMAGE_TIMEOUT_MS = 30000;

async function expectPreviewPhoto(page, label) {
  const card = page.locator('.Transition_slide-active > .MessageList .Message .WebPage').last();
  await card.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const img = card.locator('img.full-media');
  await img.waitFor({ state: 'visible', timeout: IMAGE_TIMEOUT_MS }).catch(() => {
    assert.fail(`${label}: в карточке превью нет картинки`);
  });
  const size = await img.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
  assert(size.w > 0 && size.w <= 960 && size.h <= 960, `${label}: картинка не уменьшена или пуста: ${JSON.stringify(size)}`);
  return size;
}

const browser = await chromium.launch();
try {
  const stamp = Date.now().toString(36);
  const alice = `lp-a-${stamp}@local`;
  const bob = `lp-b-${stamp}@local`;
  const a = await preparePage(await browser.newContext(), alice, PASSWORD);
  const b = await preparePage(await browser.newContext(), bob, PASSWORD);
  await openPrivateChatStrict(a.page, bob);
  // Первая отправка прогревает кэш шарда (страница и картинка тянутся снаружи дольше дедлайна превью)
  await sendText(a.page, `warm ${URL_WITH_IMAGE}`);
  await a.page.waitForTimeout(8000);
  await sendText(a.page, `see ${URL_WITH_IMAGE} now`);
  await openPrivateChatStrict(b.page, alice);
  const size = await expectPreviewPhoto(b.page, 'bob');
  console.log(`OK: у получателя карточка превью с картинкой ${size.w}×${size.h}`);
  await expectPreviewPhoto(a.page, 'alice');
  console.log('OK: у отправителя тоже');
  await relogin(b.page, PASSWORD);
  await openPrivateChatStrict(b.page, alice);
  await expectPreviewPhoto(b.page, 'bob после перезагрузки');
  console.log('OK: картинка превью на месте после перезагрузки');
  assert.deepEqual([...a.errors, ...b.errors], [], 'ошибки страницы');
  console.log('e2e_web_link_preview_image: OK');
} finally {
  await browser.close();
}
