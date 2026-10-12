import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';

import { consumePlannerAddRequest, getPlannerAddRequest } from '../../../util/parvaneSection';
import { toDayKey } from './plannerModel';
import {
  getIsPlannerLoaded, getPlannerState, getPlannerStatus, loadPlanner,
} from './plannerStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerQuickInput from './PlannerQuickInput';

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Окно ввода текстом «Плана» вне самого «Плана»: раздел («Знания») ставит этот компонент у себя, и запрос
// `requestPlannerAddInPlace` открывает окно поверх него. Запись добавляется, раздел остаётся прежним.
// Полной формы («Подробнее») здесь нет — она живёт в «Плане»
const PlannerQuickHost = () => {
  const state = useDerivedState(getPlannerState);
  const isLoaded = useDerivedState(getIsPlannerLoaded);
  const syncStatus = useDerivedState(getPlannerStatus);
  const request = useDerivedState(getPlannerAddRequest);
  const currentUserId = useSelector(selectCurrentUserId);

  const [isOpen, open, close] = useFlag();
  const [text, setText] = useState('');
  const [today, setToday] = useState(() => toDayKey(new Date()));

  useEffect(() => {
    void loadPlanner(currentUserId);
  }, [currentUserId]);

  useEffect(() => {
    if (!request?.isInPlace || !isLoaded) return;
    consumePlannerAddRequest();
    setToday(toDayKey(new Date()));
    setText(request.text || '');
    open();
  }, [request, isLoaded]);

  const handleCreated = useLastCallback(() => {
    close();
  });

  return (
    <PlannerQuickInput
      isOpen={isOpen}
      initialText={text}
      today={today}
      settings={state.settings}
      userId={currentUserId}
      learnedWords={state.learned}
      isLearnedSynced={isLoaded && (syncStatus === 'ready' || syncStatus === 'offline')}
      tasks={state.tasks}
      events={state.events}
      onCreated={handleCreated}
      onClose={close}
    />
  );
};

export default memo(PlannerQuickHost);
