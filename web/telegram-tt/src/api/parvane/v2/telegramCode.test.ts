import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { isTelegramCodeIntercepted } from './telegramCode';

function between(src: string, from: string, to: string) {
  return src.slice(src.indexOf(from), src.indexOf(to));
}

describe('S7-1: код запроса ключа через Telegram', () => {
  it('другой код из опроса — перехват, свой — нет', () => {
    expect(isTelegramCodeIntercepted('111111', '111111')).toBe(false);
    expect(isTelegramCodeIntercepted('111111', '222222')).toBe(true);
    // Своего кода нет (перезапуск) — код из опроса берётся
    expect(isTelegramCodeIntercepted('', '222222')).toBe(false);
    // Опрос без кода (запрос истёк) — не перехват
    expect(isTelegramCodeIntercepted('111111', '')).toBe(false);
    expect(isTelegramCodeIntercepted('111111', undefined)).toBe(false);
  });

  it('контроллер не заменяет показанный код кодом из опроса и не ждёт перехваченного ответа', () => {
    const src = readFileSync(join(__dirname, 'controller.ts'), 'utf8');
    const poll = between(src, 'async function pollTelegramKey(', 'async function applyBundleGroups(');
    expect(poll).not.toContain('if (r.code) telegramCode = r.code;');
    expect(poll).toContain('isTelegramCodeIntercepted(telegramCode, r.code)');
    expect(poll).toContain('intercepted: true');
    const request = between(src, 'async function requestTelegramKey(', 'async function pollTelegramKey(');
    expect(request).toContain('e.code === \'ERROR_CODE_FORBIDDEN\') return \'intercepted\'');
    const provider = readFileSync(join(__dirname, '..', 'provider.ts'), 'utf8');
    const loop = between(provider, 'async function pollTelegramRecovery(', 'async function joinWithTelegramKey(');
    expect(loop).toContain('stopTelegramRecovery(\'intercepted\')');
  });
});
