import type { GlobalState } from '../global/types';

import { IS_MOCKED_CLIENT } from '../config';
import {
  loadCachedParvaneSettings, loadCachedParvaneThemes, loadCachedSharedState,
} from '../global/cache';
import {
  getGlobal, setGlobal,
} from '../global/index';
import { INITIAL_GLOBAL_STATE } from '../global/initialState';
import { cloneDeep } from './iteratees';

export async function initGlobal(force: boolean = false, prevGlobal?: GlobalState) {
  prevGlobal = prevGlobal || getGlobal();
  if (!force && 'byTabId' in prevGlobal) {
    return;
  }

  const initial = cloneDeep(INITIAL_GLOBAL_STATE);
  // Parvane: полного global-кэша нет — MTProto-сессии нет, `saveSession` не диспатчится, и `loadCache`
  // лишь делал два лишних чтения IndexedDB (global и sharedState), а потом sharedState читался ещё раз.
  // Что переживает перезапуск, читается одной волной (B1): общие настройки устройства (тема, анимации),
  // настройки аккаунта (уведомления, автозагрузка) и фон чата по темам (spec 014)
  const [storedSharedState, storedSettings, storedThemes] = await Promise.all([
    loadCachedSharedState(),
    loadCachedParvaneSettings(),
    loadCachedParvaneThemes(),
  ]);

  let global = initial;
  if (IS_MOCKED_CLIENT) global.auth.state = 'authorizationStateReady';

  if (force) {
    global.byTabId = prevGlobal.byTabId;
  }

  if (storedSharedState) {
    global.sharedState = storedSharedState;
  }
  if (storedSettings) {
    global = {
      ...global,
      settings: {
        ...global.settings,
        byKey: { ...global.settings.byKey, ...storedSettings },
      },
    };
  }
  if (storedThemes) {
    global = {
      ...global,
      settings: {
        ...global.settings,
        themes: {
          light: { ...global.settings.themes.light, ...storedThemes.light },
          dark: { ...global.settings.themes.dark, ...storedThemes.dark },
        },
      },
    };
  }

  setGlobal(global);
}
