import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { NoteEntry } from '../../parvane/notes/notesStore';

import {
  appendMessageToNote, closeMessageNoteRequest, getMessageNoteRequest, saveMessageToNote,
} from './helpers/messageModules';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import NotePickerModal from '../../parvane/article/NotePickerModal';

// «В заметку» из меню сообщения (доска `ZpChat`): новая заметка либо дописать в существующую
const MessageNoteDialog = () => {
  const { showNotification } = getActions();
  const lang = useLang();
  const text = useDerivedState(getMessageNoteRequest);

  const handleNew = useLastCallback(async () => {
    const title = await saveMessageToNote(text!, lang);
    closeMessageNoteRequest();
    showNotification({ message: title ? lang('ArticleSaved', { title }) : lang('MessageNoteFailed') });
  });

  const handlePick = useLastCallback(async (note: NoteEntry) => {
    const isSaved = await appendMessageToNote(note, text!, lang);
    closeMessageNoteRequest();
    showNotification({ message: isSaved ? lang('ArticleSaved', { title: note.title }) : lang('MessageNoteFailed') });
  });

  return (
    <NotePickerModal
      isOpen={Boolean(text)}
      title={lang('MessageNotePickTitle')}
      newLabel={lang('MessageNoteNew')}
      onNew={handleNew}
      onPick={handlePick}
      onClose={closeMessageNoteRequest}
    />
  );
};

export default memo(MessageNoteDialog);
