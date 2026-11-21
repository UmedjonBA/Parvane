import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChat } from '../../../api/types';
import { ManagementScreens, MediaViewerOrigin } from '../../../types';

import { MUTE_INDEFINITE_TIMESTAMP, UNMUTE_TIMESTAMP } from '../../../config';
import {
  getHasAdminRight, getMainUsername, isChatChannel, isChatPublic, isUserRightBanned,
} from '../../../global/helpers';
import { getIsChatMuted } from '../../../global/helpers/notifications';
import {
  selectChat, selectChatFullInfo, selectNotifyDefaults, selectNotifyException,
} from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { callApi } from '../../../api/gramjs';
import renderText from '../../common/helpers/renderText';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Avatar from '../../common/Avatar';
import DeleteChatModal from '../../common/DeleteChatModal';
import PvSwitch from '../../parvane/notes/PvSwitch';

import styles from './GroupInfo.module.scss';

type OwnProps = {
  chatId: string;
  // Только «Покинуть группу»: на доске `ZpChat2` кнопка стоит после участников, которых рисует панель
  isLeaveOnly?: boolean;
  onOpenMedia?: NoneToVoidFunction;
};

type StateProps = {
  chat?: ApiChat;
  about?: string;
  inviteLink?: string;
  isMuted?: boolean;
  canOpenType?: boolean;
  canInvite?: boolean;
};

// Публичная ссылка группы на этом сервере (spec 023): адрес сервера и `@имя`
const PUBLIC_LINK_PREFIX = `${window.location.origin}/@`;
const AVATAR_SIZE = 72;
// «Файлы и медиа · 312» (доска `ZpChat2`): фото и видео плюс файлы
const MEDIA_COUNT_TYPES = ['media', 'documents'];

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<{ totalCount?: number }>;

