// spec 035 T117: модель не открылась, потому что данные устройства записаны более новой версией (`TOO_NEW`), —
// своё объяснение «обновите приложение, чтобы открыть переписку», а не «сервер больше не поддерживает эту версию»
// (`UPGRADE_REQUIRED` — отказ сервера). Строки — EN и RU.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import * as engine from './v2/engine';

const SRC = path.join(__dirname, '../..');

function strings(file: string) {
  return readFileSync(path.join(SRC, 'assets/localization', file), 'utf8');
}

describe('T117: данные устройства от более новой версии', () => {
  it('TOO_NEW — свой код отказа, не UPGRADE_REQUIRED сервера', () => {
    const { modelOpenFailure, MODEL_TOO_NEW } = engine as unknown as {
      modelOpenFailure?: (state: string) => string; MODEL_TOO_NEW?: string;
    };
    expect(modelOpenFailure).toBeTypeOf('function');
    expect(modelOpenFailure!('OPEN_STATE_TOO_NEW')).toBe(MODEL_TOO_NEW);
    expect(modelOpenFailure!('OPEN_STATE_TOO_NEW')).not.toBe('ERROR_CODE_UPGRADE_REQUIRED');
    expect(modelOpenFailure!('OPEN_STATE_LOCKED')).toBe('ERROR_CODE_UNAVAILABLE');
  });

  it('диалог и строки EN+RU', () => {
    expect(strings('fallback.strings')).toMatch(/"ParvaneDataNeedsUpdate" = "[^"]*newer version[^"]*"/);
    expect(strings('ru.strings')).toMatch(/"ParvaneDataNeedsUpdate" = "[^"]*более новой версией[^"]*"/);
    const main = readFileSync(path.join(SRC, 'components/main/Main.tsx'), 'utf8');
    expect(main).toContain('addEventListener(DATA_TOO_NEW_EVENT, handleDataTooNew)');
    expect(main).toContain('text: { key: \'ParvaneDataNeedsUpdate\' }');
    const controller = readFileSync(path.join(__dirname, 'v2/controller.ts'), 'utf8');
    expect(controller).toContain('if (e instanceof V2Error && e.code === MODEL_TOO_NEW) deps.onDataTooNew?.();');
  });
});
