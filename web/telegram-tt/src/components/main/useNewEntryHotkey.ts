import { useLayoutEffect } from '../../lib/teact/teact';
import { getActions, getGlobal } from '../../global';

import { LeftColumnContent } from '../../types';

import { selectLeftColumnContentKey } from '../../global/selectors';
import {
  getParvaneSection, requestModuleAdd, requestPlannerAdd, requestPlannerAddInPlace, setParvaneSection,
} from '../../util/parvaneSection';
import { isNewEntryHotkey, selectNewEntryAction } from './newEntryKeys';
import { getActiveModule } from './parvaneModuleNav';

// Parvane (доски `ZdNav`, `DeskOverlays`): Ctrl+N из любого места — новое в открытом модуле. В браузерной вкладке
// Chromium сочетание забирает себе (новое окно); в установленном приложении и сценариях оно доходит до страницы
export default function useNewEntryHotkey() {
  // Слушатель ставится до первого кадра: сочетание сразу после запуска не теряется
  useLayoutEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isNewEntryHotkey(e)) return;
      e.preventDefault();
      const isSettingsOpen = selectLeftColumnContentKey(getGlobal()) === LeftColumnContent.Settings;
      const action = selectNewEntryAction(getActiveModule(getParvaneSection(), isSettingsOpen));
      if (action === 'message') {
        setParvaneSection('messenger');
        getActions().openLeftColumnContent({ contentKey: LeftColumnContent.Contacts });
      } else if (action === 'note') {
        requestModuleAdd('note');
      } else if (action === 'plan') {
        requestPlannerAdd();
      } else {
        requestPlannerAddInPlace();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
