// Раздача сборки web для сценариев PWA — как Caddy на проде (`backend/infra/deploy/Caddyfile`): `/assets/*`
// кэшируются навсегда, пропавший файл — настоящий 404; остальное — «всегда перепроверять», неизвестный путь —
// главная страница. Выкладка — подмена каталога целиком (`deploy`), как делает `deploy.sh`.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};
// Картинки эмодзи (120 МБ) и карты исходников оболочке не нужны — копия сборки без них
const RE_SKIPPED = /(?:^|\/)(?:img-apple-\d+|statoscope-report\.html)$|\.map$/;

/** Копия сборки во временный каталог (сама сборка общая для параллельных сценариев — её не трогаем). */
function copyBuild(distDir) {
  const dir = mkdtempSync(join(tmpdir(), 'parvane-pwa-site.'));
  cpSync(distDir, dir, { recursive: true, filter: (source) => !RE_SKIPPED.test(source) });
  return dir;
}

export function readBuild(distDir) {
  const { build, files } = JSON.parse(readFileSync(join(distDir, 'precache.json'), 'utf8'));
  const entry = readFileSync(join(distDir, 'index.html'), 'utf8').match(/src="\.\/(assets\/index-[\w-]+\.js)"/)?.[1];
  return { build, files, entry };
}

export async function startStaticSite(distDir) {
  let root = copyBuild(distDir);

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const isAsset = pathname.startsWith('/assets/');
    let file = join(root, normalize(pathname));
    const isFound = file.startsWith(root) && existsSync(file) && statSync(file).isFile();
    if (!isFound && isAsset) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    if (!isFound) file = join(root, 'index.html');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate',
    });
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Выкладка: каталог заменяется целиком, файлов прежней сборки на сервере больше нет. */
    deploy(nextDistDir) {
      const previous = root;
      root = copyBuild(nextDistDir);
      rmSync(previous, { recursive: true, force: true });
    },
    async close() {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