// Сведения о группе и канале по доске `ZpChat2` («Linux-чат · группа · 214 участников»): уведомления, тип, имя на
// сервере, описание и ссылка строками; общее в группе; «Покинуть». Участники и медиа — вкладки профиля ниже
const GroupInfo = ({
  chatId, chat, about, inviteLink, isMuted, canOpenType, canInvite, isLeaveOnly, onOpenMedia,
}: OwnProps & StateProps) => {
  const {
    updateChatMutedState, requestNextManagementScreen, showNotification, openMediaViewer, loadMoreProfilePhotos,
  } = getActions();
  const lang = useLang();
  const [isLeaveOpen, openLeave, closeLeave] = useFlag();
  const [mediaCount, setMediaCount] = useState<number>();

  useEffect(() => {
    setMediaCount(undefined);
    let isActual = true;
    void Promise.all(MEDIA_COUNT_TYPES.map((type) => Promise.resolve(
      callParvane('searchMessagesInChat', { peer: { id: chatId }, type }),
    )
      .then((result) => result?.totalCount || 0)
      .catch(() => 0)))
      .then((counts) => {
        if (isActual) setMediaCount(counts.reduce((sum, count) => sum + count, 0));
      });
    return () => {
      isActual = false;
    };
  }, [chatId]);

  const hasPhoto = Boolean(chat?.avatarPhotoId);
  useEffect(() => {
    if (hasPhoto) loadMoreProfilePhotos({ peerId: chatId });
  }, [chatId, hasPhoto]);

  const handleToggleNotifications = useLastCallback((isOn: boolean) => {
    updateChatMutedState({ chatId, mutedUntil: isOn ? UNMUTE_TIMESTAMP : MUTE_INDEFINITE_TIMESTAMP });
  });

  const handleOpenType = useLastCallback(() => {
    requestNextManagementScreen({ screen: ManagementScreens.ChatPrivacyType });
  });

  const handleAvatarClick = useLastCallback(() => {
    openMediaViewer({
      isAvatarView: true, chatId, mediaIndex: 0, origin: MediaViewerOrigin.ProfileAvatar,
    });
  });

  if (!chat) return undefined;

  const isChannel = isChatChannel(chat);
  const isPublic = isChatPublic(chat);
  const publicName = isPublic ? getMainUsername(chat) : undefined;
  const typeValue = lang(isChannel
    ? (isPublic ? 'ParvaneChannelTypePublic' : 'ParvaneChannelTypeClosed')
    : (isPublic ? 'ParvaneGroupTypePublic' : 'ParvaneGroupTypeClosed'));
  const link = publicName ? `${PUBLIC_LINK_PREFIX}${publicName}` : (canInvite ? inviteLink : undefined);

  const rowButtonClass = buildClassName(styles.row, styles.rowButton);
  const typeTitle = lang(isChannel ? 'ParvaneChannelType' : 'ParvaneGroupType');

  function copyLink() {
    copyTextToClipboard(link!);
    showNotification({ message: lang('ParvaneGroupInfoLinkCopied') });
  }

  if (isLeaveOnly) {
    if (chat.isNotJoined) return undefined;
    return (
      <div className={styles.actions}>
        <button type="button" className={styles.leave} onClick={openLeave} data-group-leave>
          {lang(isChannel ? 'ParvaneChannelLeave' : 'ParvaneGroupLeave')}
        </button>
        <DeleteChatModal isOpen={isLeaveOpen} chat={chat} onClose={closeLeave} />
      </div>
    );
  }

  return (
    <div className={styles.root} data-group-info>
      {hasPhoto && (
        <div className={styles.head}>
          <Avatar
            className={styles.avatar}
            size={AVATAR_SIZE}
            peer={chat}
            onClick={handleAvatarClick}
          />
        </div>
      )}
      <div className={styles.grp}>
        {Boolean(about) && (
          <div className={styles.row} data-group-about>
            <span className={styles.text}>
              <span className={styles.about}>{renderText(about, ['br', 'links', 'emoji'])}</span>
              <span className={styles.sub}>{lang('ParvaneGroupInfoAbout')}</span>
            </span>
          </div>
        )}
        <PvSwitch
          className={styles.row}
          isOn={!isMuted}
          onChange={handleToggleNotifications}
          data-group-notifications
        >
          <span className={styles.text}>{lang('Notifications')}</span>
        </PvSwitch>
        {canOpenType ? (
          <button type="button" className={rowButtonClass} onClick={handleOpenType} data-group-type>
            <span className={styles.text}>{typeTitle}</span>
            <span className={styles.value}>{typeValue}</span>
          </button>
        ) : (
          <div className={styles.row} data-group-type>
            <span className={styles.text}>{typeTitle}</span>
            <span className={styles.value}>{typeValue}</span>
          </div>
        )}
        {publicName && (
          <button
            type="button"
            className={rowButtonClass}
            onClick={copyLink}
            data-group-public-name
          >
            <span className={styles.text}>{lang('ParvaneGroupInfoServerName')}</span>
            <span className={buildClassName(styles.value, styles.mono)}>{publicName}</span>
          </button>
        )}
        {!publicName && link && (
          <button
            type="button"
            className={rowButtonClass}
            onClick={copyLink}
            data-group-invite-link
          >
            <span className={styles.text}>
              <span className={styles.title}>{lang('ParvaneGroupInfoInviteLink')}</span>
              <span className={buildClassName(styles.sub, styles.mono)}>{link}</span>
            </span>
          </button>
        )}
      </div>

      <div className={styles.cap}>
        {lang(isChannel ? 'ParvaneChannelInfoShared' : 'ParvaneGroupInfoShared')}
      </div>
      <div className={styles.grp}>
        <button type="button" className={rowButtonClass} onClick={onOpenMedia} data-group-media>
          <span className={styles.text}>{lang('ParvaneGroupInfoMedia')}</span>
          {mediaCount !== undefined && <span className={styles.value} data-group-media-count>{mediaCount}</span>}
          <span className={styles.chevron} aria-hidden>›</span>
        </button>
      </div>

    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): Complete<StateProps> => {
    const chat = selectChat(global, chatId);
    const fullInfo = selectChatFullInfo(global, chatId);
    const isMuted = chat
      && getIsChatMuted(chat, selectNotifyDefaults(global), selectNotifyException(global, chatId));
    const canChangeInfo = chat && (chat.isCreator || getHasAdminRight(chat, 'changeInfo'));
    const canInviteAsAdmin = chat && (chat.isCreator || getHasAdminRight(chat, 'inviteUsers'));
    const canInvite = chat && (canInviteAsAdmin
      || (!isChatChannel(chat) && !isUserRightBanned(chat, 'inviteUsers')));

    return {
      chat,
      about: fullInfo?.about,
      inviteLink: fullInfo?.inviteLink,
      isMuted,
      canOpenType: Boolean(canChangeInfo || canInviteAsAdmin),
      canInvite,
    };
  },
)(GroupInfo));
