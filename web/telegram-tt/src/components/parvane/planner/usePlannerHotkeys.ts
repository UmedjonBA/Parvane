import { useLayoutEffect } from '../../../lib/teact/teact';

import { isEditableTarget } from '../palette/paletteKeys';
import { matchPlannerHotkey } from './plannerHotkeys';

import useLastCallback from '../../../hooks/useLastCallback';

type Handlers = {
  onNew: NoneToVoidFunction;
  onToday: NoneToVoidFunction;
  onPrev: NoneToVoidFunction;
  onNext: NoneToVoidFunction;
};

// Строка задачи (`PlannerTaskRow`): Пробел на ней отмечает выполнение её флажком
const TASK_ROW_SELECTOR = '[data-task-id]';
const TASK_CHECK_SELECTOR = 'input[type="checkbox"]';

// Parvane (доска `ZdNav`): клавиши «Плана», пока открыт его вид без карточки, формы и окна ввода
export default function usePlannerHotkeys(isActive: boolean, handlers: Handlers) {
  const handleKeyDown = useLastCallback((e: KeyboardEvent) => {
    const hotkey = matchPlannerHotkey(e, isEditableTarget(e.target));
    if (!hotkey) return;
    if (hotkey === 'done') {
      const target = e.target instanceof Element ? e.target : undefined;
      const check = target?.closest(TASK_ROW_SELECTOR)?.querySelector<HTMLInputElement>(TASK_CHECK_SELECTOR);
      if (!check) return;
      e.preventDefault();
      check.click();
      return;
    }
    e.preventDefault();
    if (hotkey === 'new') handlers.onNew();
    else if (hotkey === 'today') handlers.onToday();
    else if (hotkey === 'prev') handlers.onPrev();
    else handlers.onNext();
  });

  useLayoutEffect(() => {
    if (!isActive) return undefined;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isActive, handleKeyDown]);
}
