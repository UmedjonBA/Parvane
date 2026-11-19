import { memo } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { NoteEntry } from './notesStore';

import { ARTICLE_ERROR_KEYS, sendNoteArticle } from '../article/articleSend';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';

type OwnProps = {
  note?: NoteEntry;
  onClose: NoneToVoidFunction;
};

// «Отправить статьёй в чат» из меню заметки (доски `XpNotes`, `ZdNotesX`): выбор чата, заметка уходит статьёй —
// тот же путь, что «Статья» в меню вложений чата (ARTICLE-1)
const NoteArticleDialog = ({ note, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const handleSelect = useLastCallback(async (chatId: string) => {
    const chat = getGlobal().chats.byId[chatId];
    onClose();
    if (!note || !chat) return;
    const result = await sendNoteArticle(chat, note);
    showNotification({ message: lang(result === 'sent' ? 'KnowledgeArticleSent' : ARTICLE_ERROR_KEYS[result]) });
  });

  return (
    <RecipientPicker
      isOpen={Boolean(note)}
      title={lang('KnowledgeSendArticle')}
      searchPlaceholder={lang('Search')}
      onSelectRecipient={handleSelect}
      onClose={onClose}
    />
  );
};

export default memo(NoteArticleDialog);
