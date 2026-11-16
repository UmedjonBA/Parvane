import { getActions } from '../../global';

import type { ParvaneModuleId } from '../../util/parvaneModules';
import type { KnowledgeView, ParvaneSection } from '../../util/parvaneSection';
import type { ParvaneIconName } from './ParvaneIcon';
import { LeftColumnContent, SettingsScreens } from '../../types';

import {
  openHealth, openKnowledgeView, openPlannerCalendar, setParvaneSection,
} from '../../util/parvaneSection';

// Parvane: общее для ленты модулей (телефон) и боковой панели (компьютер) — значок, подпись, «какой модуль
// сейчас открыт» и переход в модуль. «Файлы» пока вкладка «Знаний»
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

export function getActiveModule(
  section: ParvaneSection, knowledgeView: KnowledgeView, isSettingsOpen: boolean,
): ParvaneModuleId {
  if (section === 'health') return 'health';
  if (section === 'planner') return 'plan';
  if (section === 'cloud') return knowledgeView === 'files' ? 'files' : 'notes';
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
    case 'notes':
      openKnowledgeView('notes');
      break;
    case 'files':
      openKnowledgeView('files');
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
