import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { encodeMessage, initSync } from '../../../lib/parvane-protocol/parvane_protocol';

const WASM = path.resolve(__dirname, '../../../lib/parvane-protocol/parvane_protocol_bg.wasm');

// Федерация (spec 028): ключ чужого сервера web проверяет по описателю из `server.describe` с адресатом —
// описатель приходит proto3-JSON и кодируется движком обратно в байты для проверки подписи. Без типа в
// таблице кодека обвязки письмо незнакомцу с другого сервера падало с UnknownMethod
describe('федерация: кодек описателя сервера', () => {
  beforeAll(() => {
    initSync({ module: readFileSync(WASM) });
  });

  it('SignedServerDescriptor кодируется движком', () => {
    const json = JSON.stringify({ descriptor: 'AQI=', signature: 'AwQ=' });
    const bytes = encodeMessage('parvane.core.v2.SignedServerDescriptor', json);
    expect(Array.from(bytes)).toEqual([10, 2, 1, 2, 18, 2, 3, 4]);
  });
});
