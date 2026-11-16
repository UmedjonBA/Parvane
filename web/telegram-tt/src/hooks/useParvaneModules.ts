import { getModulesView } from '../util/parvaneModules';
import useDerivedState from './useDerivedState';

// Parvane: список модулей устройства для экрана — перерисовывает при смене настроек и ответа сервера.
// `states` — все модули для экрана «Модули», `enabled` — включённые в порядке навигации
export default function useParvaneModules() {
  const view = useDerivedState(getModulesView);
  return { prefs: view.prefs, states: view.modules, enabled: view.enabled };
}
