// spec 035 (contracts/versioning.md, T058): `engineInfo()` движка из файла WASM (web-dist).
// node scripts/engine_info_wasm.mjs <файл .wasm> [glue .js]
// glue по умолчанию — web/telegram-tt/src/lib/parvane-protocol/parvane_protocol.js (тот же выход wasm-bindgen).
// Печатает JSON engineInfo; не открылся — код выхода 1.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [wasmPath, gluePath] = process.argv.slice(2);
if (!wasmPath) {
  console.error('использование: engine_info_wasm.mjs <файл .wasm> [glue .js]');
  process.exit(2);
}
const glue = gluePath || resolve(root, 'web/telegram-tt/src/lib/parvane-protocol/parvane_protocol.js');
try {
  const mod = await import(pathToFileURL(glue).href);
  mod.initSync({ module: readFileSync(wasmPath) });
  const info = JSON.parse(mod.engineInfo());
  process.stdout.write(`${JSON.stringify(info)}\n`);
} catch (e) {
  console.error(`engineInfo: ${e && e.message ? e.message : e}`);
  process.exit(1);
}
