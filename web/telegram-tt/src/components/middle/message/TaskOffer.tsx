import { memo, useEffect, useMemo, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import type { ApiMessage, ApiTaskOffer, ApiUser } from '../../../api/types';

import { getUserFullName } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { getTaskOfferKind } from '../../../api/parvane/taskOffers';
import { getPlannerState, loadPlanner } from '../../parvane/planner/plannerStore';
import { formatOfferWhen } from '../../parvane/taskOffer/taskOfferFormat';
import { openOfferInPlan } from '../../parvane/taskOffer/taskOfferOpen';
import { offerInPlanKey, parseOfferInPlanKey } from '../../parvane/taskOffer/taskOfferPlan';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useModuleGate from '../../../hooks/useModuleGate';

import PvModuleOff from '../../parvane/notes/PvModuleOff';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './TaskOffer.module.scss';

type OwnProps = {
  message: ApiMessage;
  taskOffer: ApiTaskOffer;
};

type StateProps = {
  currentUserId?: string;
  usersById: Record<string, ApiUser>;
};

type RespondResult = 'ok' | 'exists' | 'needs-linking' | 'no-key' | 'unavailable' | 'failed';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Parvane (spec 011, US3): карточка в чате — «Задание» либо «Событие» (то же
// содержимое `task_offer`; событие — с днём и временем начала). Кнопка «В план» /
// «В календарь» — прежнее «Принять»: запись в плане и ответ-статус автору; после
// неё — «В плане · открыть». «Отклонить» и решения участников — как раньше.
// У Telegram такого сообщения нет (обоснование — план спеки, принцип VI)
const TaskOffer = ({
  message, taskOffer, currentUserId, usersById,
}: OwnProps & StateProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const [isBusy, setIsBusy] = useState(false);
  // Автор ответа себе не шлёт: его «в плане» — запись плана либо нажатие в этом сеансе
  const [isAdded, setIsAdded] = useState(false);
  // Производное от состояния плана — строка-ключ записи: карточка перерисовывается, только когда запись
  // по ней появляется, исчезает либо меняет день, а не на каждое изменение плана
  const plannedKey = useDerivedState(
    () => offerInPlanKey(getPlannerState(), taskOffer.id),
    // Сигнал состояния плана — зависимость: по нему производное пересчитывается
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
    [getPlannerState, taskOffer.id],
  );
  const planned = useMemo(() => parseOfferInPlanKey(plannedKey), [plannedKey]);

  // Состояние «Плана» поднимают его экраны; на устройстве, где «План» не открывали, карточка иначе не узнала бы,
  // что задание уже в плане (второе устройство после привязки — e2e task_offer плавал)
  useEffect(() => {
    if (currentUserId) void loadPlanner(currentUserId);
  }, [currentUserId]);

  const kind = getTaskOfferKind(taskOffer);
  const isEvent = kind === 'event';
  const isInPlan = Boolean(planned) || isAdded || taskOffer.myDecision === true;

  const respond = useLastCallback(async (isAccepted: boolean) => {
    const chat = getGlobal().chats.byId[message.chatId];
    if (!chat || isBusy) return;
    setIsBusy(true);
    try {
      const result = await callParvane('parvaneRespondTaskOffer', {
        chat, messageId: message.id, isAccepted,
      }) as RespondResult | undefined;
      if (result === 'needs-linking' || result === 'no-key') {
        showNotification({ message: lang('TaskOfferNeedsPlanner') });
      } else if (result === 'unavailable') {
        showNotification({ message: lang('TaskOfferUnavailable') });
      } else if (result === 'failed') {
        showNotification({ message: lang('TaskOfferResponseFailed') });
      } else if (isAccepted) {
        setIsAdded(true);
        const isKnown = result === 'exists';
        showNotification({
          message: isEvent
            ? lang(isKnown ? 'TaskOfferEventAlreadyInPlan' : 'TaskOfferEventAddedToPlan')
            : lang(isKnown ? 'TaskOfferAlreadyInPlan' : 'TaskOfferAddedToPlan'),
        });
      }
    } finally {
      setIsBusy(false);
    }
  });

  // «План» выключен на устройстве: «В план» и «открыть» ведут в лист «Модуль выключен», после включения
  // действие выполняется
  const gate = useModuleGate('plan');
  const handleAccept = useLastCallback(() => gate.run(() => void respond(true)));
  const handleDecline = useLastCallback(() => respond(false));

  const handleOpenPlan = useLastCallback(() => {
    // Задача, принятая до появления «События», открывается как задача
    gate.run(() => openOfferInPlan(planned?.kind || kind, planned?.day || taskOffer.day));
  });

  const accepted = taskOffer.responses.filter((r) => r.isAccepted);
  const declined = taskOffer.responses.filter((r) => !r.isAccepted);
  const nameOf = (userId: string) => getUserFullName(usersById[userId]) || userId;
  const meta = formatOfferWhen(lang, taskOffer);

  const stateLabel = isInPlan
    ? lang('TaskOfferAccepted')
    : (taskOffer.myDecision === false ? lang('TaskOfferDeclined') : undefined);

  function renderActions() {
    if (isInPlan) {
      return (
        <button type="button" className={buildClassName(kit.chip, styles.inPlan)} onClick={handleOpenPlan}>
          {lang('TaskOfferInPlanOpen')}
        </button>
      );
    }
    return (
      <div className={styles.actions}>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc, styles.action)}
          disabled={isBusy}
          onClick={handleAccept}
        >
          {lang(isEvent ? 'TaskOfferToCalendar' : 'TaskOfferToPlan')}
        </button>
        {!taskOffer.isOwn && taskOffer.myDecision === undefined && (
          <button
            type="button"
            className={buildClassName(kit.btn, styles.action)}
            disabled={isBusy}
            onClick={handleDecline}
          >
            {lang('TaskOfferDecline')}
          </button>
        )}
      </div>
    );
  }

  // Карточка по макету (доски `ZpChat`, `PhCalls`): подпись с решением, название, срок, кнопки во всю ширину
  return (
    <div
      className={styles.root}
      data-task-offer={taskOffer.id}
      data-kind={kind}
      data-decision={String(taskOffer.myDecision)}
      data-in-plan={String(isInPlan)}
    >
      <div className={styles.label}>
        <span>{lang(isEvent ? 'TaskOfferEventLabel' : 'TaskOfferLabel')}</span>
        {stateLabel && ' · '}
        {stateLabel && <span>{stateLabel}</span>}
      </div>
      <div className={styles.name}>{taskOffer.name}</div>
      {meta && <div className={buildClassName(styles.meta, kit.mono)}>{meta}</div>}
      {taskOffer.description && <p className={styles.description}>{taskOffer.description}</p>}
      {/* Число шагов — в строке срока; сами шаги свёрнуты (доска `PhCalls`) */}
      {Boolean(taskOffer.steps.length) && (
        <details className={styles.stepsBox} data-task-offer-steps>
          <summary className={styles.stepsToggle}>{lang('TaskOfferStepsShow')}</summary>
          <ol className={styles.steps}>
            {taskOffer.steps.map((step, index) => <li key={`${index}${step}`}>{step}</li>)}
          </ol>
        </details>
      )}
      {/* «План» выключен сервером — карточка остаётся текстом, без действий (MODULES-1) */}
      {(gate.isOn || gate.canEnable) && renderActions()}
      {Boolean(taskOffer.responses.length) && (
        <div className={styles.responses}>
          {Boolean(accepted.length) && (
            <span>{lang('TaskOfferAcceptedBy', { names: accepted.map((r) => nameOf(r.userId)).join(', ') })}</span>
          )}
          {Boolean(declined.length) && (
            <span>{lang('TaskOfferDeclinedBy', { names: declined.map((r) => nameOf(r.userId)).join(', ') })}</span>
          )}
        </div>
      )}
      <PvModuleOff
        isOpen={gate.isAsked}
        module="plan"
        hint={lang(isEvent ? 'ModuleOffHintEvent' : 'ModuleOffHintTask')}
        onEnable={gate.enable}
        onClose={gate.dismiss}
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global): Complete<StateProps> => ({
  currentUserId: global.currentUserId,
  usersById: global.users.byId,
}))(TaskOffer));
