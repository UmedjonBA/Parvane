import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import type { ParvaneReportInbox, ParvaneReportItem } from '../../../api/parvane/modReports';
import type { RegularLangKey } from '../../../types/language';

import { getHasAdminRight, getUserFullName } from '../../../global/helpers';
import { selectChat, selectUser } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { formatHumanDate, formatTime, isToday } from '../../../util/dates/oldDateFormat';
import { callApi } from '../../../api/gramjs';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './ManageReports.module.scss';

type OwnProps = {
  chatId: string;
  isActive: boolean;
  onClose: NoneToVoidFunction;
};

type StateProps = {
  canDelete?: boolean;
  canBan?: boolean;
};

const REASON_KEYS: Record<string, RegularLangKey> = {
  spam: 'ParvaneReportChipSpam',
  fraud: 'ParvaneReportChipFraud',
  insult: 'ParvaneReportChipInsult',
  illegal: 'ParvaneReportChipIllegal',
  other: 'ParvaneReportChipOther',
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Parvane (spec 041, доски `RpChat`, `XpChat`; REPORT-2): жалобы участников группы у админа. Список собирает
// провайдер из полученных карточек `mod_report` (сводит движок); здесь — показ и действия
const ManageReports = ({
  chatId, isActive, canDelete, canBan, onClose,
}: OwnProps & StateProps) => {
  const { showNotification, focusMessage } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const [inbox, setInbox] = useState<ParvaneReportInbox | undefined>();
  const [busyUuid, setBusyUuid] = useState<string | undefined>();

  useHistoryBack({ isActive, onBack: onClose });

  const loadInbox = useLastCallback(async () => {
    const result = await callParvane('parvaneReportInbox', { chatId }) as ParvaneReportInbox | undefined;
    setInbox(result || { items: [], open: 0 });
  });

  useEffect(() => {
    if (isActive) void loadInbox();
  }, [isActive, chatId]);

  const closeItem = useLastCallback(async (item: ParvaneReportItem) => {
    await callParvane('parvaneReportClose', { chatId, uuids: [item.uuid] });
    await loadInbox();
  });

  const runAction = useLastCallback(async (item: ParvaneReportItem, action: 'delete' | 'ban' | 'dismiss') => {
    setBusyUuid(item.uuid);
    let isDone = true;
    if (action === 'delete') {
      isDone = Boolean(await callParvane('parvaneModDelete', { groupChatId: chatId, uuids: [item.uuid] }));
      showNotification({ message: lang(isDone ? 'ParvaneModDeleted' : 'ParvaneModFailed') });
    } else if (action === 'ban') {
      isDone = Boolean(await callParvane('parvaneModBan', { groupChatId: chatId, userId: item.authorId }));
      showNotification({ message: lang(isDone ? 'ParvaneModBanned' : 'ParvaneModFailed') });
    }
    if (isDone) await closeItem(item);
    setBusyUuid(undefined);
  });

  const handleOpen = useLastCallback((item: ParvaneReportItem) => {
    if (item.messageId) focusMessage({ chatId, messageId: item.messageId });
  });

  function formatWhen(dateSecs: number) {
    const ms = dateSecs * 1000;
    return isToday(new Date(ms)) ? formatTime(oldLang, ms) : formatHumanDate(oldLang, ms, true, false, true);
  }

  function renderItem(item: ParvaneReportItem) {
    const author = selectUser(getGlobal(), item.authorId);
    const isBusy = busyUuid === item.uuid;
    return (
      <div key={item.uuid} className={buildClassName(kit.card, styles.item)} data-report-item={item.uuid}>
        <div className={styles.head}>
          <span className={styles.author} dir="auto">{(author && getUserFullName(author)) || item.authorId}</span>
          <span className={styles.reason} data-report-reason={item.reason}>
            {lang(REASON_KEYS[item.reason] || REASON_KEYS.other)}
          </span>
        </div>
        <button
          type="button"
          className={styles.quote}
          dir="auto"
          disabled={!item.messageId}
          title={item.messageId ? lang('ParvaneReportsOpen') : undefined}
          data-report-open
          onClick={() => handleOpen(item)}
        >
          {item.text}
        </button>
        <div className={buildClassName(kit.small, kit.muted)} data-report-meta>
          {[lang('ParvaneReportsCount', { count: item.count }, { pluralValue: item.count }), formatWhen(item.lastDate)]
            .join(' · ')}
        </div>
        {item.comments.map((comment) => (
          <div key={`${comment.reporterId}:${comment.text}`} className={styles.comment} dir="auto">
            {comment.text}
          </div>
        ))}
        <div className={styles.actions}>
          {canDelete && (
            <button
              type="button"
              className={kit.btn}
              disabled={isBusy}
              data-report-action="delete"
              onClick={() => runAction(item, 'delete')}
            >
              {lang('ParvaneReportsDelete')}
            </button>
          )}
          {canBan && (
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnDanger)}
              disabled={isBusy}
              data-report-action="ban"
              onClick={() => runAction(item, 'ban')}
            >
              {lang('ParvaneModBan')}
            </button>
          )}
          <button
            type="button"
            className={kit.btn}
            disabled={isBusy}
            data-report-action="dismiss"
            onClick={() => runAction(item, 'dismiss')}
          >
            {lang('ParvaneReportsDismiss')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={buildClassName('Management', styles.root)} data-reports-screen>
      <div className={buildClassName('panel-content custom-scroll', styles.content)}>
        {!inbox && <div className={buildClassName(kit.muted, styles.empty)}>{lang('Loading')}</div>}
        {inbox && !inbox.items.length && (
          <div className={buildClassName(kit.muted, styles.empty)} data-reports-empty>
            {lang('ParvaneReportsEmpty')}
          </div>
        )}
        {inbox?.items.map(renderItem)}
        <div className={buildClassName(kit.small, kit.muted, styles.footer)}>{lang('ParvaneReportsFooter')}</div>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global, { chatId }): Complete<StateProps> => {
  const chat = selectChat(global, chatId);
  return {
    canDelete: Boolean(chat && (chat.isCreator || getHasAdminRight(chat, 'deleteMessages'))),
    canBan: Boolean(chat && (chat.isCreator || getHasAdminRight(chat, 'banUsers'))),
  };
})(ManageReports));
