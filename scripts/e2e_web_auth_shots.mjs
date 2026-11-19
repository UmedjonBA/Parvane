// Снимки экранов входа (spec 041 E4): телефон 360×800 и компьютер 1120×700, светлая и тёмная схема.
// Работает, только если задан каталог `PARVANE_E2E_AUTH_SHOT_DIR`; сценарии зовут `shootAuthScreen` на своих
// экранах входа — отдельного сценария ради снимков нет.
const SHOT_DIR = process.env.PARVANE_E2E_AUTH_SHOT_DIR;
const SETTLE_MS = 450;
const VARIANTS = [
  { tag: 'phone-light', width: 360, height: 800, scheme: 'light' },
  { tag: 'phone-dark', width: 360, height: 800, scheme: 'dark' },
  { tag: 'desk-light', width: 1120, height: 700, scheme: 'light' },
  { tag: 'desk-dark', width: 1120, height: 700, scheme: 'dark' },
];

export async function shootAuthScreen(page, name) {
  if (!SHOT_DIR) return;
  const size = page.viewportSize();
  for (const { tag, width, height, scheme } of VARIANTS) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-${name}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
  if (size) await page.setViewportSize(size);
  await page.waitForTimeout(SETTLE_MS);
  console.log(`OK: снимки ${name}`);
}
