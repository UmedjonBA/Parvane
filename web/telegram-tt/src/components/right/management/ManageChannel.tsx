import type { ChangeEvent } from 'react';
import type { FC } from '../../../lib/teact/teact';
import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import type {
  ApiChat, ApiChatFullInfo, ApiExportedInvite,
} from '../../../api/types';
import { ApiMediaFormat } from '../../../api/types';
import { ManagementProgress, ManagementScreens } from '../../../types';

import { getChatAvatarHash, getHasAdminRight, isChatPublic } from '../../../global/helpers';
import { selectChat, selectChatFullInfo, selectIsChatRestricted, selectTabState } from '../../../global/selectors';
import { formatInteger } from '../../../util/textFormat';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLastCallback from '../../../hooks/useLastCallback';
import useMedia from '../../../hooks/useMedia';
import useOldLang from '../../../hooks/useOldLang';

import Island from '../../gili/layout/Island';
import AvatarEditable from '../../ui/AvatarEditable';
import ConfirmDialog from '../../ui/ConfirmDialog';
import FloatingActionButton from '../../ui/FloatingActionButton';
import InputText from '../../ui/InputText';
import ListItem from '../../ui/ListItem';
import TextArea from '../../ui/TextArea';
import ManageJoinMode from './ManageJoinMode';

import './Management.scss';

// Parvane (spec 003): фото, описание и заявки — на сервере; тип канала,
// обсуждения (треды вне продукта), реакции и автоперевод — вне контракта
// Публичная группа (spec 023): тип «Публичная/Частная» с именем
const IS_CHANNEL_TYPE_SUPPORTED = true;
const IS_CHANNEL_PHOTO_SUPPORTED = true;
const IS_CHANNEL_DESCRIPTION_SUPPORTED = true;
const IS_CHANNEL_REQUESTS_SUPPORTED = true;

type OwnProps = {
  chatId: string;
  onScreenSelect: (screen: ManagementScreens) => void;
  onClose: NoneToVoidFunction;
  isActive: boolean;
};

type StateProps = {
  chat: ApiChat;
  chatFullInfo?: ApiChatFullInfo;
  progress?: ManagementProgress;
  canChangeInfo?: boolean;
  canInvite?: boolean;
  exportedInvites?: ApiExportedInvite[];
};

const CHANNEL_TITLE_EMPTY = 'Channel title can\'t be empty';
const CHANNEL_MAX_DESCRIPTION = 255;

