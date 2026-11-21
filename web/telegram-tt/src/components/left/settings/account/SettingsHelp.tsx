import { memo, useLayoutEffect, useMemo, useState } from '../../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../../global';

import buildClassName from '../../../../util/buildClassName';
import { openNote } from '../../../../util/parvaneSection';
import { buildGuide, getGuideLang } from '../../../parvane/notes/notesGuide';
import { loadNotes, restoreGuide } from '../../../parvane/notes/notesStore';
import { getIsHelpSearchOpen, setIsHelpSearchOpen } from '../profile/profileRequests';
import { searchHelp } from './helpSearch';

import useDerivedState from '../../../../hooks/useDerivedState';
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
// заметку в «Заметках», «Вернуть справку в исходный вид» дописывает недостающие заметки справки. Поиск открывает
// значок в шапке (`SettingsHeader`, сигнал `profileRequests.ts`)
const SettingsHelp = ({ isActive, onReset }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [isRestoring, setIsRestoring] = useState(false);
  const [query, setQuery] = useState('');
  const isSearchOpen = useDerivedState(getIsHelpSearchOpen);

  useHistoryBack({ isActive, onBack: onReset });

  // Уход с экрана закрывает поиск и забывает запрос
  useLayoutEffect(() => {
    if (isActive) return;
    setIsHelpSearchOpen(false);
    setQuery('');
  }, [isActive]);

  const guide = useMemo(() => buildGuide(getGuideLang(lang.code)), [lang.code]);
  const matches = useMemo(() => searchHelp(guide.notes, query), [guide, query]);
  const numberOf = (key: string) => guide.notes.findIndex((note) => note.key === key) + 1;

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

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
      {isSearchOpen && (
        <div className={styles.screen}>
          <input
            type="search"
            className={kit.input}
            value={query}
            placeholder={lang('ParvaneHelpSearch')}
            aria-label={lang('ParvaneHelpSearch')}
            autoFocus
            data-help-search
            onChange={handleQuery}
          />
        </div>
      )}
      <div className={profile.hint}>
        {lang('ParvaneHelpHintCount', { count: guide.notes.length, folder: guide.folderName }, {
          pluralValue: guide.notes.length,
        })}
      </div>
      {!matches.length && <div className={profile.hint} data-help-nothing>{lang('ParvaneHelpNothing')}</div>}
      {Boolean(matches.length) && (
        <div className={profile.group}>
          {matches.map(({ note, snippet }) => (
            <button
              key={note.key}
              type="button"
              className={buildClassName(profile.setRow, profile.setRowAction)}
              data-help-note={note.key}
              data-title={note.title}
              onClick={handleOpen}
            >
              <span className={styles.helpNumber}>{numberOf(note.key)}</span>
              <span className={profile.setText}>
                <span className={profile.setTitle}>{note.title}</span>
                {snippet && <span className={profile.setHint} data-help-snippet>{snippet}</span>}
              </span>
              <ProfileIcon name="right" isSmall className={profile.menuChevron} />
            </button>
          ))}
        </div>
      )}
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
