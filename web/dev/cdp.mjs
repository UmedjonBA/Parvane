#!/usr/bin/env node
// Драйвер headless Chromium через CDP для авто-проверки веб-клиента Parvane.
// Держит страницу открытой заданное время (в отличие от --screenshot, который
// убивает её сразу после load), собирает console и делает скриншот.
//
// Использование:
//   node cdp.mjs --url http://localhost:1234/ --profile /tmp/prof1 \
//     --wait 8000 --shot out.png [--eval 'JS-код'] [--click x,y] [--type 'текст']
// Шаги --eval/--click/--type выполняются по порядку следования в аргументах,
// между ними пауза --step-pause (default 500мс).

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}

const url = argOf('url', 'http://localhost:1234/');
const profile = argOf('profile', '/tmp/cdp-profile');
const waitMs = Number(argOf('wait', '8000'));
const shotPath = argOf('shot', '');
const stepPause = Number(argOf('step-pause', '500'));
const debugPort = Number(argOf('port', '9333'));

// Упорядоченные шаги
const steps = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--eval') steps.push({ kind: 'eval', value: args[i + 1] });
  if (args[i] === '--click') steps.push({ kind: 'click', value: args[i + 1] });
  if (args[i] === '--type') steps.push({ kind: 'type', value: args[i + 1] });
  if (args[i] === '--key') steps.push({ kind: 'key', value: args[i + 1] });
  if (args[i] === '--pause') steps.push({ kind: 'pause', value: args[i + 1] });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const chrome = spawn('chromium', [
  // --headless=new персистит localStorage на диск (старый --headless держит
  // его in-memory и теряет при закрытии — E2E-ключи не переживали рестарт)
  '--headless=new', '--disable-gpu', '--window-size=1280,800',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`,
  'about:blank',
], { stdio: 'ignore' });

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function main() {
  // Ждём поднятия CDP
  let targets;
  for (let i = 0; i < 50; i += 1) {
    try {
      const resp = await fetch(`http://localhost:${debugPort}/json`);
      targets = await resp.json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!targets) throw new Error('CDP не поднялся');
  const page = targets.find((t) => t.type === 'page');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      console.log(`[console.${msg.params.type}]`, text.slice(0, 300));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log('[exception]', JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  // Headless-страница без фокуса = background mode в tt (read-квитанции не шлются)
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url });
  await sleep(waitMs);

  for (const step of steps) {
    if (step.kind === 'eval') {
      const r = await send('Runtime.evaluate', { expression: step.value, awaitPromise: true, returnByValue: true });
      console.log('[eval]', JSON.stringify(r.result?.value)?.slice(0, 500));
    } else if (step.kind === 'click') {
      const [x, y] = step.value.split(',').map(Number);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } else if (step.kind === 'type') {
      for (const ch of step.value) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
        await send('Input.dispatchKeyEvent', { type: 'keyUp' });
      }
    } else if (step.kind === 'key') {
      const keyMap = { Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' } };
      const k = keyMap[step.value] || { key: step.value };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    } else if (step.kind === 'pause') {
      await sleep(Number(step.value));
    }
    await sleep(stepPause);
  }

  if (shotPath) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('[shot]', shotPath);
  }
}

// Штатное закрытие через CDP Browser.close — только оно флашит localStorage
// leveldb на диск (SIGTERM/SIGKILL теряют несохранённые данные)
async function gracefulClose() {
  try {
    const resp = await fetch(`http://localhost:${debugPort}/json/version`);
    const info = await resp.json();
    const browserWs = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { browserWs.onopen = resolve; browserWs.onerror = reject; });
    await new Promise((resolve) => {
      browserWs.onclose = resolve;
      browserWs.send(JSON.stringify({ id: 99999, method: 'Browser.close' }));
      setTimeout(resolve, 4000);
    });
  } catch {
    // fallback ниже
  }
}

main()
  .catch((err) => { console.error('[cdp] ошибка:', err.message); process.exitCode = 1; })
  .finally(async () => {
    await gracefulClose();
    await new Promise((resolve) => {
      const guard = setTimeout(() => { chrome.kill('SIGKILL'); resolve(); }, 3000);
      chrome.on('exit', () => { clearTimeout(guard); resolve(); });
      chrome.kill();
    });
    process.exit();
  });
