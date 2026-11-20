import { memo, useState } from '../../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../../global';

import buildClassName from '../../../../util/buildClassName';
import { openNote } from '../../../../util/parvaneSection';
import { buildGuide, getGuideLang } from '../../../parvane/notes/notesGuide';
import { loadNotes, restoreGuide } from '../../../parvane/notes/notesStore';

import useHistoryBack from '../../../../hooks/useHistoryBack';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import ProfileIcon from '../profile/ProfileIcon';

import kit from '../../../parvane/notes/PvKit.module.scss';
import profile from '../profile/Profile.module.scss';
import styles from './Account.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

// Parvane (spec 041, доски `RpProfileA`, `PhProfileB`): «Справка Parvane» — обычные заметки папки «Справка Parvane»
// в «Заметках» (их создаёт и восстанавливает сам модуль, `notesGuide.ts`). Здесь — их список: нажатие открывает
// заметку в «Заметках», «Вернуть справку в исходный вид» дописывает недостающие заметки справки
const SettingsHelp = ({ isActive, onReset }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [isRestoring, setIsRestoring] = useState(false);

  useHistoryBack({ isActive, onBack: onReset });

  const guide = buildGuide(getGuideLang(lang.code));

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { title } = e.currentTarget.dataset;
    if (title) openNote(title);
  });

  const handleRestore = useLastCallback(async () => {
    if (isRestoring) return;
    setIsRestoring(true);
    // Хранилище «Заметок» могло ещё не открываться в этой вкладке: справке нужны его настройки
    await loadNotes(getGlobal().currentUserId, {
      guideLang: guide.lang,
      vaultName: lang('KnowledgeVaultName'),
      untitledName: lang('KnowledgeUntitled'),
      conflictWord: lang('KnowledgeConflictWord'),
    }).catch(() => undefined);
    const overviewId = await restoreGuide();
    setIsRestoring(false);
    showNotification({ message: lang(overviewId ? 'ParvaneHelpRestored' : 'ParvaneHelpRestoreFailed') });
  });

  return (
    <div className={buildClassName('settings-content custom-scroll', profile.screen)} data-settings-help>
      <div className={profile.hint}>{lang('ParvaneHelpHint', { folder: guide.folderName })}</div>
      <div className={profile.group}>
        {guide.notes.map((note, index) => (
          <button
            key={note.key}
            type="button"
            className={buildClassName(profile.setRow, profile.setRowAction)}
            data-help-note={note.key}
            data-title={note.title}
            onClick={handleOpen}
          >
            <span className={styles.helpNumber}>{index + 1}</span>
            <span className={profile.setTitle}>{note.title}</span>
            <ProfileIcon name="right" isSmall className={profile.menuChevron} />
          </button>
        ))}
      </div>
      <div className={styles.screen}>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnWide)}
          disabled={isRestoring}
          data-help-restore
          onClick={handleRestore}
        >
          {lang('ParvaneHelpRestore')}
        </button>
      </div>
    </div>
  );
};

export default memo(SettingsHelp);
