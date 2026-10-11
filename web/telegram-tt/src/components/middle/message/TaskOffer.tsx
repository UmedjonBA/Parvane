import { memo, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import type { ApiMessage, ApiTaskOffer, ApiUser } from '../../../api/types';

import { getUserFullName } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { findOfferInPlan, getTaskOfferKind } from '../../../api/parvane/taskOffers';
import { getPlannerState } from '../../parvane/planner/plannerStore';
import { formatOfferWhen } from '../../parvane/taskOffer/taskOfferFormat';
import { openOfferInPlan } from '../../parvane/taskOffer/taskOfferOpen';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';

import styles from './TaskOffer.module.scss';

type OwnProps = {
  message: ApiMessage;
  taskOffer: ApiTaskOffer;
};

type StateProps = {
  usersById: Record<string, ApiUser>;
};

type RespondResult = 'ok' | 'exists' | 'needs-linking' | 'no-key' | 'unavailable';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Parvane (spec 011, US3): карточка в чате — «Задание» либо «Событие» (то же
// содержимое `task_offer`; событие — с днём и временем начала). Кнопка «В план» /
// «В календарь» — прежнее «Принять»: запись в плане и ответ-статус автору; после
// неё — «В плане · открыть». «Отклонить» и решения участников — как раньше.
// У Telegram такого сообщения нет (обоснование — план спеки, принцип VI)
const TaskOffer = ({ message, taskOffer, usersById }: OwnProps & StateProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const [isBusy, setIsBusy] = useState(false);
  // Автор ответа себе не шлёт: его «в плане» — запись плана либо нажатие в этом сеансе
  const [isAdded, setIsAdded] = useState(false);
  const plannerState = useDerivedState(getPlannerState);

  const kind = getTaskOfferKind(taskOffer);
  const isEvent = kind === 'event';
  const planned = findOfferInPlan(plannerState, taskOffer.id);
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

  const handleAccept = useLastCallback(() => respond(true));
  const handleDecline = useLastCallback(() => respond(false));

  const handleOpenPlan = useLastCallback(() => {
    // Задача, принятая до появления «События», открывается как задача
    openOfferInPlan(planned?.kind || kind, planned?.day || taskOffer.day);
  });

  const accepted = taskOffer.responses.filter((r) => r.isAccepted);
  const declined = taskOffer.responses.filter((r) => !r.isAccepted);
  const nameOf = (userId: string) => getUserFullName(usersById[userId]) || userId;
  const meta = formatOfferWhen(lang, taskOffer);

  return (
    <div
      className={styles.root}
      data-task-offer={taskOffer.id}
      data-kind={kind}
      data-decision={String(taskOffer.myDecision)}
      data-in-plan={String(isInPlan)}
    >
      <div className={styles.head}>
        <span className={buildClassName(styles.badge, isEvent && styles.badgeEvent)}>
          <Icon name={isEvent ? 'calendar' : 'check'} />
        </span>
        <div className={styles.titles}>
          <span className={styles.label}>{lang(isEvent ? 'TaskOfferEventLabel' : 'TaskOfferLabel')}</span>
          <span className={styles.name}>{taskOffer.name}</span>
          {meta && <span className={styles.meta}>{meta}</span>}
        </div>
      </div>
      {taskOffer.description && <p className={styles.description}>{taskOffer.description}</p>}
      {Boolean(taskOffer.steps.length) && (
        <ol className={styles.steps}>
          {taskOffer.steps.map((step, index) => <li key={`${index}${step}`}>{step}</li>)}
        </ol>
      )}
      <div className={styles.actions}>
        {isInPlan ? (
          <Button
            className={styles.inPlan}
            size="tiny"
            color="translucent"
            iconName="check"
            onClick={handleOpenPlan}
          >
            {lang('TaskOfferInPlanOpen')}
          </Button>
        ) : (
          <>
            {taskOffer.myDecision === false && (
              <span className={styles.status}>{lang('TaskOfferDeclined')}</span>
            )}
            <Button size="tiny" iconName="calendar" disabled={isBusy} onClick={handleAccept}>
              {lang(isEvent ? 'TaskOfferToCalendar' : 'TaskOfferToPlan')}
            </Button>
            {!taskOffer.isOwn && taskOffer.myDecision === undefined && (
              <Button size="tiny" color="translucent" disabled={isBusy} onClick={handleDecline}>
                {lang('TaskOfferDecline')}
              </Button>
            )}
          </>
        )}
      </div>
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
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global): Complete<StateProps> => ({
  usersById: global.users.byId,
}))(TaskOffer));
