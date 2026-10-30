import {
  memo, useEffect,
} from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { ApiMessage } from '../../../api/types';
import type { MessageListType, ThreadId } from '../../../types';

import {
  CONTENT_TYPES_WITH_PREVIEW, DEBUG_LOG_FILENAME, SUPPORTED_AUDIO_CONTENT_TYPES,
  SUPPORTED_PHOTO_CONTENT_TYPES,
  SUPPORTED_VIDEO_CONTENT_TYPES,
} from '../../../config';
import {
  getMessageAudio, getMessageDocument,
  getMessagePhoto,
  getMessageVideo, getMessageVoice,
} from '../../../global/helpers';
import { IS_TOUCH_ENV } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import { getDebugLogs } from '../../../util/debugConsole';
import { validateFiles } from '../../../util/files';
import { openSystemFilesDialog } from '../../../util/systemFilesDialog';
import { callApi } from '../../../api/gramjs';
import { requestCloudAttach } from '../../parvane/cloud/cloudBridge';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMouseInside from '../../../hooks/useMouseInside';
import useOldLang from '../../../hooks/useOldLang';

import Icon from '../../common/icons/Icon';
import ArticlePickerModal from '../../parvane/article/ArticlePickerModal';
import TaskOfferModal from '../../parvane/taskOffer/TaskOfferModal';
import Menu from '../../ui/Menu';
import MenuItem from '../../ui/MenuItem';
import NestedMenuItem from '../../ui/NestedMenuItem';
import ResponsiveHoverButton from '../../ui/ResponsiveHoverButton';

import './AttachMenu.scss';

export type OwnProps = {
  chatId: string;
  threadId?: ThreadId;
  isButtonVisible: boolean;
  canAttachMedia: boolean;
  canAttachPolls: boolean;
  canAttachToDoLists: boolean;
  canSendPhotos: boolean;
  canSendVideos: boolean;
  canSendDocuments: boolean;
  canSendAudios: boolean;
  isScheduled?: boolean;
  shouldCollectDebugLogs?: boolean;
  canEditMedia?: boolean;
  editingMessage?: ApiMessage;
  messageListType: MessageListType;
  paidMessagesStars?: number;
  menuPositionX: 'left' | 'right';
  onFileSelect: (files: File[]) => void;
  onTodoListCreate: NoneToVoidFunction;
  onMenuOpen: NoneToVoidFunction;
  onMenuClose: NoneToVoidFunction;
};

// Live-локация: длительность трансляции (сек), как в Telegram
const LIVE_LOCATION_PERIODS = [15 * 60, 60 * 60, 8 * 60 * 60];

