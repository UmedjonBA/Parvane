import {
  memo, useEffect, useLayoutEffect, useState,
} from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import type { ApiBirthday, ApiChat, ApiUser, ApiUserStatus } from '../../../api/types';
import { MediaViewerOrigin } from '../../../types';

import { MUTE_INDEFINITE_TIMESTAMP, UNMUTE_TIMESTAMP } from '../../../config';
import { getMainUsername, getUserFullName, getUserStatus } from '../../../global/helpers';
import { getIsChatMuted } from '../../../global/helpers/notifications';
import {
  selectChat, selectNotifyDefaults, selectNotifyException, selectUser, selectUserFullInfo, selectUserStatus,
} from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { formatDateToString } from '../../../util/dates/oldDateFormat';
import { callApi } from '../../../api/gramjs';
import renderText from '../../common/helpers/renderText';

import useInterval from '../../../hooks/schedulers/useInterval';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';
import useParvaneChatL2 from '../../../hooks/useParvaneChatL2';

import Avatar from '../../common/Avatar';
import UserBirthday from '../../common/profile/UserBirthday';
import PvSwitch from '../../parvane/notes/PvSwitch';

import groupStyles from '../groupInfo/GroupInfo.module.scss';
import styles from './PeerInfo.module.scss';

type OwnProps = {
  userId: string;
  isActive?: boolean;
  onOpenMedia: NoneToVoidFunction;
};

type StateProps = {
  user?: ApiUser;
  userStatus?: ApiUserStatus;
  note?: string;
  bio?: string;
  isBlocked?: boolean;
  isMuted?: boolean;
  personalChannel?: ApiChat;
  birthday?: ApiBirthday;
};

type SecurityInfo = { devices: { deviceId: string; fingerprint: string }[] };
type HiddenChat = { chatId: string; title: string };

const AVATAR_SIZE = 64;
// Изменения чужого профиля сервер не рассылает: открытая карточка перечитывается (SC-011, как `ProfileInfo`)
const OPEN_PROFILE_REFRESH_MS = 4000;
const NOTE_MAX_LENGTH = 4096;

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;

