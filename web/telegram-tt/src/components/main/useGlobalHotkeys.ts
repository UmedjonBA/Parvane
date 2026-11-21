import { useLayoutEffect } from '../../lib/teact/teact';
import { getGlobal } from '../../global';

import { LeftColumnContent } from '../../types';

import { selectLeftColumnContentKey } from '../../global/selectors';
import { IS_MAC_OS } from '../../util/browser/windowEnvironment';
import { getModulesView } from '../../util/parvaneModules';
import { getCurrentTrack, togglePlay } from '../parvane/music/musicPlayer';
import { matchGlobalHotkey } from './globalHotkeys';
import { openModule } from './parvaneModuleNav';

function getIsSettingsOpen() {
  return selectLeftColumnContentKey(getGlobal()) === LeftColumnContent.Settings;
}

// Parvane (доска `ZdNav`): сочетания «Везде» — Ctrl+1 … 7 (модуль по порядку ленты), Ctrl+, («Профиль»),
// Ctrl+Пробел (пауза и продолжение музыки, когда есть трек), Ctrl+/ (окно со списком). Слушатель ставится до первого
// кадра и в фазе перехвата: нажатие сразу после запуска не теряется, поле ввода его не забирает
export default function useGlobalHotkeys(onHelp: NoneToVoidFunction) {
  useLayoutEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const hotkey = matchGlobalHotkey(e, IS_MAC_OS);
      if (!hotkey) return;
      if (hotkey.kind === 'music') {
        if (!getCurrentTrack()) return;
        e.preventDefault();
        togglePlay();
        return;
      }
      if (hotkey.kind === 'module') {
        const id = getModulesView().enabled[hotkey.index];
        if (!id) return;
        e.preventDefault();
        openModule(id, getIsSettingsOpen());
        return;
      }
      e.preventDefault();
      if (hotkey.kind === 'help') onHelp();
      else openModule('profile', getIsSettingsOpen());
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onHelp]);
}
