import { DEBUG } from '../config';
import { createCallbackManager } from './callbacks';

export enum Bundles {
  Auth,
  Main,
  Extra,
  Calls,
  Stars,
}

interface ImportedBundles {
  [Bundles.Auth]: typeof import('../bundles/auth');
  [Bundles.Main]: typeof import('../bundles/main');
  [Bundles.Extra]: typeof import('../bundles/extra');
  [Bundles.Calls]: typeof import('../bundles/calls');
  [Bundles.Stars]: typeof import('../bundles/stars');
}

type BundlePromises = {
  [K in keyof ImportedBundles]: Promise<ImportedBundles[K]>
};

export type BundleModules<B extends keyof ImportedBundles> = keyof ImportedBundles[B];

const LOAD_PROMISES: Partial<BundlePromises> = {};
const MEMORY_CACHE: Partial<ImportedBundles> = {};

const { addCallback, runCallbacks } = createCallbackManager();

export async function loadBundle<B extends Bundles>(bundleName: B) {
  if (!LOAD_PROMISES[bundleName]) {
    switch (bundleName) {
      case Bundles.Auth:
        LOAD_PROMISES[Bundles.Auth] = import('../bundles/auth');
        break;
      case Bundles.Main:
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.log('>>> START LOAD MAIN BUNDLE');
        }

        LOAD_PROMISES[Bundles.Main] = import('../bundles/main');
        break;
      case Bundles.Extra:
        LOAD_PROMISES[Bundles.Extra] = import('../bundles/extra');
        break;
      case Bundles.Calls:
        LOAD_PROMISES[Bundles.Calls] = import('../bundles/calls');
        break;
      case Bundles.Stars:
        LOAD_PROMISES[Bundles.Stars] = import('../bundles/stars');
        break;
    }

    // Провалившийся динамический импорт НЕЛЬЗЯ оставлять в кэше: иначе один
    // сетевой сбой (или чанк, удалённый деплоем — имена содержат хэш, а
    // deploy.sh заменяет web-dist целиком) навсегда ломает бандл в этой
    // вкладке, и экран остаётся на спиннере без единой ошибки.
    (LOAD_PROMISES[bundleName]!).then(runCallbacks, () => {
      delete LOAD_PROMISES[bundleName];
    });
  }

  const bundle = (await LOAD_PROMISES[bundleName]) as unknown as ImportedBundles[B];

  if (!MEMORY_CACHE[bundleName]) {
    MEMORY_CACHE[bundleName] = bundle;
  }

  return bundle;
}

export async function loadModule<B extends Bundles>(bundleName: B) {
  await loadBundle(bundleName);
}

export function getModuleFromMemory<B extends Bundles, M extends BundleModules<B>>(
  bundleName: B, moduleName: M,
): ImportedBundles[B][M] | undefined {
  const bundle = MEMORY_CACHE[bundleName] as ImportedBundles[B];

  if (!bundle) {
    return undefined;
  }

  return bundle[moduleName];
}

export const addLoadListener = addCallback;

const CHUNK_RELOAD_MARK = 'parvane:chunk-reload';

// Имена чанков содержат хэш, а деплой заменяет web-dist целиком, поэтому
// открытая вкладка со старым index.html просит файлы, которых на сервере уже
// нет. Единственное лечение — перечитать index.html. Строго одноразово: иначе
// при настоящем обрыве сети вкладка ушла бы в цикл перезагрузок.
export function isStaleChunkError(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /ChunkLoadError|dynamically imported module|Importing a module script failed/i
    .test(message);
}

export function recoverFromStaleChunk(error: unknown) {
  if (!isStaleChunkError(error)) return false;
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_MARK)) return false;
    sessionStorage.setItem(CHUNK_RELOAD_MARK, '1');
  } catch {
    return false; // приватный режим/заблокированное хранилище — просто не грузим
  }
  window.location.reload();
  return true;
}

export function clearStaleChunkMark() {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_MARK);
  } catch {
    // хранилище недоступно — метка и не ставилась
  }
}
