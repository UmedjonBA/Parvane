import type { FC } from '../../../lib/teact/teact';
import { memo, useCallback, useEffect } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChat } from '../../../api/types';

import { isChatChannel } from '../../../global/helpers';
import { selectChat } from '../../../global/selectors';
import { isUserId } from '../../../util/entities/ids';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';

import Island, { IslandDescription } from '../../gili/layout/Island';
import Button from '../../ui/Button';
import ConfirmDialog from '../../ui/ConfirmDialog';
import ParvaneMascot from '../../ui/ParvaneMascot';
import JoinRequest from './JoinRequest';

type OwnProps = {
  chatId: string;
  onClose: NoneToVoidFunction;
  isActive: boolean;
};

type StateProps = {
  chat?: ApiChat;
  isChannel?: boolean;
};

const ManageJoinRequests: FC<OwnProps & StateProps> = ({
  chat,
  chatId,
  isActive,
  isChannel,
  onClose,
}) => {
  const { hideAllChatJoinRequests, loadChatJoinRequests } = getActions();
  const [isAcceptAllDialogOpen, openAcceptAllDialog, closeAcceptAllDialog] = useFlag();
  const [isRejectAllDialogOpen, openRejectAllDialog, closeRejectAllDialog] = useFlag();

  const lang = useOldLang();
  const newLang = useLang();

  useHistoryBack({
    isActive,
    onBack: onClose,
  });

  useEffect(() => {
    if (!chat?.joinRequests && !isUserId(chatId)) {
      loadChatJoinRequests({ chatId });
    }
  }, [chat, chatId, loadChatJoinRequests]);

  const handleAcceptAllRequests = useCallback(() => {
    hideAllChatJoinRequests({ chatId, isApproved: true });
    closeAcceptAllDialog();
  }, [hideAllChatJoinRequests, chatId, closeAcceptAllDialog]);

  const handleRejectAllRequests = useCallback(() => {
    hideAllChatJoinRequests({ chatId, isApproved: false });
    closeRejectAllDialog();
  }, [hideAllChatJoinRequests, chatId, closeRejectAllDialog]);

  return (
    <div className="Management ManageJoinRequests">
      <div className="custom-scroll">
        {/* Parvane: заявки по доске `RpPick` — «Принять все / Отклонить все» сверху, строки с кнопками под именем */}
        {Boolean(chat?.joinRequests?.length) && (
          <div className="bulk-actions">
            <Button className="bulk-action-button" onClick={openAcceptAllDialog}>
              {lang('ParvaneJoinRequestsAcceptAll')}
            </Button>
            <Button className="bulk-action-button bulk-action-danger" onClick={openRejectAllDialog}>
              {lang('ParvaneJoinRequestsDismissAll')}
            </Button>
          </div>
        )}
        <Island teactFastList>
          {!chat?.joinRequests && (
            <ParvaneMascot key="loading" />
          )}
          {chat?.joinRequests?.length === 0 && (
            <div key="empty" className="join-requests-empty">
              <p className="join-requests-empty-title">{lang('NoMemberRequests')}</p>
              <IslandDescription>
                {isChannel ? lang('NoSubscribeRequestsDescription') : lang('NoMemberRequestsDescription')}
              </IslandDescription>
            </div>
          )}
          {chat?.joinRequests?.map(({ userId, about, date }) => (
            <JoinRequest
              userId={userId}
              about={about}
              date={date}
              chatId={chatId}
              key={userId}
            />
          ))}
        </Island>
        <IslandDescription>{newLang('ParvaneJoinRequestsHint')}</IslandDescription>
      </div>
      <ConfirmDialog
        isOpen={isAcceptAllDialogOpen}
        onClose={closeAcceptAllDialog}
        title={lang('ParvaneJoinRequestsAcceptAllTitle')}
        text={lang('ParvaneJoinRequestsAcceptAllText')}
        confirmHandler={handleAcceptAllRequests}
      />
      <ConfirmDialog
        isOpen={isRejectAllDialogOpen}
        onClose={closeRejectAllDialog}
        title={lang('ParvaneJoinRequestsRejectAllTitle')}
        text={lang('ParvaneJoinRequestsRejectAllText')}
        confirmHandler={handleRejectAllRequests}
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): Complete<StateProps> => {
    const chat = selectChat(global, chatId);

    return {
      chat,
      isChannel: chat && isChatChannel(chat),
    };
  },
)(ManageJoinRequests));
