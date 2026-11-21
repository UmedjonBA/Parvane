import {
  memo, useLayoutEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { CloudMenuAction } from '../cloud/CloudMenu';
import type { TaskOfferDraft } from '../taskOffer/TaskOfferModal';
import type { PlannerState } from './plannerModel';
import type { PlannerRecordItem, PlannerRecordRef } from './plannerRecordActions';

import { formatPlainName } from './plannerLinks';
import { instanceKey, toMinutes, toTime } from './plannerModel';
import {
  deleteRecord, duplicateRecord, findRecord, moveRecord, setRecordGroup, toggleRecordDone,
} from './plannerRecordActions';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';
import CloudMenu from '../cloud/CloudMenu';
import TaskOfferModal from '../taskOffer/TaskOfferModal';
import PlannerFreeTime from './PlannerFreeTime';

// Что под курсором: запись (экземпляр ряда — с днём) либо пустое место шкалы дня (день и минута)
export type PlannerMenuTarget = { x: number; y: number }
  & ({ record: PlannerRecordRef; grid?: undefined } | { record?: undefined; grid: { day: string; minute: number } });

type OwnProps = {
  state: PlannerState;
  today: string;
  target: PlannerMenuTarget;
  onOpenTask: (taskId: string, day?: string) => void;
  onOpenEvent: (eventId: string, day: string) => void;
  onCreateAt: (day: string, start: number, end?: number) => void;
  onClose: NoneToVoidFunction;
};

type Stage = 'main' | 'layer' | 'freeTime' | 'recipient' | 'offer';

const NO_GROUP_KEY = '\u0000';
// Новая запись с пустого места шкалы и поиск окна — на час
const GRID_MINUTES = 60;
const GRID_STEP = 30;
// Размеры меню у курсора, как в `CloudMenu`: вложенное меню «Сменить слой» встаёт справа от своего пункта
const POP_ITEM_PX = 36;
const POP_PADDING_PX = 7;
const POP_WIDTH_PX = 240;
const EDGE_PX = 8;

// Меню записи по правой кнопке (доска `ZdPlanX`) и пустого места шкалы дня: «Открыть», «Отметить выполненной»,
// «Перенести на завтра», «Найти свободное время…», «Дублировать», «Сменить слой ›» (вложенное меню справа, первое
// остаётся открытым), «Предложить собеседнику…», «Удалить» — без значков и заголовка. Пока меню открыто, работают
// клавиши его подсказок
const PlannerRecordMenu = ({
  state, today, target, onOpenTask, onOpenEvent, onCreateAt, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [stage, setStage] = useState<Stage>('main');
  const [chatId, setChatId] = useState<string>();

  const record = target.record ? findRecord(state, target.record) : undefined;
  const gridStart = target.grid ? Math.floor(target.grid.minute / GRID_STEP) * GRID_STEP : 0;

  const layerActions = useMemo((): CloudMenuAction[] => [
    ...state.lists.map((list) => ({ key: list.name, title: list.name })),
    { key: NO_GROUP_KEY, title: lang('PlannerNoList') },
  ], [state.lists, lang]);

  const actions = useMemo((): CloudMenuAction[] => {
    if (!record) {
      return [
        { key: 'new', title: lang('PlannerMenuNewAt', { time: toTime(gridStart) }) },
        { key: 'freeTime', title: lang('PlannerMenuFreeTime') },
      ];
    }
    const isTask = record.kind === 'task';
    const isDone = isTask && record.item.status === 'done';
    return [
      { key: 'open', title: lang('PlannerMenuOpen'), hint: 'Enter' },
      ...(isTask ? [{
        key: 'done',
        title: lang(isDone ? 'PlannerMenuUndone' : 'PlannerMarkDone'),
        hint: lang('PlannerKeySpace'),
      } satisfies CloudMenuAction] : []),
      { key: 'tomorrow', title: lang('PlannerMenuTomorrow') },
      { key: 'freeTime', title: lang('PlannerMenuFreeTime') },
      { key: 'duplicate', title: lang('PlannerMenuDuplicate'), hint: 'Ctrl+D' },
      { key: 'layer', title: lang('PlannerMenuLayer'), hint: '›' },
      { key: 'offer', title: lang('PlannerMenuOffer') },
      {
        key: 'delete', title: lang('PlannerMenuDelete'), hint: 'Del', isDanger: true,
      },
    ];
  }, [record, gridStart, lang]);

  const handleLayerPick = useLastCallback((key: string) => {
    if (record) setRecordGroup(lang, record, key === NO_GROUP_KEY ? '' : key);
    onClose();
  });

  const handleLayerClose = useLastCallback(() => {
    setStage('main');
  });

  const handlePick = useLastCallback((key: string) => {
    if (!record) {
      if (key === 'freeTime') {
        setStage('freeTime');
        return;
      }
      onCreateAt(target.grid!.day, gridStart);
      onClose();
      return;
    }
    runRecordAction(key, record);
  });

  const runRecordAction = useLastCallback((key: string, item: PlannerRecordItem) => {
    const day = item.item.instanceDay || item.item.day;
    switch (key) {
      case 'open':
        if (item.kind === 'task') onOpenTask(item.item.id, item.item.instanceDay);
        else onOpenEvent(item.item.id, day || today);
        break;
      case 'done':
        if (item.kind === 'task') toggleRecordDone(lang, item.item);
        break;
      case 'tomorrow':
        moveRecord(lang, item, today, 'tomorrow');
        break;
      case 'duplicate':
        duplicateRecord(lang, item, today);
        break;
      case 'delete':
        deleteRecord(lang, item);
        break;
      case 'layer':
      case 'freeTime':
        setStage(key);
        return;
      case 'offer':
        setStage('recipient');
        return;
      default:
        break;
    }
    onClose();
  });

  // Клавиши подсказок меню: Enter, пробел, Ctrl+D, Del. Слушатель встаёт в кадре появления меню
  useLayoutEffect(() => {
    if (stage !== 'main' || !record) return undefined;
    const keys: Record<string, string> = { Enter: 'open', ' ': 'done', Delete: 'delete' };
    const handleKey = (e: KeyboardEvent) => {
      const key = (e.ctrlKey || e.metaKey) && e.code === 'KeyD' ? 'duplicate' : keys[e.key];
      if (!key || (key === 'done' && record.kind !== 'task')) return;
      e.preventDefault();
      e.stopPropagation();
      runRecordAction(key, record);
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [stage, record]);

  // Окно из «Найти свободное время»: запись встаёт на него, с пустого места шкалы — новая запись в это окно
  const handleFreeSlot = useLastCallback((day: string, start: number, end: number) => {
    onClose();
    if (!record) {
      onCreateAt(day, start, end);
      return;
    }
    moveRecord(lang, record, today, 'place', day, start, 1);
  });

  const handleRecipient = useLastCallback((peerId: string) => {
    setChatId(peerId);
    setStage('offer');
  });

  const offerDraft = useMemo((): TaskOfferDraft | undefined => {
    if (!record) return undefined;
    const day = record.item.instanceDay || record.item.day;
    if (record.kind === 'event') {
      const { item } = record;
      return {
        name: formatPlainName(item.name),
        description: item.description,
        steps: item.steps?.map((step) => step.text),
        day,
        start: item.isAllDay ? undefined : item.start,
        minutes: item.isAllDay ? undefined : toMinutes(item.end) - toMinutes(item.start),
      };
    }
    const { item } = record;
    return {
      name: formatPlainName(item.name),
      description: item.description,
      steps: item.steps.map((step) => step.text),
      day,
      start: item.start,
      minutes: item.minutes,
      due: item.due,
    };
  }, [record]);

  if (target.record && !record) return undefined;

  if (stage === 'freeTime') {
    const minutes = !record ? GRID_MINUTES
      : record.kind === 'task' ? record.item.minutes
        : toMinutes(record.item.end) - toMinutes(record.item.start);
    const fromDay = target.grid?.day || record?.item.instanceDay || record?.item.day || today;
    return (
      <PlannerFreeTime
        state={state}
        name={record ? formatPlainName(record.item.name) : lang('PlannerTitleNew')}
        minutes={minutes}
        fromDay={fromDay}
        today={today}
        exceptKey={record ? instanceKey(record.item) : undefined}
        onPick={handleFreeSlot}
        onClose={onClose}
      />
    );
  }

  if (stage === 'recipient' || stage === 'offer') {
    return (
      <>
        <RecipientPicker
          isOpen={stage === 'recipient'}
          title={lang('PlannerMenuOfferTitle')}
          searchPlaceholder={lang('Search')}
          onSelectRecipient={handleRecipient}
          onClose={onClose}
        />
        {chatId && <TaskOfferModal isOpen={stage === 'offer'} chatId={chatId} initial={offerDraft} onClose={onClose} />}
      </>
    );
  }

  // Место меню — как его ставит `CloudMenu`: вложенное меню слоёв встаёт справа от пункта «Сменить слой»
  const mainHeight = actions.length * POP_ITEM_PX + POP_PADDING_PX * 2;
  const mainLeft = Math.max(EDGE_PX, Math.min(target.x, window.innerWidth - POP_WIDTH_PX - EDGE_PX));
  const mainTop = Math.max(EDGE_PX, Math.min(target.y, window.innerHeight - mainHeight - EDGE_PX));
  const layerIndex = actions.findIndex((action) => action.key === 'layer');
  const subLeft = mainLeft + POP_WIDTH_PX + POP_WIDTH_PX + EDGE_PX > window.innerWidth
    ? mainLeft - POP_WIDTH_PX : mainLeft + POP_WIDTH_PX;

  return (
    <>
      <CloudMenu
        isOpen
        actions={actions}
        anchor={{ x: target.x, y: target.y }}
        onPick={handlePick}
        onClose={onClose}
      />
      {stage === 'layer' && (
        <CloudMenu
          isOpen
          title={lang('PlannerMenuLayer')}
          actions={layerActions}
          anchor={{ x: subLeft, y: mainTop + layerIndex * POP_ITEM_PX }}
          onPick={handleLayerPick}
          onClose={handleLayerClose}
        />
      )}
    </>
  );
};

export default memo(PlannerRecordMenu);
