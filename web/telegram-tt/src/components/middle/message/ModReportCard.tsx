import { memo, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import type { ApiModReport } from '../../../api/types';

import { getUserFullName } from '../../../global/helpers';
import { selectChat, selectUser } from '../../../global/selectors';
import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';

import styles from './ModReportCard.module.scss';

type OwnProps = {
  report: ApiModReport;
};

type StateProps = {
  groupTitle?: string;
  canDelete?: boolean;
  canBan?: boolean;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Parvane (spec 024, REPORT-1): жалоба участника на сообщения группы — карточка у админа с действиями
const ModReportCard = ({
  report, groupTitle, canDelete, canBan,
}: OwnProps & StateProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [isDeleted, setIsDeleted] = useState(false);
  const [isBanned, setIsBanned] = useState(false);

  const authorIds = Array.from(new Set(report.messages.map((m) => m.authorId)));

  const handleDelete = useLastCallback(async () => {
    const isDone = await callParvane('parvaneModDelete', {
      groupChatId: report.groupChatId, uuids: report.messages.map((m) => m.uuid),
    });
    if (isDone) setIsDeleted(true);
    showNotification({ message: lang(isDone ? 'ParvaneModDeleted' : 'ParvaneModFailed') });
  });

  const handleBan = useLastCallback(async () => {
    let isDone = true;
    for (const userId of authorIds) {
      isDone = Boolean(await callParvane('parvaneModBan', { groupChatId: report.groupChatId, userId })) && isDone;
    }
    if (isDone) setIsBanned(true);
    showNotification({ message: lang(isDone ? 'ParvaneModBanned' : 'ParvaneModFailed') });
  });

  return (
    <div className={styles.root} data-mod-report={report.reason}>
      <div className={styles.head}>
        <span className={styles.badge}>
          <Icon name="flag" />
        </span>
        <div className={styles.titles}>
          <span className={styles.label}>{lang('ParvaneModReportLabel')}</span>
          <span className={styles.title}>
            {lang('ParvaneModReportTitle', { group: groupTitle || lang('ParvaneModReportUnknownGroup') })}
          </span>
        </div>
      </div>
      <div className={styles.reason} data-mod-reason>{lang(reasonKey(report.reason))}</div>
      {report.comment && <p className={styles.comment} data-mod-comment>{report.comment}</p>}
      {report.messages.map((m) => (
        <div key={m.uuid} className={styles.quote} data-mod-message={m.uuid}>
          <span className={styles.author}>{authorName(m.authorId)}</span>
          <span className={styles.text}>{m.text}</span>
        </div>
      ))}
      {(isDeleted || isBanned) && (
        <div className={styles.done} data-mod-done>
          {[isDeleted && lang('ParvaneModDeleted'), isBanned && lang('ParvaneModBanned')].filter(Boolean).join(' · ')}
        </div>
      )}
      {((canDelete && !isDeleted) || (canBan && !isBanned)) && (
        <div className={styles.actions}>
          {canDelete && !isDeleted && (
            <span data-mod-action="delete">
              <Button size="tiny" noForcedUpperCase onClick={handleDelete}>{lang('ParvaneModDelete')}</Button>
            </span>
          )}
          {canBan && !isBanned && (
            <span data-mod-action="ban">
              <Button size="tiny" color="danger" noForcedUpperCase onClick={handleBan}>{lang('ParvaneModBan')}</Button>
            </span>
          )}
        </div>
      )}
    </div>
  );
};

const REASON_KEYS = {
  spam: 'ParvaneReportReasonSpam',
  violence: 'ParvaneReportReasonViolence',
  porn: 'ParvaneReportReasonPorn',
  child: 'ParvaneReportReasonChild',
  copyright: 'ParvaneReportReasonCopyright',
  illegal: 'ParvaneReportReasonIllegal',
  personal: 'ParvaneReportReasonPersonal',
  fake: 'ParvaneReportReasonFake',
  other: 'ParvaneReportReasonOther',
} as const;

function reasonKey(reason: string) {
  return REASON_KEYS[reason as keyof typeof REASON_KEYS] || REASON_KEYS.other;
}

// Имя автора — одноразовое чтение: карточку не перерисовывает смена чужого профиля
function authorName(userId: string) {
  const user = selectUser(getGlobal(), userId);
  return (user && getUserFullName(user)) || userId;
}

export default memo(withGlobal<OwnProps>((global, { report }): Complete<StateProps> => {
  const chat = report.groupChatId ? selectChat(global, report.groupChatId) : undefined;
  const isCreator = Boolean(chat?.isCreator);
  return {
    groupTitle: chat?.title,
    canDelete: Boolean(chat && (isCreator || chat.adminRights?.deleteMessages)),
    canBan: Boolean(chat && (isCreator || chat.adminRights?.banUsers)),
  };
})(ModReportCard));
