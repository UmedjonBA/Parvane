import {
  memo, useEffect,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

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
import { requestCloudAttach } from '../../parvane/cloud/cloudBridge';

import useAppLayout from '../../../hooks/useAppLayout';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMouseInside from '../../../hooks/useMouseInside';
import useOldLang from '../../../hooks/useOldLang';
import useParvaneModules from '../../../hooks/useParvaneModules';

import Icon from '../../common/icons/Icon';
import ArticlePickerModal from '../../parvane/article/ArticlePickerModal';
import LocationScreen from '../../parvane/chatScreen/LocationScreen';
import TaskOfferModal from '../../parvane/taskOffer/TaskOfferModal';
import Menu from '../../ui/Menu';
import MenuItem from '../../ui/MenuItem';
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
  // Пункты выключенных модулей в меню не показываются (экран «Модули»)
  const { enabled: enabledModules } = useParvaneModules();
  const isFilesOn = enabledModules.includes('files');
  const isNotesOn = enabledModules.includes('notes');
  const isPlanOn = enabledModules.includes('plan');
  const [isArticleOpen, openArticle, closeArticle] = useFlag();
  const [isLocationOpen, openLocation, closeLocation] = useFlag();

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
  // На телефоне меню — шторка во всю ширину: рисуется вне полосы ввода, иначе её сдвиг обрезал бы края
  const { isMobile } = useAppLayout();
  // Шторка на узком экране открывается и закрывается только нажатием: меню по наведению — для компьютера
  const isHoverMenu = !IS_TOUCH_ENV && !isMobile;

  // Меню, открытое наведением на компьютере, не должно стать шторкой поверх экрана при сужении окна
  useEffect(() => {
    closeAttachMenu();
  }, [isMobile, closeAttachMenu]);

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

  if (!isButtonVisible && !isTaskOfferOpen && !isArticleOpen && !isLocationOpen) {
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
                noHoverActivation={isMobile}
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
                noHoverActivation={isMobile}
                ariaLabel="Add an attachment"
                ariaControls="attach-menu-controls"
                hasPopup
              >
                <Icon name="attach" />
              </ResponsiveHoverButton>
            )
          }
          <Menu
            // Смена раскладки переносит меню в портал: без нового ключа у пересозданного пузыря нет классов
            // скрытого состояния (их ставит `useShowTransition` на прежний элемент), и он виден поверх экрана
            key={isMobile ? 'sheet' : 'menu'}
            id="attach-menu-controls"
            isOpen={isMenuOpen}
            autoClose
            positionX={menuPositionX}
            positionY="bottom"
            onClose={closeAttachMenu}
            className="AttachMenu--menu fluid"
            withPortal={isMobile}
            onCloseAnimationEnd={closeAttachMenu}
            onMouseEnter={isHoverMenu ? handleMouseEnter : undefined}
            onMouseLeave={isHoverMenu ? handleMouseLeave : undefined}
            noCloseOnBackdrop={isHoverMenu}
            ariaLabelledBy="attach-menu-button"
          >
            {/*
           ** Using ternary operator here causes some attributes from first clause
           ** transferring to the fragment content in the second clause
           */}
            <div className="AttachMenu--caption">{lang('AttachMenuTitle')}</div>
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
                    <MenuItem icon="document" className="attach-tile--file" onClick={handleDocumentSelect}>
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
              <MenuItem icon="poll" className="attach-tile--poll" onClick={handlePollCreate}>{lang('Poll')}</MenuItem>
            )}
            {!editingMessage && (
              <MenuItem icon="location" className="attach-tile--place" onClick={openLocation}>
                {lang('AttachLocation')}
              </MenuItem>
            )}
            {canAttachToDoLists && !editingMessage && (
              <MenuItem icon="select" onClick={onTodoListCreate}>{lang('TitleToDoList')}</MenuItem>
            )}
            {/* GROUP-2: файл из облака уходит документом — без права на документы пункта нет */}
            {isFilesOn && !editingMessage && !isScheduled && canAttachMedia && canSendDocuments && (
              <MenuItem icon="folder" onClick={handleCloudAttach}>{lang('ParvaneCloudAttachFromCloud')}</MenuItem>
            )}
            {isNotesOn && !editingMessage && !isScheduled && (
              <MenuItem icon="document" className="attach-tile--note" onClick={handleArticlePick}>
                {lang('ArticleMenuItem')}
              </MenuItem>
            )}
            {isPlanOn && !editingMessage && !isScheduled && (
              <MenuItem icon="calendar" className="attach-tile--plan" onClick={handleTaskOfferCreate}>
                {lang('TaskOfferMenuItem')}
              </MenuItem>
            )}
          </Menu>
        </>
      )}
      <TaskOfferModal isOpen={isTaskOfferOpen} chatId={chatId} onClose={closeTaskOffer} />
      <LocationScreen isOpen={isLocationOpen} chatId={chatId} onClose={closeLocation} />
      <ArticlePickerModal isOpen={isArticleOpen} chatId={chatId} onClose={closeArticle} />
    </div>
  );
};

export default memo(AttachMenu);