const ManageChannel: FC<OwnProps & StateProps> = ({
  chatId,
  chat,
  chatFullInfo,
  progress,
  canChangeInfo,
  canInvite,
  exportedInvites,
  isActive,
  onScreenSelect,
  onClose,
}) => {
  const {
    updateChat,
    closeManagement,
    leaveChannel,
    deleteChannel,
    openChat,
    loadExportedChatInvites,
    loadChatJoinRequests,
  } = getActions();

  const currentTitle = chat?.title || '';
  const currentAbout = chatFullInfo?.about || '';

  const [isDeleteDialogOpen, openDeleteDialog, closeDeleteDialog] = useFlag();
  const [isProfileFieldsTouched, setIsProfileFieldsTouched] = useState(false);
  const [title, setTitle] = useState(currentTitle);
  const [about, setAbout] = useState(currentAbout);
  const [photo, setPhoto] = useState<File | undefined>();
  const [error, setError] = useState<string | undefined>();
  const imageHash = chat && getChatAvatarHash(chat);
  const currentAvatarBlobUrl = useMedia(imageHash, false, ApiMediaFormat.BlobUrl);
  const lang = useOldLang();

  useHistoryBack({
    isActive,
    onBack: onClose,
  });

  useEffect(() => {
    if (!canInvite) return;
    loadExportedChatInvites({ chatId });
    loadExportedChatInvites({ chatId, isRevoked: true });
    if (IS_CHANNEL_REQUESTS_SUPPORTED) loadChatJoinRequests({ chatId });
  }, [chatId, canInvite]);

  useEffect(() => {
    if (progress === ManagementProgress.Complete) {
      setIsProfileFieldsTouched(false);
      setError(undefined);
    }
  }, [progress]);

  const adminsCount = useMemo(() => {
    return Object.keys(chatFullInfo?.adminMembersById || {}).length;
  }, [chatFullInfo?.adminMembersById]);
  const removedUsersCount = chatFullInfo?.kickedMembers?.length || 0;

  const handleClickEditType = useLastCallback(() => {
    onScreenSelect(ManagementScreens.ChatPrivacyType);
  });

  const handleClickAdministrators = useLastCallback(() => {
    onScreenSelect(ManagementScreens.ChatAdministrators);
  });

  const handleClickInvites = useLastCallback(() => {
    onScreenSelect(ManagementScreens.Invites);
  });

  const handleClickRequests = useLastCallback(() => {
    onScreenSelect(ManagementScreens.JoinRequests);
  });

  const handleSetPhoto = useLastCallback((file: File) => {
    setPhoto(file);
    setIsProfileFieldsTouched(true);
  });

  const handleTitleChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
    setIsProfileFieldsTouched(true);
  });

  const handleAboutChange = useLastCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setAbout(e.target.value);
    setIsProfileFieldsTouched(true);
  });

  const handleUpdateChannel = useLastCallback(() => {
    const trimmedTitle = title.trim();
    const trimmedAbout = about.trim();

    if (!trimmedTitle.length) {
      setError(CHANNEL_TITLE_EMPTY);
      return;
    }

    updateChat({
      chatId,
      title: trimmedTitle,
      about: trimmedAbout,
      photo,
    });
  });

  const handleClickSubscribers = useLastCallback(() => {
    onScreenSelect(ManagementScreens.ChannelSubscribers);
  });

  const handleRemovedUsersClick = useLastCallback(() => {
    onScreenSelect(ManagementScreens.ChannelRemovedUsers);
  });

  const handleDeleteChannel = useLastCallback(() => {
    if (chat.isCreator) {
      deleteChannel({ chatId: chat.id });
    } else {
      leaveChannel({ chatId: chat.id });
    }

    closeDeleteDialog();
    closeManagement();
    openChat({ id: undefined });
  });

  const isChannelPublic = useMemo(() => isChatPublic(chat), [chat]);

  const isRestricted = selectIsChatRestricted(getGlobal(), chatId);
  if (isRestricted || chat.isForbidden) {
    return undefined;
  }

  const isLoading = progress === ManagementProgress.InProgress;

  return (
    <div className="Management">
      <div className="panel-content custom-scroll">
        {IS_CHANNEL_PHOTO_SUPPORTED && (
          <AvatarEditable
            currentAvatarBlobUrl={currentAvatarBlobUrl}
            onChange={handleSetPhoto}
            disabled={!canChangeInfo}
            actionLabel={lang('ParvaneChoosePhoto')}
          />
        )}
        <Island>
          <div className="settings-edit">
            <InputText
              id="channel-title"
              label={lang('EnterChannelName')}
              onChange={handleTitleChange}
              value={title}
              error={error === CHANNEL_TITLE_EMPTY ? error : undefined}
              disabled={!canChangeInfo}
            />
            {IS_CHANNEL_DESCRIPTION_SUPPORTED && (
              <TextArea
                id="channel-about"
                label={lang('DescriptionPlaceholder')}
                onChange={handleAboutChange}
                value={about}
                maxLength={CHANNEL_MAX_DESCRIPTION}
                maxLengthIndicator={(CHANNEL_MAX_DESCRIPTION - about.length).toString()}
                disabled={!canChangeInfo}
                noReplaceNewlines
              />
            )}
          </div>
          {IS_CHANNEL_TYPE_SUPPORTED && chat.isCreator && (
            <ListItem icon="lock" multiline onClick={handleClickEditType}>
              <span className="title">{lang('ChannelType')}</span>
              <span className="subtitle">{isChannelPublic ? lang('TypePublic') : lang('TypePrivate')}</span>
            </ListItem>
          )}
          {canInvite && <ManageJoinMode chatId={chatId} exportedInvites={exportedInvites} />}
          {IS_CHANNEL_REQUESTS_SUPPORTED && Boolean(chat.joinRequests?.length) && (
            <ListItem
              icon="add-user-filled"
              onClick={handleClickRequests}
              multiline
            >
              <span className="title">{lang('SubscribeRequests')}</span>
              <span className="subtitle">
                {formatInteger(chat.joinRequests.length)}
              </span>
            </ListItem>
          )}
        </Island>
        <Island>
          <ListItem
            icon="admin"
            multiline
            onClick={handleClickAdministrators}
          >
            <span className="title">{lang('ChannelAdministrators')}</span>
            <span className="subtitle">{adminsCount}</span>
          </ListItem>
          <ListItem
            icon="group"
            multiline
            onClick={handleClickSubscribers}
          >
            <span className="title" dir="auto">{lang('ChannelSubscribers')}</span>
            <span className="subtitle" dir="auto">{formatInteger(chat.membersCount!)}</span>
          </ListItem>
          {canInvite && (
            <ListItem
              icon="link"
              onClick={handleClickInvites}
              multiline
              disabled={!exportedInvites}
            >
              <span className="title">{lang('GroupInfo.InviteLinks')}</span>
              <span className="subtitle">
                {exportedInvites ? formatInteger(exportedInvites.length) : lang('Loading')}
              </span>
            </ListItem>
          )}
          <ListItem
            icon="delete-user"
            multiline
            onClick={handleRemovedUsersClick}
          >
            <span className="title">{lang('ChannelBlockedUsers')}</span>
            <span className="subtitle">{removedUsersCount}</span>
          </ListItem>
        </Island>
        <Island>
          <ListItem icon="delete" ripple destructive onClick={openDeleteDialog}>
            {chat.isCreator ? lang('ChannelDelete') : lang('LeaveChannel')}
          </ListItem>
        </Island>
      </div>
      <FloatingActionButton
        isShown={isProfileFieldsTouched}
        onClick={handleUpdateChannel}
        disabled={isLoading}
        ariaLabel={lang('Save')}
        iconName="check"
        isLoading={isLoading}
      />
      <ConfirmDialog
        isOpen={isDeleteDialogOpen}
        onClose={closeDeleteDialog}
        text={chat.isCreator ? lang('ChannelDeleteAlert') : lang('ChannelLeaveAlert')}
        confirmLabel={chat.isCreator ? lang('ChannelDelete') : lang('LeaveChannel')}
        confirmHandler={handleDeleteChannel}
        confirmIsDestructive
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): Complete<StateProps> => {
    const chat = selectChat(global, chatId)!;
    const { management } = selectTabState(global);
    const { progress } = management;
    const { invites } = management.byChatId[chatId] || {};
    return {
      chat,
      chatFullInfo: selectChatFullInfo(global, chatId),
      progress,
      // Parvane: у владельца набора прав нет — ему доступно всё (как в `ManageGroup`)
      canChangeInfo: chat.isCreator || getHasAdminRight(chat, 'changeInfo'),
      // Parvane: владелец канала — isCreator без adminRights, ссылка ему тоже нужна
      canInvite: chat.isCreator || getHasAdminRight(chat, 'inviteUsers'),
      exportedInvites: invites,
    };
  },
  (global, { chatId }) => {
    return Boolean(selectChat(global, chatId));
  },
)(ManageChannel));
