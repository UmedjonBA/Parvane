import { useEffect, useRef } from '../lib/teact/teact';

import type { ParvaneModuleId } from '../util/parvaneModules';

import { setModuleOn } from '../util/parvaneModules';
import useFlag from './useFlag';
import useLastCallback from './useLastCallback';
import useParvaneModules from './useParvaneModules';

// Parvane (spec 041 E6, доска `PhStates`): действие карточки в чате ведёт в модуль. Модуль выключен на этом
// устройстве — вместо действия открывается лист «Модуль выключен»; «Включить» включает модуль и выполняет
// действие. Модуль, выключенный сервером (MODULES-1), включить нельзя: `canEnable` у него ложно
export default function useModuleGate(id: ParvaneModuleId) {
  const { states, enabled } = useParvaneModules();
  const isOn = enabled.includes(id);
  const state = states.find((item) => item.id === id);
  const canEnable = Boolean(state && !isOn && !state.isServerOff && !state.isUnavailable);
  const [isAsked, ask, close] = useFlag();
  const pendingRef = useRef<NoneToVoidFunction>();

  const run = useLastCallback((action: NoneToVoidFunction) => {
    if (isOn) {
      action();
      return;
    }
    pendingRef.current = action;
    ask();
  });

  const enable = useLastCallback(() => {
    close();
    setModuleOn(id, true);
  });

  const dismiss = useLastCallback(() => {
    pendingRef.current = undefined;
    close();
  });

  // Список модулей пересчитывает движок — действие выполняется, когда модуль в нём появился
  useEffect(() => {
    const action = pendingRef.current;
    if (!isOn || !action) return;
    pendingRef.current = undefined;
    action();
  }, [isOn]);

  return {
    isOn, canEnable, isAsked, run, enable, dismiss,
  };
}
