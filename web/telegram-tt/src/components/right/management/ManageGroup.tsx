import type { ChangeEvent } from 'react';
import type { FC } from '../../../lib/teact/teact';
import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import type {
  ApiChat, ApiChatBannedRights, ApiChatFullInfo, ApiExportedInvite,
} from '../../../api/types';
import { ApiMediaFormat } from '../../../api/types';
import { ManagementProgress, ManagementScreens } from '../../../types';

import {
  getChatAvatarHash,
  getHasAdminRight,
  isChatBasicGroup,
  isChatPublic,
} from '../../../global/helpers';
import { selectChat, selectChatFullInfo, selectIsChatRestricted, selectTabState } from '../../../global/selectors';
import { formatInteger } from '../../../util/textFormat';
import renderText from '../../common/helpers/renderText';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLastCallback from '../../../hooks/useLastCallback';
import useMedia from '../../../hooks/useMedia';
import useOldLang from '../../../hooks/useOldLang';
import useParvaneChatL2 from '../../../hooks/useParvaneChatL2';

import Island, { IslandDescription } from '../../gili/layout/Island';
import Switch from '../../gili/primitives/Switch';
import AvatarEditable from '../../ui/AvatarEditable';
import ConfirmDialog from '../../ui/ConfirmDialog';
import FloatingActionButton from '../../ui/FloatingActionButton';
import InputText from '../../ui/InputText';
import ListItem from '../../ui/ListItem';
import TextArea from '../../ui/TextArea';
import ManageJoinMode from './ManageJoinMode';

import './Management.scss';

// Публичная группа (spec 023): тип «Публичная/Частная» с именем
const IS_GROUP_TYPE_SUPPORTED = true;
const IS_GROUP_PHOTO_SUPPORTED = true;
const IS_GROUP_DESCRIPTION_SUPPORTED = true;
const IS_GROUP_PERMISSIONS_SUPPORTED = true;
const IS_GROUP_REQUESTS_SUPPORTED = true;

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
  isBasicGroup: boolean;
  canChangeInfo?: boolean;
  canBanUsers?: boolean;
  canInvite?: boolean;
  exportedInvites?: ApiExportedInvite[];
};

const GROUP_TITLE_EMPTY = 'Group title can\'t be empty';
const GROUP_MAX_DESCRIPTION = 255;

const ALL_PERMISSIONS: Array<keyof ApiChatBannedRights> = [
  'sendMessages',
  'embedLinks',
  'sendPolls',
  'changeInfo',
  'inviteUsers',
  'pinMessages',
  'manageTopics',
  'sendPhotos',
  'sendVideos',
  'sendRoundvideos',
  'sendVoices',
  'sendAudios',
  'sendDocs',
];
// Some checkboxes control multiple rights, and some rights are not controlled from Permissions screen,
// so we need to define the amount manually
const TOTAL_PERMISSIONS_COUNT = ALL_PERMISSIONS.length + 1;

