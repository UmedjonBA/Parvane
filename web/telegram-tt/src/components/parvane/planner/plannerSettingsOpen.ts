import { getActions } from '../../../global';

import { LeftColumnContent, SettingsScreens } from '../../../types';

import { setParvaneSection } from '../../../util/parvaneSection';

// Parvane (spec 041, доски `RdPlanSet`, `PhModSettings`): настройки «Плана» — страница «Профиль → Модули / План»,
// а не окно поверх раздела. Её открывают шестерёнка «Плана» и команда палитры
export function openPlannerSettingsPage() {
  const { openLeftColumnContent, openSettingsScreen } = getActions();
  setParvaneSection('messenger');
  openLeftColumnContent({ contentKey: LeftColumnContent.Settings });
  openSettingsScreen({ screen: SettingsScreens.ParvanePlanSettings });
}
