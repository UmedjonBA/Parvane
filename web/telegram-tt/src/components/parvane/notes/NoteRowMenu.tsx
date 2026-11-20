import { memo, useState } from '../../../lib/teact/teact';

import type { NoteMenuItem } from './NoteMenu';
import type { NoteEntry } from './notesStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import NoteCanvasSheet from './NoteCanvasSheet';
import NoteMenu from './NoteMenu';

type OwnProps = {
  // Заметка, по строке которой нажата правая кнопка; нет — меню закрыто
  note?: NoteEntry;
  onOpen: (noteId: string) => void;
  onOpenCanvas: (canvasId: string) => void;
  onClose: NoneToVoidFunction;
};

// Меню строки списка заметок на компьютере (доска `ZdNotesX`): «Открыть» и «Добавить на холст…». Список и холст на
// компьютере рядом не стоят — заметку на холст кладут отсюда, а не перетаскиванием
const NoteRowMenu = ({
  note, onOpen, onOpenCanvas, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [canvasNote, setCanvasNote] = useState<NoteEntry>();

  const items: NoteMenuItem[] = [
    { action: 'open', label: lang('Open'), icon: 'open' },
    { action: 'canvas', label: lang('KnowledgeAddToCanvas'), icon: 'board' },
  ];

  const handlePick = useLastCallback((action: string) => {
    if (!note) return;
    if (action === 'open') onOpen(note.id);
    else setCanvasNote(note);
  });

  const handleCloseCanvas = useLastCallback(() => {
    setCanvasNote(undefined);
  });

  return (
    <>
      <NoteMenu
        isOpen={Boolean(note)}
        title={note?.title || ''}
        items={items}
        isSheet
        onPick={handlePick}
        onClose={onClose}
      />
      <NoteCanvasSheet note={canvasNote} onOpenCanvas={onOpenCanvas} onClose={handleCloseCanvas} />
    </>
  );
};

export default memo(NoteRowMenu);