const ManageGroup: FC<OwnProps & StateProps> = ({
  chatId,
  chat,
  chatFullInfo,
  progress,
  isBasicGroup,
  canChangeInfo,
  canBanUsers,
  canInvite,
  isActive,
  exportedInvites,
  onScreenSelect,
  onClose,
}) => {
  const {
    updateChat,
    deleteChat,
    leaveChannel,
    deleteChannel,
    closeManagement,
    openChat,
    loadExportedChatInvites,
    loadChatJoinRequests,
  } = getActions();

  const [isDeleteDialogOpen, openDeleteDialog, closeDeleteDialog] = useFlag();
  const currentTitle = chat.title;
  const currentAbout = chatFullInfo?.about || '';

  const [isProfileFieldsTouched, setIsProfileFieldsTouched] = useState(false);
  const [title, setTitle] = useState(currentTitle);
  const [about, setAbout] = useState(currentAbout);
  const [photo, setPhoto] = useState<File | undefined>();
  const [error, setError] = useState<string | undefined>();
  const isForumEnabled = chat.isForum;
  const imageHash = getChatAvatarHash(chat);
  const currentAvatarBlobUrl = useMedia(imageHash, false, ApiMediaFormat.BlobUrl);
  const isPublicGroup = useMemo(() => isChatPublic(chat), [chat]);
  const lang = useOldLang();
  // Parvane: политика «усиленная приватность» (L2) группы протокола v2 —
  // меняет тот, кто вправе менять сведения группы
  const [groupL2, handleToggleL2] = useParvaneChatL2(canChangeInfo ? chatId : undefined, 'isActive');

  useHistoryBack({
    isActive,
    onBack: onClose,
  });

  useEffect(() => {
    if (canInvite) {
      loadExportedChatInvites({ chatId });
      loadExportedChatInvites({ chatId, isRevoked: true });
      if (IS_GROUP_REQUESTS_SUPPORTED) loadChatJoinRequests({ chatId });
    }
  }, [chatId, canInvite]);

  useEffect(() => {
    if (progress === ManagementProgress.Complete) {
      setIsProfileFieldsTouched(false);
      setError(undefined);
    }
  }, [progress]);

  const handleClickEditType = useLastCallback(() => {
    onScreenSelect(ManagementScreens.ChatPrivacyType);
  });

  const handleClickPermissions = useLastCallback(() => {
    onScreenSelect(ManagementScreens.GroupPermissions);
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

  const handleUpdateGroup = useLastCallback(() => {
    const trimmedTitle = title.trim();
    const trimmedAbout = about.trim();

    if (!trimmedTitle.length) {
      setError(GROUP_TITLE_EMPTY);
      return;
    }

    updateChat({
      chatId,
      title: trimmedTitle,
      about: trimmedAbout,
      photo,
    });
  });

  const handleClickMembers = useLastCallback(() => {
    onScreenSelect(ManagementScreens.GroupMembers);
  });

  const enabledPermissionsCount = useMemo(() => {
    if (!chat.defaultBannedRights) {
      return 0;
    }

    let totalCount = ALL_PERMISSIONS.filter(
      (key) => {
        if (key === 'manageTopics' && !isForumEnabled) return false;
        return !chat.defaultBannedRights![key];
      },
    ).length;

    const { sendStickers, sendGifs } = chat.defaultBannedRights;

    // These two rights are controlled with a single checkbox
    if (!sendStickers && !sendGifs) {
      totalCount += 1;
    }

    return totalCount;
  }, [chat.defaultBannedRights, isForumEnabled]);

  const adminsCount = useMemo(() => {
    return Object.keys(chatFullInfo?.adminMembersById || {}).length;
  }, [chatFullInfo?.adminMembersById]);

  const handleDeleteGroup = useLastCallback(() => {
    if (isBasicGroup) {
      deleteChat({ chatId: chat.id });
    } else if (!chat.isCreator) {
      leaveChannel({ chatId: chat.id });
    } else {
      deleteChannel({ chatId: chat.id });
    }
    closeDeleteDialog();
    closeManagement();
    openChat({ id: undefined });
  });

  const isRestricted = selectIsChatRestricted(getGlobal(), chatId);
  if (isRestricted || chat.isForbidden) {
    return undefined;
  }

  const isLoading = progress === ManagementProgress.InProgress;

  return (
    <div className="Management">
      <div className="panel-content custom-scroll">
        {IS_GROUP_PHOTO_SUPPORTED && (
          <AvatarEditable
            isForForum={isForumEnabled}
            currentAvatarBlobUrl={currentAvatarBlobUrl}
            onChange={handleSetPhoto}
            disabled={!canChangeInfo}
            actionLabel={lang('ParvaneChoosePhoto')}
          />
        )}
        <Island>
          <div className="settings-edit">
            <InputText
              id="group-title"
              label={lang('GroupName')}
              onChange={handleTitleChange}
              value={title}
              error={error === GROUP_TITLE_EMPTY ? error : undefined}
              disabled={!canChangeInfo}
            />
            {IS_GROUP_DESCRIPTION_SUPPORTED && (
              <TextArea
                id="group-about"
                label={lang('DescriptionPlaceholder')}
                maxLength={GROUP_MAX_DESCRIPTION}
                maxLengthIndicator={(GROUP_MAX_DESCRIPTION - about.length).toString()}
                onChange={handleAboutChange}
                value={about}
                disabled={!canChangeInfo}
                noReplaceNewlines
              />
            )}
          </div>
          {IS_GROUP_TYPE_SUPPORTED && chat.isCreator && (
            <ListItem icon="lock" multiline onClick={handleClickEditType}>
              <span className="title">{lang('GroupType')}</span>
              <span className="subtitle">{isPublicGroup ? lang('TypePublic') : lang('TypePrivate')}</span>
            </ListItem>
          )}
          {IS_GROUP_PERMISSIONS_SUPPORTED && (
            <ListItem
              icon="permissions"
              multiline
              onClick={handleClickPermissions}
              disabled={!canBanUsers}
            >
              <span className="title">{lang('ChannelPermissions')}</span>
              <span className="subtitle" dir="auto">
                {enabledPermissionsCount}
                /
                {TOTAL_PERMISSIONS_COUNT - (isForumEnabled ? 0 : 1)}
              </span>
            </ListItem>
          )}
          <ListItem
            icon="admin"
            multiline
            onClick={handleClickAdministrators}
          >
            <span className="title">{lang('ChannelAdministrators')}</span>
            <span className="subtitle">{formatInteger(adminsCount)}</span>
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
          {canInvite && <ManageJoinMode chatId={chatId} exportedInvites={exportedInvites} />}
          {IS_GROUP_REQUESTS_SUPPORTED && Boolean(chat.joinRequests?.length) && (
            <ListItem
              icon="add-user-filled"
              onClick={handleClickRequests}
              multiline
            >
              <span className="title">{lang('MemberRequests')}</span>
              <span className="subtitle">
                {formatInteger(chat.joinRequests.length)}
              </span>
            </ListItem>
          )}
          {groupL2?.isAvailable && (
            <>
              <ListItem icon="lock" ripple onClick={handleToggleL2}>
                <span>{lang('ParvaneL2Toggle')}</span>
                <Switch checked={Boolean(groupL2.isActive)} />
              </ListItem>
              <IslandDescription>{lang('ParvaneL2Info')}</IslandDescription>
            </>
          )}
        </Island>
        <Island>
          <ListItem icon="group" multiline onClick={handleClickMembers}>
            <span className="title">{lang('GroupMembers')}</span>
            <span className="subtitle">{formatInteger(chat.membersCount ?? 0)}</span>
          </ListItem>
        </Island>
        <Island>
          <ListItem icon="delete" ripple destructive onClick={openDeleteDialog}>
            {lang('DeleteMega')}
          </ListItem>
        </Island>
      </div>
      <FloatingActionButton
        isShown={isProfileFieldsTouched}
        onClick={handleUpdateGroup}
        disabled={isLoading}
        ariaLabel={lang('Save')}
        iconName="check"
        isLoading={isLoading}
      />
      <ConfirmDialog
        isOpen={isDeleteDialogOpen}
        onClose={closeDeleteDialog}
        textParts={renderText(
          isBasicGroup || !chat.isCreator
            ? lang('AreYouSureDeleteAndExit')
            : lang('AreYouSureDeleteThisChatWithGroup', chat.title),
          ['br', 'simple_markdown'],
        )}
        confirmLabel={isBasicGroup || !chat.isCreator ? lang('DeleteMega') : lang('DeleteGroupForAll')}
        confirmHandler={handleDeleteGroup}
        confirmIsDestructive
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): Complete<StateProps> => {
    const chat = selectChat(global, chatId)!;
    const chatFullInfo = selectChatFullInfo(global, chatId);
    const { management } = selectTabState(global);
    const { progress } = management;
    const isBasicGroup = isChatBasicGroup(chat);
    const { invites } = management.byChatId[chatId] || {};
    const canChangeInfo = chat.isCreator || getHasAdminRight(chat, 'changeInfo');
    const canBanUsers = chat.isCreator || getHasAdminRight(chat, 'banUsers');
    const canInvite = chat.isCreator || getHasAdminRight(chat, 'inviteUsers');

    return {
      chat,
      chatFullInfo,
      progress,
      isBasicGroup,
      canChangeInfo,
      canBanUsers,
      canInvite,
      exportedInvites: invites,
    };
  },
  (global, { chatId }) => {
    return Boolean(selectChat(global, chatId));
  },
)(ManageGroup));
