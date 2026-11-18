import { getActions } from '../../global';

import type { ParvaneModuleId } from '../../util/parvaneModules';
import type { ParvaneSection } from '../../util/parvaneSection';
import type { ParvaneIconName } from './ParvaneIcon';
import { LeftColumnContent, SettingsScreens } from '../../types';

import {
  openFiles, openHealth, openNotes, openPlannerCalendar, setParvaneSection,
} from '../../util/parvaneSection';

// Parvane: общее для ленты модулей (телефон) и боковой панели (компьютер) — значок, подпись, «какой модуль
// сейчас открыт» и переход в модуль
export const MODULE_ICONS: Record<ParvaneModuleId, ParvaneIconName> = {
  chats: 'chat',
  plan: 'calendar',
  health: 'heart',
  notes: 'note',
  files: 'folder',
  music: 'music',
  profile: 'user',
};

export const MODULE_TITLE_KEYS = {
  chats: 'ParvaneSectionMessenger',
  plan: 'ParvaneSectionPlanner',
  health: 'PlannerHealth',
  notes: 'ParvaneModuleNotes',
  files: 'ParvaneModuleFiles',
  music: 'ParvaneModuleMusic',
  profile: 'ParvaneTabBarProfile',
} as const satisfies Record<ParvaneModuleId, string>;

export function getActiveModule(section: ParvaneSection, isSettingsOpen: boolean): ParvaneModuleId {
  if (section === 'health') return 'health';
  if (section === 'music') return 'music';
  if (section === 'planner') return 'plan';
  if (section === 'notes' || section === 'files') return section;
  return isSettingsOpen ? 'profile' : 'chats';
}

export function openModule(id: ParvaneModuleId, isSettingsOpen: boolean) {
  const { openLeftColumnContent, openSettingsScreen } = getActions();
  switch (id) {
    case 'chats':
      setParvaneSection('messenger');
      if (isSettingsOpen) openLeftColumnContent({ contentKey: LeftColumnContent.ChatList });
      break;
    case 'plan':
      openPlannerCalendar();
      break;
    case 'health':
      openHealth();
      break;
    case 'music':
      setParvaneSection('music');
      break;
    case 'notes':
      openNotes();
      break;
    case 'files':
      openFiles();
      break;
    case 'profile':
      setParvaneSection('messenger');
      openLeftColumnContent({ contentKey: LeftColumnContent.Settings });
      openSettingsScreen({ screen: SettingsScreens.Main });
      break;
    default:
      break;
  }
}
