import { memo, useMemo, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChat } from '../../../api/types';
import type { ShareDestination, SharedPayload } from '../../../util/shareTarget';

import { ALL_FOLDER_ID } from '../../../config';
import { getChatTitle } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { validateFiles } from '../../../util/files';
import { getIsModuleOn } from '../../../util/parvaneModules';
import { openNote } from '../../../util/parvaneSection';
import { buildSharedText, getShareDestinations } from '../../../util/shareTarget';
import { formatFileSize } from '../../../util/textFormat';
import { getMusicInfo } from '../music/musicPlayer';

import useAppLayout from '../../../hooks/useAppLayout';
import useDerivedState from '../../../hooks/useDerivedState';
import { useFolderManagerForOrderedIds } from '../../../hooks/useFolderManager';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Avatar from '../../common/Avatar';
import PvIcon from '../notes/PvIcon';
import PvSheet from '../notes/PvSheet';
import ShareNotePicker from './ShareNotePicker';

import kit from '../notes/PvKit.module.scss';
import styles from './ShareSheet.module.scss';

type OwnProps = {
  shared?: SharedPayload;
  onClose: NoneToVoidFunction;
};

type StateProps = {
  chatsById: Record<string, ApiChat>;
  currentUserId?: string;
};

const RECENT_CHATS_COUNT = 4;

// Облако, заметки и отправка — отдельной частью сборки: экран «Поделиться» открывается редко
function loadShareActions() {
  return import('./shareActions');
}
const TEXT_PREVIEW_LENGTH = 160;

const DESTINATION_ICONS = {
  chat: 'chat', files: 'folder', note: 'note', music: 'play',
} as const;
const DESTINATION_KEYS = {
  chat: { title: 'ShareToChat', hint: 'ShareToChatHint' },
  files: { title: 'ShareToFiles', hint: 'ShareToFilesHint' },
  note: { title: 'ShareToNote', hint: 'ShareToNoteHint' },
  music: { title: 'PvSysShareToMusic', hint: 'PvSysShareToMusicHint' },
} as const;

