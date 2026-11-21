import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';

import { consumePlannerAddRequest, getPlannerAddRequest, requestPlannerMore } from '../../../util/parvaneSection';
import { toDayKey } from './plannerModel';
import {
  getHasQuickLines, getIsPlannerLoaded, getPlannerState, getPlannerStatus, loadPlanner,
} from './plannerStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLastCallback from '../../../hooks/useLastCallback';

import PlannerQuickInput from './PlannerQuickInput';

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Окно «Новая запись» вне самого «Плана» (доска `DeskOverlays`): смонтировано в `Main`, запрос
// `requestPlannerAddInPlace` (Ctrl+N, «Запланировать» в заметке) открывает окно поверх открытого модуля. Запись
// добавляется, раздел остаётся прежним; «Подробнее» переходит в «План» к полной форме. Данные «Плана» читаются
// при первом запросе, а не при запуске приложения
const PlannerQuickHost = () => {
  const state = useDerivedState(getPlannerState);
  const isLoaded = useDerivedState(getIsPlannerLoaded);
  const syncStatus = useDerivedState(getPlannerStatus);
  const hasQuickLines = useDerivedState(getHasQuickLines);
  const request = useDerivedState(getPlannerAddRequest);
  const currentUserId = useSelector(selectCurrentUserId);

  const [isOpen, open, close] = useFlag();
  const [text, setText] = useState('');
  const [today, setToday] = useState(() => toDayKey(new Date()));

  const isRequested = Boolean(request?.isInPlace);
  useEffect(() => {
    if (isRequested) void loadPlanner(currentUserId);
  }, [isRequested, currentUserId]);

  useEffect(() => {
    if (!request?.isInPlace || !isLoaded) return;
    consumePlannerAddRequest();
    setToday(toDayKey(new Date()));
    setText(request.text || '');
    open();
  }, [request, isLoaded]);

  const isSynced = isLoaded && (syncStatus === 'ready' || syncStatus === 'offline');

  const handleCreated = useLastCallback(() => {
    close();
  });

  const handleMore = useLastCallback(() => {
    close();
    requestPlannerMore();
  });

  return (
    <PlannerQuickInput
      isOpen={isOpen}
      initialText={text}
      today={today}
      settings={state.settings}
      userId={currentUserId}
      learnedWords={state.learned}
      isLearnedSynced={isSynced}
      quickLines={isSynced && hasQuickLines ? state.quickLines : undefined}
      tasks={state.tasks}
      events={state.events}
      onCreated={handleCreated}
      onMore={handleMore}
      onClose={close}
    />
  );
};

export default memo(PlannerQuickHost);
