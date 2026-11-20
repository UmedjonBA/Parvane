import assert from 'node:assert/strict';
import { join } from 'node:path';

import { LOGIN_TIMEOUT_MS, expectMediaFlowing } from './e2e_web_helpers.mjs';

export function findCallTimer(page) {
  return page.locator('[data-call-screen]').getByText(/^\d+:\d{2}$/).first();
}

export async function mockCallMedia(context, useSystemPicker = false) {
  await context.addInitScript(({ useSystemPicker }) => {
    // Свой источник экрана с известными цветами позволяет отличить его от камеры
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const drawing = canvas.getContext('2d');
      const stream = canvas.captureStream(12);
      let frame = 0;
      function draw() {
        drawing.fillStyle = '#e02020';
        drawing.fillRect(0, 0, 160, 180);
        drawing.fillStyle = '#20e020';
        drawing.fillRect(160, 0, 160, 180);
        drawing.fillStyle = '#fff';
        drawing.fillRect((frame += 7) % 280, 150, 20, 20);
      }
      draw();
      const timer = setInterval(() => {
        if (stream.getVideoTracks()[0].readyState === 'ended') clearInterval(timer);
        else draw();
      }, 80);
      window.__testScreenStream = stream;
      return stream;
    };

    const headset = { kind: 'audiooutput', deviceId: 'test-headset', label: 'Test headset' };
    const enumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => [...await enumerateDevices(), headset];
    if (useSystemPicker) navigator.mediaDevices.selectAudioOutput = async () => headset;
    Object.defineProperty(HTMLMediaElement.prototype, 'sinkId', {
      configurable: true,
      get() { return this.dataset.output || ''; },
    });
    HTMLMediaElement.prototype.setSinkId = async function setSinkId(id) {
      this.dataset.output = id;
    };
  }, { useSystemPicker });
}

// Вторая камера устройства («Сменить камеру», доска `RpCalls`): её картинка — те же красная и зелёная половины,
// что у показа экрана, поэтому у собеседника её узнаёт `expectSharedScreen`
export async function mockSecondCamera(context) {
  await context.addInitScript(() => {
    const devices = navigator.mediaDevices;
    const camera = { kind: 'videoinput', deviceId: 'test-camera-2', label: 'Test camera 2', groupId: 'test' };
    const enumerateDevices = devices.enumerateDevices.bind(devices);
    // Ровно две камеры: первая настоящая (поддельная Chromium) и эта
    devices.enumerateDevices = async () => {
      const list = await enumerateDevices();
      const first = list.find((device) => device.kind === 'videoinput');
      return [...list.filter((device) => device.kind !== 'videoinput'), ...(first ? [first] : []), camera];
    };
    const getUserMedia = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async (constraints) => {
      if (constraints?.video?.deviceId?.exact !== camera.deviceId) return getUserMedia(constraints);
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const drawing = canvas.getContext('2d');
      const stream = canvas.captureStream(12);
      const timer = setInterval(() => {
        if (stream.getVideoTracks()[0].readyState === 'ended') clearInterval(timer);
        drawing.fillStyle = '#e02020';
        drawing.fillRect(0, 0, 160, 180);
        drawing.fillStyle = '#20e020';
        drawing.fillRect(160, 0, 160, 180);
      }, 80);
      return stream;
    };
  });
}

export async function checkCallAudioOutput(page, hasSystemPicker, streams, screenshots = false) {
  await page.getByRole('button', { name: 'Audio output', exact: true }).click();
  if (!hasSystemPicker) {
    if (screenshots) await saveCallState(page, 'audio-output');
    await page.getByRole('button', { name: 'Test headset', exact: true }).click();
  }
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-call-audio] audio[data-output="test-headset"]').length === expected,
    streams,
    { timeout: LOGIN_TIMEOUT_MS },
  );
  console.log(`OK: вывод звука выбран для всех потоков (${streams})`);
}

