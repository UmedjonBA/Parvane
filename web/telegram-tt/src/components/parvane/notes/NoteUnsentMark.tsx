import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { getNotesUnsent } from './notesOutbox';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';

import styles from './NoteExtras.module.scss';

type OwnProps = {
  noteId: string;
  className?: string;
};

// Пометка у заметки, текст которой ещё не дошёл до облака (доска `PhStates`): «не отправлено · уйдёт при появлении
// связи». Какие заметки ждут — очередь текстов устройства (`notesOutbox.ts`)
const NoteUnsentMark = ({ noteId, className }: OwnProps) => {
  const lang = useLang();
  const isUnsent = useDerivedState(getNotesUnsent).has(noteId);

  if (!isUnsent) return undefined;

  return <span className={buildClassName(styles.unsent, className)} data-unsent>{lang('ParvaneUnsentMark')}</span>;
};

export default memo(NoteUnsentMark);
