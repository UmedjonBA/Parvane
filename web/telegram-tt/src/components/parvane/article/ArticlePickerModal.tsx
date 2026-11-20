import { memo } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { NoteEntry } from '../notes/notesStore';

import { ARTICLE_ERROR_KEYS, sendNoteArticle } from './articleSend';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import NotePickerModal from './NotePickerModal';

type OwnProps = {
  isOpen: boolean;
  chatId: string;
  onClose: NoneToVoidFunction;
};

// «Статья» в меню вложений (ARTICLE-1): заметка «Знаний» уходит в чат целиком и открывается окном чтения
const ArticlePickerModal = ({ isOpen, chatId, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const handlePick = useLastCallback(async (note: NoteEntry) => {
    const chat = getGlobal().chats.byId[chatId];
    if (!chat) return;
    const result = await sendNoteArticle(chat, note);
    if (result === 'sent') {
      onClose();
      return;
    }
    showNotification({ message: lang(ARTICLE_ERROR_KEYS[result]) });
  });

  return (
    <NotePickerModal
      isOpen={isOpen}
      title={lang('ArticlePickTitle')}
      hint={lang('ArticlePickHint')}
      onPick={handlePick}
      onClose={onClose}
    />
  );
};

export default memo(ArticlePickerModal);
