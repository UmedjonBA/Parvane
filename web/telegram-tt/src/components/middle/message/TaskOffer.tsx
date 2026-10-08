import { memo, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import type { ApiMessage, ApiTaskOffer, ApiUser } from '../../../api/types';

import { getUserFullName } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { setParvaneSection } from '../../../util/parvaneSection';
import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

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

// Parvane (spec 011, US3): карточка задания в чате — поля задачи, кнопки
// «Принять»/«Отклонить» у получателя, «В мой план» у автора, решения участников.
// У Telegram такого сообщения нет (обоснование — план спеки, принцип VI)
const TaskOffer = ({ message, taskOffer, usersById }: OwnProps & StateProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const [isBusy, setIsBusy] = useState(false);

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
        showNotification({ message: lang(result === 'exists' ? 'TaskOfferAlreadyInPlan' : 'TaskOfferAddedToPlan') });
      }
    } finally {
      setIsBusy(false);
    }
  });

  const handleAccept = useLastCallback(() => respond(true));
  const handleDecline = useLastCallback(() => respond(false));

  const handleOpenPlan = useLastCallback(() => {
    setParvaneSection('planner');
  });

  const accepted = taskOffer.responses.filter((r) => r.isAccepted);
  const declined = taskOffer.responses.filter((r) => !r.isAccepted);
  const nameOf = (userId: string) => getUserFullName(usersById[userId]) || userId;
  const when = [taskOffer.day, taskOffer.start].filter(Boolean).join(' ');
  const meta = [
    when,
    taskOffer.minutes ? lang('PlannerMinutesValue', { minutes: taskOffer.minutes }) : undefined,
    taskOffer.due ? lang('PlannerDueValue', { date: taskOffer.due }) : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <div className={styles.root} data-task-offer={taskOffer.id} data-decision={String(taskOffer.myDecision)}>
      <div className={styles.head}>
        <span className={styles.label}>{lang('TaskOfferLabel')}</span>
        <span className={styles.name}>{taskOffer.name}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
      </div>
      {taskOffer.description && <p className={styles.description}>{taskOffer.description}</p>}
      {Boolean(taskOffer.steps.length) && (
        <ol className={styles.steps}>
          {taskOffer.steps.map((step, index) => <li key={`${index}${step}`}>{step}</li>)}
        </ol>
      )}
      <div className={styles.actions}>
        {taskOffer.isOwn ? (
          <Button size="tiny" color="translucent" disabled={isBusy} onClick={handleAccept}>
            {lang('TaskOfferAddToPlan')}
          </Button>
        ) : taskOffer.myDecision === true ? (
          <>
            <span className={buildClassName(styles.status, styles.statusAccepted)}>{lang('TaskOfferAccepted')}</span>
            <Button size="tiny" color="translucent" onClick={handleOpenPlan}>{lang('TaskOfferOpenPlan')}</Button>
          </>
        ) : (
          <>
            {taskOffer.myDecision === false && (
              <span className={buildClassName(styles.status, styles.statusDeclined)}>{lang('TaskOfferDeclined')}</span>
            )}
            <Button size="tiny" disabled={isBusy} onClick={handleAccept}>{lang('TaskOfferAccept')}</Button>
            {taskOffer.myDecision === undefined && (
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
