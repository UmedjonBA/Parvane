import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { initSync } from '../src/lib/parvane-protocol/parvane_protocol';

// В браузере WASM-движок грузится по URL (`v2/engine.ts`); в vitest сервера
// нет, поэтому модуль инициализируется из файла — `loadProtocol()` после
// этого возвращает уже готовый движок
initSync({
  module: readFileSync(path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm')),
});
