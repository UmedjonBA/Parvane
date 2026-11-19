import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import styles from './NoteExtras.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  onOpen: NoneToVoidFunction;
};

// Полоса над заметкой, которую изменили на двух устройствах (доски `RpNotes`, `ZdNotesX`): «Разобрать» открывает
// экран расхождения
const NoteConflictBar = ({ onOpen }: OwnProps) => {
  const lang = useLang();

  return (
    <div className={styles.conflictBar} role="status" data-note-conflict>
      <span className={styles.conflictBarText}>
        <b className={styles.conflictLead}>{lang('KnowledgeConflictBanner')}</b>
        {` ${lang('KnowledgeConflictHint')}`}
      </span>
      <button type="button" className={buildClassName(kit.chip, kit.chipOn)} data-note-conflict-open onClick={onOpen}>
        {lang('KnowledgeConflictOpen')}
      </button>
    </div>
  );
};

export default memo(NoteConflictBar);