// Профиль собеседника по доске `RpChat`: шапка «аватар · имя · @ник · статус», заметка с правкой на месте (видна
// только вам; между своими устройствами — журналом контактов, CONTACT-1), «Защита переписки» (усиленная
// приватность, кто и когда включил, код безопасности), общие файлы и заметки, скрытые у себя сообщения участника
// в группах (REPORT-3), «Заблокировать». Медиа и общие группы — вкладки профиля ниже
const PeerInfo = ({
  userId, isActive, user, userStatus, note, bio, isBlocked, isMuted, personalChannel, birthday, onOpenMedia,
}: OwnProps & StateProps) => {
  const {
    updateContactNote, blockUser, unblockUser, openMediaViewer, parvaneSetMemberHidden, showNotification,
    updateChatMutedState, openChat, loadFullUser,
  } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();

  const [draft, setDraft] = useState(note || '');
  const [isCodeOpen, setIsCodeOpen] = useState(false);
  const [security, setSecurity] = useState<SecurityInfo | undefined>();
  const [hiddenChats, setHiddenChats] = useState<HiddenChat[]>([]);
  const [l2, toggleL2] = useParvaneChatL2(userId, 'isMine');

  // Начальное значение поля — до первого кадра (правило экрана spec 041)
  useLayoutEffect(() => {
    setDraft(note || '');
  }, [note, userId]);

  const hasUser = Boolean(user);
  useEffect(() => {
    if (hasUser && isActive !== false) loadFullUser({ userId });
  }, [hasUser, userId, isActive]);

  useInterval(() => {
    if (document.visibilityState === 'visible') loadFullUser({ userId });
  }, isActive !== false && hasUser ? OPEN_PROFILE_REFRESH_MS : undefined, true);

  useLayoutEffect(() => {
    setIsCodeOpen(false);
    setSecurity(undefined);
  }, [userId]);

  // Отпечатки — только по «сверить»: чтение журнала устройств собеседника при каждом открытии чата выдавало бы его
  // серверу (L2-1, сценарий `l2_metadata`)
  useEffect(() => {
    if (!isCodeOpen) return undefined;
    let isActual = true;
    const request = callParvane('parvaneFetchSecurityInfo', { chatId: userId }) as Promise<SecurityInfo | undefined>;
    void Promise.resolve(request)
      .then((info) => {
        if (isActual && info) setSecurity(info);
      }).catch(() => undefined);
    return () => {
      isActual = false;
    };
  }, [userId, isCodeOpen]);

  const loadHiddenChats = useLastCallback(() => {
    void Promise.resolve(callParvane('parvaneMemberHiddenChats', { userId }) as Promise<string[] | undefined>)
      .then((ids) => {
        // Названия — одноразовым чтением, не подпиской
        const global = getGlobal();
        setHiddenChats((ids || []).map((chatId) => ({ chatId, title: selectChat(global, chatId)?.title || '' })));
      }).catch(() => setHiddenChats([]));
  });

  useEffect(() => {
    loadHiddenChats();
  }, [userId, loadHiddenChats]);

  const handleNoteChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.currentTarget.value);
  });

  // Сохранение по уходу из поля (доска: правка на месте, без кнопки)
  const handleNoteBlur = useLastCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {
    const text = e.currentTarget.value.trim();
    if (text === (note || '').trim()) return;
    updateContactNote({ userId, note: { text } });
  });

  const handleAvatarClick = useLastCallback(() => {
    openMediaViewer({
      isAvatarView: true, chatId: userId, mediaIndex: 0, origin: MediaViewerOrigin.ProfileAvatar,
    });
  });

  // Сверх доски осталось (функция Telegram): уведомления чата и «О себе» собеседника
  const handleToggleNotifications = useLastCallback((isOn: boolean) => {
    updateChatMutedState({ chatId: userId, mutedUntil: isOn ? UNMUTE_TIMESTAMP : MUTE_INDEFINITE_TIMESTAMP });
  });

  const handleOpenChannel = useLastCallback(() => {
    if (personalChannel) openChat({ id: personalChannel.id });
  });

  const handleToggleCode = useLastCallback(() => setIsCodeOpen(!isCodeOpen));

  const handleCopyCode = useLastCallback(() => {
    const text = security?.devices.map((device) => device.fingerprint).join('\n');
    if (!text) return;
    copyTextToClipboard(text);
    showNotification({ message: lang('ParvanePeerCodeCopied') });
  });

  const handleToggleBlock = useLastCallback(() => {
    if (isBlocked) unblockUser({ userId });
    else blockUser({ userId });
  });

  const handleShowHidden = useLastCallback((chatId: string) => {
    parvaneSetMemberHidden({ chatId, userId, isHidden: false });
    setHiddenChats(hiddenChats.filter((chat) => chat.chatId !== chatId));
  });

  // «да, 12 ноября»: год — только у прошлых лет
  function formatSince(ms: number) {
    const isThisYear = new Date(ms).getFullYear() === new Date().getFullYear();
    return formatDateToString(ms, oldLang.code, isThisYear, 'long');
  }

  if (!user) return undefined;

  const username = getMainUsername(user);
  const status = getUserStatus(oldLang, user, userStatus);
  const handle = username && `@${username}${user.serverDomain ? `@${user.serverDomain}` : ''}`;
  const subtitle = [handle, status].filter(Boolean).join(' · ');
  const rowButtonClass = buildClassName(groupStyles.row, groupStyles.rowButton);
  const devices = security?.devices || [];
  const isByPeer = Boolean(l2?.isActive && l2.peerSinceMs);

  function renderProtection() {
    return (
      <>
        <div className={groupStyles.cap}>{lang('ParvanePeerProtection')}</div>
        <div className={groupStyles.grp} data-peer-protection>
          {l2?.isAvailable && (
            <PvSwitch
              className={groupStyles.row}
              isOn={Boolean(l2.isMine)}
              onChange={toggleL2}
              data-peer-l2
            >
              <span className={groupStyles.text}>
                <span>{oldLang('ParvaneL2Toggle')}</span>
                <span className={styles.hint}>{oldLang('ParvaneL2Info')}</span>
              </span>
            </PvSwitch>
          )}
          {l2?.isAvailable && (
            <div className={groupStyles.row} data-peer-l2-by>
              <span className={groupStyles.text}>{lang('ParvanePeerL2ByPeer')}</span>
              <span className={groupStyles.value}>
                {isByPeer
                  ? lang('ParvanePeerL2Since', { date: formatSince(l2.peerSinceMs!) })
                  : lang('ParvanePeerL2No')}
              </span>
            </div>
          )}
          <button
            type="button"
            className={rowButtonClass}
            aria-expanded={isCodeOpen}
            onClick={handleToggleCode}
            data-peer-code
          >
            <span className={groupStyles.text}>{lang('ParvanePeerCode')}</span>
            <span className={styles.action}>{lang('ParvanePeerCodeVerify')}</span>
          </button>
          {isCodeOpen && (
            <button type="button" className={rowButtonClass} onClick={handleCopyCode} data-peer-code-list>
              <span className={groupStyles.text}>
                {devices.length ? devices.map((device) => (
                  <span key={device.deviceId} className={buildClassName(groupStyles.mono, styles.code)}>
                    {device.fingerprint}
                  </span>
                )) : (
                  <span className={styles.hint}>{oldLang('ParvaneSecurityKeyNoDevices')}</span>
                )}
                <span className={styles.hint}>{oldLang('ParvaneSecurityKeyHint')}</span>
              </span>
            </button>
          )}
        </div>
        {l2?.isAvailable && <div className={styles.note}>{lang('ParvanePeerProtectionHint')}</div>}
      </>
    );
  }

  return (
    <div className={groupStyles.root} data-peer-info>
      <div className={styles.head}>
        <Avatar
          className={groupStyles.avatar}
          size={AVATAR_SIZE}
          peer={user}
          onClick={user.avatarPhotoId ? handleAvatarClick : undefined}
        />
        <div className={styles.headText}>
          <div className={styles.name}>{getUserFullName(user)}</div>
          {subtitle && <div className={styles.status} data-peer-status>{subtitle}</div>}
        </div>
      </div>

      <div className={groupStyles.grp}>
        {Boolean(bio) && (
          <div className={groupStyles.row} data-peer-bio>
            <span className={groupStyles.text}>
              <span className={groupStyles.about}>{renderText(bio, ['br', 'links', 'emoji'])}</span>
              <span className={groupStyles.sub}>{lang('ParvanePeerBio')}</span>
            </span>
          </div>
        )}
        {birthday && <UserBirthday birthday={birthday} user={user} />}
        <PvSwitch
          className={groupStyles.row}
          isOn={!isMuted}
          onChange={handleToggleNotifications}
          data-peer-notifications
        >
          <span className={groupStyles.text}>{lang('Notifications')}</span>
        </PvSwitch>
      </div>

      {/* Личный канал (функция Telegram сверх доски `RpChat`) — строкой блока */}
      {personalChannel && (
        <>
          <div className={groupStyles.cap}>{oldLang('ProfileChannel')}</div>
          <div className={groupStyles.grp}>
            <button type="button" className={rowButtonClass} onClick={handleOpenChannel} data-peer-channel>
              <span className={groupStyles.text}>
                <span className={groupStyles.title}>{personalChannel.title}</span>
                <span className={groupStyles.sub}>
                  {oldLang('Subscribers', personalChannel.membersCount, 'i')}
                </span>
              </span>
              <span className={groupStyles.chevron} aria-hidden>›</span>
            </button>
          </div>
        </>
      )}

      <div className={groupStyles.cap}>{lang('ParvanePeerNote')}</div>
      <div className={groupStyles.grp}>
        <textarea
          className={styles.noteInput}
          value={draft}
          maxLength={NOTE_MAX_LENGTH}
          rows={2}
          placeholder={lang('ParvanePeerNotePlaceholder')}
          aria-label={lang('ParvanePeerNote')}
          onChange={handleNoteChange}
          onBlur={handleNoteBlur}
          data-peer-note
        />
      </div>

      {renderProtection()}

      <div className={groupStyles.grp}>
        <button type="button" className={rowButtonClass} onClick={onOpenMedia} data-peer-shared>
          <span className={groupStyles.text}>{lang('ParvanePeerShared')}</span>
          <span className={groupStyles.chevron} aria-hidden>›</span>
        </button>
        {hiddenChats.map((chat) => (
          <button
            key={chat.chatId}
            type="button"
            className={rowButtonClass}
            onClick={() => handleShowHidden(chat.chatId)}
            data-peer-hidden-in={chat.chatId}
          >
            <span className={groupStyles.text}>
              <span className={groupStyles.title}>{lang('ParvanePeerShowHidden')}</span>
              <span className={groupStyles.sub}>{lang('ParvanePeerHiddenIn', { title: chat.title })}</span>
            </span>
          </button>
        ))}
        <button
          type="button"
          className={buildClassName(rowButtonClass, styles.danger)}
          onClick={handleToggleBlock}
          data-peer-block
        >
          <span className={groupStyles.text}>{lang(isBlocked ? 'ParvanePeerUnblock' : 'ParvanePeerBlock')}</span>
        </button>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { userId }): Complete<StateProps> => {
    const user = selectUser(global, userId);
    const fullInfo = selectUserFullInfo(global, userId);
    const chat = selectChat(global, userId);
    const isMuted = chat
      && getIsChatMuted(chat, selectNotifyDefaults(global), selectNotifyException(global, userId));
    return {
      user,
      userStatus: selectUserStatus(global, userId),
      note: fullInfo?.note?.text,
      bio: fullInfo?.bio,
      isBlocked: fullInfo?.isBlocked,
      isMuted,
      birthday: fullInfo?.birthday,
      personalChannel: fullInfo?.personalChannelId ? selectChat(global, fullInfo.personalChannelId) : undefined,
    };
  },
)(PeerInfo));