// Parvane (spec 041 F2, доска `ZpSysGen`): «Поделиться в Parvane» — что получено, куда отправить (чат,
// «Файлы», заметка — новая либо существующая, аудио — в «Музыку»; «Файлы», «Заметка» и «Музыка» — только при
// включённых модулях), недавние чаты с выбором и подписью
const ShareSheet = ({
  shared, chatsById, currentUserId, onClose,
}: OwnProps & StateProps) => {
  const { openChatWithDraft, showNotification } = getActions();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [isNotePicking, setIsNotePicking] = useState(false);
  const musicInfo = useDerivedState(getMusicInfo);
  const lang = useLang();
  // Телефон: страница во весь экран с «✕» слева (доска `ZpSysGen`)
  const { isMobile } = useAppLayout();

  const orderedIds = useFolderManagerForOrderedIds(ALL_FOLDER_ID);
  const recentIds = useMemo(() => (orderedIds || []).filter((id) => chatsById[id]).slice(0, RECENT_CHATS_COUNT),
    [orderedIds, chatsById]);

  const files = shared?.files || [];
  const sharedText = shared ? buildSharedText(shared) : '';
  const destinations = getShareDestinations(files, getIsModuleOn, Boolean(musicInfo?.isUploadEnabled));

  const getTitle = (chatId: string) => getChatTitle(lang, chatsById[chatId], chatId === currentUserId);

  // Экран остаётся смонтированным: выбор и подпись не должны перейти к следующему «Поделиться»
  const handleClose = useLastCallback(() => {
    setSelectedIds([]);
    setCaption('');
    setIsNotePicking(false);
    onClose();
  });

  const runSave = useLastCallback(async (save: () => Promise<string | undefined>) => {
    setIsBusy(true);
    const message = await save().catch(() => undefined);
    setIsBusy(false);
    showNotification({ message: message || lang('ShareFailed') });
    if (message) handleClose();
  });

  const handleDestination = useLastCallback((destination: ShareDestination) => {
    if (!shared) return;
    if (destination === 'chat') {
      handleClose();
      openChatWithDraft({
        text: { text: [caption.trim(), sharedText].filter(Boolean).join('\n') }, files: validateFiles(files),
      });
      return;
    }
    if (destination === 'files') {
      void runSave(async () => {
        const { saveSharedToFiles } = await loadShareActions();
        const isSaved = await saveSharedToFiles(files, lang('ShareIncomingFolder'), currentUserId);
        return isSaved ? lang('ShareSavedToFiles') : undefined;
      });
      return;
    }
    if (destination === 'music') {
      void runSave(async () => {
        const { saveSharedToMusic } = await loadShareActions();
        return await saveSharedToMusic(files) ? lang('PvSysShareSavedToMusic') : undefined;
      });
      return;
    }
    setIsNotePicking(true);
  });

  const handleNewNote = useLastCallback(() => {
    if (!shared) return;
    void runSave(async () => {
      const { saveSharedToNote } = await loadShareActions();
      const title = await saveSharedToNote(
        shared, sharedText, lang('KnowledgeVaultName'), lang('MessageNoteTitle'), currentUserId,
      );
      if (!title) return undefined;
      openNote(title);
      return lang('ShareSavedToNote', { title });
    });
  });

  const handlePickNote = useLastCallback((noteId: string) => {
    if (!shared) return;
    void runSave(async () => {
      const { saveSharedToExistingNote } = await loadShareActions();
      const title = await saveSharedToExistingNote(
        shared, sharedText, noteId, lang('KnowledgeVaultName'), currentUserId,
      );
      if (!title) return undefined;
      openNote(title);
      return lang('ShareSavedToNote', { title });
    });
  });

  const handleNoteBack = useLastCallback(() => {
    setIsNotePicking(false);
  });

  const handleToggleChat = useLastCallback((chatId: string) => {
    setSelectedIds((ids) => (ids.includes(chatId) ? ids.filter((id) => id !== chatId) : [...ids, chatId]));
  });

  const handleCaptionChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCaption(e.currentTarget.value);
  });

  const handleSend = useLastCallback(() => {
    if (!selectedIds.length) return;
    const text = [caption.trim(), sharedText].filter(Boolean).join('\n');
    const chatIds = selectedIds;
    handleClose();
    void loadShareActions().then(({ sendSharedToChats }) => sendSharedToChats(chatIds, text, files));
  });

  function renderShared() {
    if (files.length) {
      return files.map((file) => (
        <div key={`${file.name}-${file.size}`} className={kit.row}>
          <PvIcon name={file.type.startsWith('image/') ? 'image' : 'file'} />
          <span className={kit.rowText}>
            <span className={kit.ttl}>{file.name}</span>
            <span className={kit.sub}>{lang('ShareFromApp', { size: formatFileSize(lang, file.size) })}</span>
          </span>
        </div>
      ));
    }
    return (
      <div className={kit.row}>
        <PvIcon name="text" />
        <span className={buildClassName(kit.rowText, styles.text)} dir="auto">
          {sharedText.slice(0, TEXT_PREVIEW_LENGTH)}
        </span>
      </div>
    );
  }

  const sendLabel = selectedIds.length === 1
    ? lang('ShareSendTo', { name: getTitle(selectedIds[0]) })
    : lang('ShareSendToCount', { count: selectedIds.length }, { pluralValue: selectedIds.length });

  return (
    <PvSheet
      isOpen={Boolean(shared)}
      title={lang(isNotePicking ? 'ShareToNote' : 'ShareTitle')}
      isTight
      isPage
      startClose={isNotePicking ? 'back' : isMobile ? 'cancel' : undefined}
      onClose={isNotePicking ? handleNoteBack : handleClose}
    >
      {isNotePicking ? (
        <div className={styles.root} data-share-sheet>
          <ShareNotePicker isBusy={isBusy} onNew={handleNewNote} onPick={handlePickNote} />
        </div>
      ) : renderMain()}
    </PvSheet>
  );

  function renderMain() {
    return (
      <div className={styles.root} data-share-sheet>
        <div className={styles.group} data-share-content>{renderShared()}</div>
        <p className={kit.grp}>{lang('ShareWhere')}</p>
        <div className={styles.group}>
          {destinations.map((destination) => (
            <button
              key={destination}
              type="button"
              className={kit.row}
              disabled={isBusy}
              data-share-to={destination}
              onClick={() => handleDestination(destination)}
            >
              <PvIcon name={DESTINATION_ICONS[destination]} />
              <span className={kit.rowText}>
                <span className={kit.ttl}>{lang(DESTINATION_KEYS[destination].title)}</span>
                <span className={kit.sub}>{lang(DESTINATION_KEYS[destination].hint)}</span>
              </span>
              <PvIcon name="right" isSmall />
            </button>
          ))}
        </div>
        {Boolean(recentIds.length) && (
          <>
            <p className={kit.grp}>{lang('ShareRecentChats')}</p>
            <div className={styles.group}>
              {recentIds.map((chatId) => (
                <label key={chatId} className={kit.row} data-share-chat={chatId}>
                  <Avatar peer={chatsById[chatId]} isSavedMessages={chatId === currentUserId} size="small" />
                  <span className={buildClassName(kit.rowText, kit.ttl)}>{getTitle(chatId)}</span>
                  <input
                    type="checkbox"
                    className={styles.check}
                    checked={selectedIds.includes(chatId)}
                    onChange={() => handleToggleChat(chatId)}
                  />
                </label>
              ))}
            </div>
            <label className={styles.caption}>
              <span className={kit.sub}>{lang('ShareCaption')}</span>
              <input
                className={kit.input}
                value={caption}
                placeholder={lang('ShareCaptionPlaceholder')}
                data-share-caption
                onChange={handleCaptionChange}
              />
            </label>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide, styles.send)}
              disabled={!selectedIds.length || isBusy}
              data-share-send
              onClick={handleSend}
            >
              {selectedIds.length ? sendLabel : lang('ShareChooseChat')}
            </button>
          </>
        )}
        <p className={buildClassName(kit.muted, kit.small, styles.footnote)}>{lang('PvSysShareFootnote')}</p>
      </div>
    );
  }
};

export default memo(withGlobal<OwnProps>((global): Complete<StateProps> => ({
  chatsById: global.chats.byId,
  currentUserId: global.currentUserId,
}))(ShareSheet));
