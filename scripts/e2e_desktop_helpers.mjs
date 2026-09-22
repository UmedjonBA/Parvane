// Общие помощники кросс-клиентских сценариев: запуск desktop-форка tdesktop
// (через gateway TCP) рядом с Web-клиентами на одном production-like стеке.
// Используют e2e_web_cross_client.mjs, e2e_web_cross_emoji.mjs и другие.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export const DESKTOP_BIN = process.env.PARVANE_E2E_DESKTOP_BIN
  || new URL('../desktop/build-probe/bin/Telegram', import.meta.url).pathname;
export const DESKTOP_READY_PATTERN = /E2E-устройство готово/;

// Без собранного бинаря сценарий не проверяет ничего — печатаем SKIP и
// выходим с 0, как остальные кросс-сценарии
export function skipWithoutDesktop(scenario) {
  if (existsSync(DESKTOP_BIN)) return;
  console.log(`SKIP: desktop binary is not built (${DESKTOP_BIN}); ${scenario} needs a local build`);
  process.exit(0);
}

export function requireGatewayTcpUrl() {
  const url = process.env.PARVANE_E2E_GATEWAY_TCP_URL;
  assert(url, 'PARVANE_E2E_GATEWAY_TCP_URL is required');
  return url;
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Rolling-release окружение может обновить soname системных библиотек после
// сборки бинаря (libjxl 0.11 -> 0.12); подставляем совместимые симлинки
export function buildLibraryShim(shimDir) {
  const aliases = [
    ['libjxl.so.0.11', 'libjxl.so.0.12'],
    ['libjxl_threads.so.0.11', 'libjxl_threads.so.0.12'],
  ];
  let hasShim = false;
  for (const [wanted, actual] of aliases) {
    if (!existsSync(`/usr/lib/${wanted}`) && existsSync(`/usr/lib/${actual}`)) {
      symlinkSync(`/usr/lib/${actual}`, join(shimDir, wanted));
      hasShim = true;
    }
  }
  return hasShim ? shimDir : undefined;
}

export function spawnDesktop(workdir, shimDir, env) {
  return spawn(DESKTOP_BIN, ['-workdir', join(workdir, 'td')], {
    env: {
      ...process.env,
      QT_QPA_PLATFORM: 'offscreen',
      PARVANE_GATEWAY_URL: requireGatewayTcpUrl(),
      ...(shimDir ? { LD_LIBRARY_PATH: shimDir } : {}),
      ...env,
    },
    stdio: 'ignore',
  });
}

export function readDesktopLog(workdir) {
  try {
    return readFileSync(join(workdir, 'td', 'log.txt'), 'utf8');
  } catch {
    return '';
  }
}

// Ждёт строку лога; `since` — длина лога, с которой искать (чтобы не поймать
// маркер прошлого запуска в том же workdir). tdesktop при старте может начать
// log.txt заново — если лог стал короче `since`, ищем с начала
export async function waitDesktopLog(workdir, pattern, timeoutMs, child, { since = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const full = readDesktopLog(workdir);
    // since — прежнее содержимое лога (строка) или его длина: новое ищем
    // только после него, а если лог начат заново — во всём файле
    const previous = typeof since === 'string' ? since : undefined;
    let log = full;
    if (previous !== undefined) {
      if (full.startsWith(previous)) log = full.slice(previous.length);
    } else if (full.length >= since) {
      log = full.slice(since);
    }
    const match = log.match(pattern);
    if (match) return match;
    if (child.exitCode !== null) {
      throw new Error(`desktop exited with code ${child.exitCode} while waiting for ${pattern}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  throw new Error(`Timed out waiting desktop log ${pattern}; tail:\n${readDesktopLog(workdir).slice(-2000)}`);
}

export async function stopDesktop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