const AttachMenu = ({
  chatId,
  threadId,
  isButtonVisible,
  canAttachMedia,
  canAttachPolls,
  canAttachToDoLists,
  canSendPhotos,
  canSendVideos,
  canSendDocuments,
  canSendAudios,
  isScheduled,
  shouldCollectDebugLogs,
  canEditMedia,
  editingMessage,
  messageListType,
  paidMessagesStars,
  menuPositionX,
  onFileSelect,
  onMenuOpen,
  onMenuClose,
  onTodoListCreate,
}: OwnProps) => {
  const {
    openPollModal,
    updateAttachmentSettings,
  } = getActions();
  const [isAttachMenuOpen, openAttachMenu, closeAttachMenu] = useFlag();
  const [handleMouseEnter, handleMouseLeave, markMouseInside] = useMouseInside(isAttachMenuOpen, closeAttachMenu);
  // Parvane (spec 011): задание в чат — форма открывается из меню вложений
  const [isTaskOfferOpen, openTaskOffer, closeTaskOffer] = useFlag();
  const [isArticleOpen, openArticle, closeArticle] = useFlag();

  const canSendVideoAndPhoto = canSendPhotos && canSendVideos;
  const canSendVideoOrPhoto = canSendPhotos || canSendVideos;

  const isMenuOpen = isAttachMenuOpen;

  const isPhotoOrVideo = editingMessage && editingMessage?.groupedId
    && Boolean(getMessagePhoto(editingMessage)
      || Boolean(getMessageVideo(editingMessage)));
  const isFile = editingMessage && editingMessage?.groupedId && Boolean(getMessageAudio(editingMessage)
    || getMessageVoice(editingMessage) || getMessageDocument(editingMessage));

  useEffect(() => {
    if (isAttachMenuOpen) {
      markMouseInside();
    }
  }, [isAttachMenuOpen, markMouseInside]);

  useEffect(() => {
    if (isMenuOpen) {
      onMenuOpen();
    } else {
      onMenuClose();
    }
  }, [isMenuOpen, onMenuClose, onMenuOpen]);

  const handleToggleAttachMenu = useLastCallback(() => {
    if (isAttachMenuOpen) {
      closeAttachMenu();
    } else {
      openAttachMenu();
    }
  });

  const handleFileSelect = useLastCallback((e: Event) => {
    const { files } = e.target as HTMLInputElement;
    const validatedFiles = validateFiles(files);

    if (validatedFiles?.length) {
      onFileSelect(validatedFiles);
    }
  });

  const sendParvaneLocation = useLastCallback((period?: number) => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const chat = getGlobal().chats.byId[chatId];
      if (!chat) return;
      const heading = typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading)
        ? Math.round(pos.coords.heading) : undefined;
      void (callApi as unknown as (n: string, a: unknown) => void)('parvaneSendLocation', {
        chat,
        lat: pos.coords.latitude,
        long: pos.coords.longitude,
        period,
        heading,
        accuracy: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : undefined,
      });
    }, undefined, { enableHighAccuracy: Boolean(period) });
  });

  const handleParvaneLocation = useLastCallback(() => sendParvaneLocation());
  const handleParvaneLiveLocation15 = useLastCallback(() => sendParvaneLocation(LIVE_LOCATION_PERIODS[0]));
  const handleParvaneLiveLocation1h = useLastCallback(() => sendParvaneLocation(LIVE_LOCATION_PERIODS[1]));
  const handleParvaneLiveLocation8h = useLastCallback(() => sendParvaneLocation(LIVE_LOCATION_PERIODS[2]));

  const handleQuickSelect = useLastCallback(() => {
    updateAttachmentSettings({ shouldCompress: true });
    openSystemFilesDialog(
      Array.from(canSendVideoAndPhoto ? CONTENT_TYPES_WITH_PREVIEW : (
        canSendPhotos ? SUPPORTED_PHOTO_CONTENT_TYPES : SUPPORTED_VIDEO_CONTENT_TYPES
      )).join(','),
      (e) => handleFileSelect(e),
    );
  });

  const handleDocumentSelect = useLastCallback(() => {
    updateAttachmentSettings({ shouldCompress: false });
    openSystemFilesDialog(!canSendDocuments && canSendAudios
      ? Array.from(SUPPORTED_AUDIO_CONTENT_TYPES).join(',') : (
        '*'
      ), (e) => handleFileSelect(e));
  });

  const handleSendLogs = useLastCallback(() => {
    const file = new File([getDebugLogs()], DEBUG_LOG_FILENAME, { type: 'text/plain' });
    onFileSelect([file]);
  });

  const oldLang = useOldLang();
  const lang = useLang();

  const handlePollCreate = useLastCallback(() => {
    closeAttachMenu();
    openPollModal({ chatId, threadId, messageListType });
  });

  // Parvane (spec 016): файлы из облака — без загрузки с устройства
  const handleCloudAttach = useLastCallback(() => {
    closeAttachMenu();
    requestCloudAttach(chatId);
  });

  const handleTaskOfferCreate = useLastCallback(() => {
    closeAttachMenu();
    openTaskOffer();
  });

  // Статья (ARTICLE-1): заметка «Знаний» целиком, читается в окне
  const handleArticlePick = useLastCallback(() => {
    closeAttachMenu();
    openArticle();
  });

  if (!isButtonVisible && !isTaskOfferOpen && !isArticleOpen) {
    return undefined;
  }

  return (
    <div className="AttachMenu">
      {isButtonVisible && (
        <>
          {
            editingMessage && canEditMedia ? (
              <ResponsiveHoverButton
                id="replace-menu-button"
                className={buildClassName('AttachMenu--button composer-action-button', isAttachMenuOpen && 'activated')}
                round
                color="translucent"
                onActivate={handleToggleAttachMenu}
                ariaLabel="Replace an attachment"
                ariaControls="replace-menu-controls"
                hasPopup
              >
                <Icon name="replace" />
              </ResponsiveHoverButton>
            ) : (
              <ResponsiveHoverButton
                id="attach-menu-button"
                disabled={Boolean(editingMessage)}
                className={buildClassName('AttachMenu--button composer-action-button', isAttachMenuOpen && 'activated')}
                round
                color="translucent"
                onActivate={handleToggleAttachMenu}
                ariaLabel="Add an attachment"
                ariaControls="attach-menu-controls"
                hasPopup
              >
                <Icon name="attach" />
              </ResponsiveHoverButton>
            )
          }
          <Menu
            id="attach-menu-controls"
            isOpen={isMenuOpen}
            autoClose
            positionX={menuPositionX}
            positionY="bottom"
            onClose={closeAttachMenu}
            className="AttachMenu--menu fluid"
            onCloseAnimationEnd={closeAttachMenu}
            onMouseEnter={!IS_TOUCH_ENV ? handleMouseEnter : undefined}
            onMouseLeave={!IS_TOUCH_ENV ? handleMouseLeave : undefined}
            noCloseOnBackdrop={!IS_TOUCH_ENV}
            ariaLabelledBy="attach-menu-button"
          >
            {/*
           ** Using ternary operator here causes some attributes from first clause
           ** transferring to the fragment content in the second clause
           */}
            {!canAttachMedia && (
              <MenuItem className="media-disabled" disabled>
                {lang(messageListType === 'scheduled' && paidMessagesStars
                  ? 'DescriptionScheduledPaidMediaNotAllowed'
                  : 'DescriptionRestrictedMedia')}
              </MenuItem>
            )}
            {canAttachMedia && (
              <>
                {canSendVideoOrPhoto && !isFile && (
                  <MenuItem icon="photo" onClick={handleQuickSelect}>
                    {oldLang(canSendVideoAndPhoto ? 'AttachmentMenu.PhotoOrVideo'
                      : (canSendPhotos ? 'InputAttach.Popover.Photo' : 'InputAttach.Popover.Video'))}
                  </MenuItem>
                )}
                {((canSendDocuments || canSendAudios) && !isPhotoOrVideo)
                  && (
                    <MenuItem icon="document" onClick={handleDocumentSelect}>
                      {oldLang(!canSendDocuments && canSendAudios ? 'InputAttach.Popover.Music' : 'AttachDocument')}
                    </MenuItem>
                  )}
                {canSendDocuments && shouldCollectDebugLogs && (
                  <MenuItem icon="bug" onClick={handleSendLogs}>
                    {oldLang('DebugSendLogs')}
                  </MenuItem>
                )}
              </>
            )}
            {canAttachPolls && !editingMessage && (
              <MenuItem icon="poll" onClick={handlePollCreate}>{lang('Poll')}</MenuItem>
            )}
            {!editingMessage && (
              <NestedMenuItem
                icon="location"
                submenu={(
                  <>
                    <MenuItem onClick={handleParvaneLocation}>{lang('ParvaneLocationCurrent')}</MenuItem>
                    <MenuItem onClick={handleParvaneLiveLocation15}>{lang('ParvaneLiveLocation15Min')}</MenuItem>
                    <MenuItem onClick={handleParvaneLiveLocation1h}>{lang('ParvaneLiveLocation1Hour')}</MenuItem>
                    <MenuItem onClick={handleParvaneLiveLocation8h}>{lang('ParvaneLiveLocation8Hours')}</MenuItem>
                  </>
                )}
              >
                {lang('AttachLocation')}
              </NestedMenuItem>
            )}
            {canAttachToDoLists && !editingMessage && (
              <MenuItem icon="select" onClick={onTodoListCreate}>{lang('TitleToDoList')}</MenuItem>
            )}
            {/* GROUP-2: файл из облака уходит документом — без права на документы пункта нет */}
            {!editingMessage && !isScheduled && canAttachMedia && canSendDocuments && (
              <MenuItem icon="folder" onClick={handleCloudAttach}>{lang('ParvaneCloudAttachFromCloud')}</MenuItem>
            )}
            {!editingMessage && !isScheduled && (
              <MenuItem icon="document" onClick={handleArticlePick}>{lang('ArticleMenuItem')}</MenuItem>
            )}
            {!editingMessage && !isScheduled && (
              <MenuItem icon="check" onClick={handleTaskOfferCreate}>{lang('TaskOfferMenuItem')}</MenuItem>
            )}
          </Menu>
        </>
      )}
      <TaskOfferModal isOpen={isTaskOfferOpen} chatId={chatId} onClose={closeTaskOffer} />
      <ArticlePickerModal isOpen={isArticleOpen} chatId={chatId} onClose={closeArticle} />
    </div>
  );
};

export default memo(AttachMenu);
