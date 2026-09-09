import { useEffect } from '../lib/teact/teact';

import type { BundleModules, Bundles } from '../util/moduleLoader';

import { DEBUG } from '../config';
import {
  addLoadListener, clearStaleChunkMark, getModuleFromMemory, loadModule, recoverFromStaleChunk,
} from '../util/moduleLoader';
import useForceUpdate from './useForceUpdate';

const useModuleLoader = <B extends Bundles, M extends BundleModules<B>>(
  bundleName: B, moduleName: M, noLoad = false, autoUpdate = false,
) => {
  const module = getModuleFromMemory(bundleName, moduleName);
  const forceUpdate = useForceUpdate();

  useEffect(() => {
    if (!autoUpdate) {
      return undefined;
    }

    return addLoadListener(forceUpdate);
  }, [autoUpdate, forceUpdate]);

  useEffect(() => {
    if (!noLoad && !module) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log('Module load triggered', bundleName, moduleName);
      }
      loadModule(bundleName).then(() => {
        clearStaleChunkMark();
        forceUpdate();
      }, (error) => {
        // Без этой ветки промис отвергался молча: forceUpdate не звался,
        // экран навсегда оставался на <Loading /> и ошибки никто не видел.
        if (recoverFromStaleChunk(error)) return;
        // eslint-disable-next-line no-console
        console.error('Bundle load failed', bundleName, moduleName, error);
        forceUpdate(); // перерисовка → следующий заход попробует снова
      });
    }
  }, [bundleName, forceUpdate, module, moduleName, noLoad]);

  return module;
};

export default useModuleLoader;