export async function checkMinimizedCallStrip(page) {
  const strip = page.getByRole('button', { name: /^Return to call:/ });
  await strip.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await strip.getAttribute('data-call-minimized'), 'true');
  assert.equal(await strip.getByText('Return', { exact: true }).count(), 1);
  assert.equal(await strip.locator('button').count(), 0, 'На плашке одна кнопка возврата');
  const stripBox = await strip.boundingBox();
  assert.deepEqual(stripBox, { x: 0, y: 0, width: page.viewportSize().width, height: 44 });
  assert.equal((await page.locator('#Main').boundingBox()).y, stripBox.y + stripBox.height);
  return strip;
}

export async function checkCallMinimize(page, { minPeers = 1, shotPrefix, isPhone = false } = {}) {
  const screen = page.locator('[data-call-screen]');
  const audio = page.locator('[data-call-audio] audio').first();
  await audio.evaluate((element) => { window.__testCallAudio = element; });
  await page.getByRole('button', { name: 'Minimize call', exact: true }).click();
  const strip = await checkMinimizedCallStrip(page);
  await screen.waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  const elapsed = strip.locator('[data-call-elapsed]');
  const before = await elapsed.innerText();
  if (isPhone) {
    const navigation = page.getByRole('navigation', { name: 'Modules' });
    const back = page.locator('#MiddleColumn .MiddleHeader .back-button button:visible').first();
    await navigation.or(back).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    if (!await navigation.isVisible()) await back.click();
  }
  await page.locator('[data-module="notes"]:visible').click();
  await page.locator('#ParvaneKnowledge').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectMediaFlowing(page, { audio: true, minPeers });
  assert(await audio.evaluate((element) => element === window.__testCallAudio && !element.paused),
    'Звук должен продолжаться в прежнем элементе после сворачивания и смены модуля');
  await page.waitForFunction(
    (previous) => {
      const elapsedText = document.querySelector('[data-call-elapsed]')?.textContent;
      return Boolean(elapsedText && elapsedText !== previous);
    },
    before,
    { timeout: LOGIN_TIMEOUT_MS },
  );
  if (shotPrefix !== undefined) await saveCallState(page, `${shotPrefix}minimized`);
  await strip.click();
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert(await audio.evaluate((element) => element === window.__testCallAudio && !element.paused),
    'Звук должен продолжаться после разворачивания');
  if (shotPrefix !== undefined) await saveCallState(page, `${shotPrefix}restored`);
  await page.keyboard.press('Escape');
  await strip.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('[data-module="chats"]:visible').click();
  await strip.click();
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: сворачивание, переход в «Заметки», звук и возврат из плашки');
}

export async function saveCallState(page, name) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR;
  if (!dir) return;
  const viewport = page.viewportSize();
  try {
    for (const [size, width, height] of [['desktop', 1120, 700], ['phone', 360, 800]]) {
      await page.setViewportSize({ width, height });
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForFunction((theme) => document.documentElement.classList.contains(`theme-${theme}`), scheme,
          { timeout: 5000 });
        await page.screenshot({
          path: join(dir, `call-${name}-${size}-${scheme}.png`),
          animations: 'disabled',
        });
      }
    }
  } finally {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: 'light' });
  }
}

export async function expectSharedScreen(page, selector, isSharing = true) {
  await page.waitForFunction(({ target, expected }) => {
    const video = document.querySelector(target);
    if (!video?.videoWidth || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 2;
    const drawing = canvas.getContext('2d');
    drawing.drawImage(video, 0, 0, 4, 2);
    const [leftRed, leftGreen] = drawing.getImageData(0, 0, 1, 1).data;
    const [rightRed, rightGreen] = drawing.getImageData(3, 0, 1, 1).data;
    const isScreen = leftRed - leftGreen > 80 && rightGreen - rightRed > 80;
    return isScreen === expected;
  }, { target: selector, expected: isSharing }, { timeout: LOGIN_TIMEOUT_MS });
}

export async function stopScreenInBrowser(page) {
  await page.evaluate(() => {
    const [track] = window.__testScreenStream.getVideoTracks();
    track.stop();
    track.dispatchEvent(new Event('ended'));
  });
}
