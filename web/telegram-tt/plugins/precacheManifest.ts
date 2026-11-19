import { existsSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Plugin } from 'vite';

// Список файлов оболочки приложения для сервис-воркера (`src/serviceWorker/precache.ts`, spec 041 F1): главная
// страница, `compatTest.js`, воркеры и всё из `assets/` — части кода, стили, шрифты, WASM, значки. Не входят
// карты исходников, картинки эмодзи (`img-apple-*`, 120 МБ), звуки и отдельные страницы (`s.html`, `download.html`)
const PRECACHE_FILE_NAME = 'precache.json';
const ROOT_PAGE = './';
const ROOT_FILES = ['compatTest.js'];
const RE_ROOT_WORKER = /^(?!service\.)[\w.]+\.worker-[\w-]{8}\.js$/;
const RE_ASSET = /\.(?:m?js|css|woff2?|wasm|svg|png|jpe?g|webp|tgs)$/;

export default function buildPrecacheManifestPlugin(appBuild: string): Plugin {
  let outDir = '';

  return {
    name: 'parvane-precache-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // Воркеры собираются вложенными сборками, копии библиотек кладёт другой плагин — список снимается с диска
    // последним шагом
    closeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        const assetsDir = resolve(outDir, 'assets');
        // Сборка упала раньше записи: её ошибку не заслонять своей
        if (!existsSync(assetsDir)) return;
        const rootFiles = readdirSync(outDir).filter((name) => ROOT_FILES.includes(name) || RE_ROOT_WORKER.test(name));
        const assets = readdirSync(assetsDir).filter((name) => RE_ASSET.test(name)).map((name) => `assets/${name}`);
        const files = [ROOT_PAGE, ...rootFiles.sort(), ...assets.sort()];
        writeFileSync(resolve(outDir, PRECACHE_FILE_NAME), JSON.stringify({ build: appBuild, files }));
      },
    },
  };
}
