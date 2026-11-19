import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { NoteEntry } from '../notes/notesStore';
import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { folderCaption } from '../notes/notesFolders';
import { previewOf } from '../notes/notesLook';
import { noteSearchText } from '../notes/notesModel';
import {
  getNotes, getNotesStatus, loadNotes, retainNotes, saveNote,
} from '../notes/notesStore';
import { appendEmbed, embedTargetOf } from './cloudNoteAttach';
import { copyCloudNode, getCloudData, getNodes } from './cloudStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useModuleGate from '../../../hooks/useModuleGate';

import PvEmpty from '../notes/PvEmpty';
import PvIcon from '../notes/PvIcon';
import PvLoading from '../notes/PvLoading';
import PvModuleOff from '../notes/PvModuleOff';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './CloudSheets.module.scss';

type OwnProps = {
  // Файл, который вкладывают; `undefined` — окно закрыто
  entry?: { container: string; node: CloudNode };
  onClose: NoneToVoidFunction;
};

// «Вложить в заметку…» (доска `ZdFilesX`): выбор заметки — поиск и список, как у «Статьи» в чате; файл встаёт в
// конец выбранной заметки вложением. «Заметки» выключены на устройстве — сначала лист «Модуль выключен»
const CloudNoteDialog = ({ entry, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const gate = useModuleGate('notes');
  const [isPicking, setIsPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string>();
  const notes = useDerivedState(getNotes);
  const status = useDerivedState(getNotesStatus);

  const openPicker = useLastCallback(() => setIsPicking(true));

  useEffect(() => {
    if (!entry) {
      setIsPicking(false);
      setQuery('');
      return;
    }
    gate.run(openPicker);
    // Окно открывается заново только для другого файла
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps
  }, [entry]);

  // Пока выбор открыт, заметки следят за облаком
  useEffect(() => {
    if (!isPicking) return undefined;
    const release = retainNotes();
    void loadNotes(getGlobal().currentUserId);
    return release;
  }, [isPicking]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!words.length) return sorted;
    const titleOf = (note: NoteEntry) => note.title.toLowerCase().replace(/ё/g, 'е');
    const found = sorted.filter((note) => {
      const text = `${titleOf(note)} ${noteSearchText(note)}`;
      return words.every((word) => text.includes(word));
    });
    // Совпавшие названием — выше совпавших только текстом
    const byTitle = found.filter((note) => words.every((word) => titleOf(note).includes(word)));
    return [...byTitle, ...found.filter((note) => !byTitle.includes(note))];
  }, [notes, query]);

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handleDismiss = useLastCallback(() => {
    gate.dismiss();
    onClose();
  });

  const handlePick = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const note = notes.find(({ id }) => id === e.currentTarget.dataset.noteId);
    if (!entry || !note || busyId) return;
    setBusyId(note.id);
    const target = await attachTarget(entry, note);
    const isDone = target !== undefined
      && await saveNote(note.id, appendEmbed(note.text, target), lang('KnowledgeVaultName'), note.text);
    setBusyId(undefined);
    showNotification({
      message: lang(isDone ? 'ParvaneCloudAttachedToNote' : 'ParvaneCloudAttachFailed', { name: note.title }),
    });
    if (isDone) onClose();
  });

  const isLoading = status === 'loading' && !notes.length;

  return (
    <>
      <PvSheet
        isOpen={Boolean(entry) && isPicking}
        title={lang('ParvaneCloudAttachToNote')}
        isTight
        onClose={onClose}
      >
        <input
          className={buildClassName(kit.input, styles.noteSearch)}
          type="search"
          value={query}
          placeholder={lang('ArticleSearch')}
          aria-label={lang('ArticleSearch')}
          data-cloud-note-search
          onChange={handleQuery}
        />
        <div className={styles.menuList} data-cloud-note-list>
          {isLoading && <PvLoading />}
          {!isLoading && !notes.length && <PvEmpty text={lang('ArticleNoNotes')} />}
          {!isLoading && Boolean(notes.length) && !shown.length && <PvEmpty text={lang('KnowledgeNothingFound')} />}
          {shown.map((note) => (
            <button
              key={note.id}
              type="button"
              className={kit.row}
              disabled={Boolean(busyId)}
              data-note-id={note.id}
              data-cloud-note={note.title}
              onClick={handlePick}
            >
              <span className={buildClassName(kit.ava, kit.avaM)}>
                <PvIcon name="note" isSmall />
              </span>
              <span className={kit.rowText}>
                <span className={kit.ttl}>{note.title}</span>
                <span className={kit.sub}>
                  {[note.folder ? folderCaption(note.folder) : '', previewOf(note)].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
          ))}
        </div>
      </PvSheet>
      <PvModuleOff
        isOpen={gate.isAsked}
        module="notes"
        hint={lang('ParvaneCloudAttachToNote')}
        onEnable={gate.enable}
        onClose={handleDismiss}
      />
    </>
  );
};

/** Что вписать в `![[…]]`: файл личного диска — как есть, файл общей папки — копией рядом с заметкой. */
async function attachTarget(entry: { container: string; node: CloudNode }, note: NoteEntry) {
  const data = getCloudData();
  const driveId = data?.rootId;
  if (!driveId) return undefined;
  if (entry.container === driveId) return embedTargetOf(getNodes(driveId, data), entry.node, note.id);
  const parent = getNodes(driveId, data).find(({ id }) => id === note.id)?.parent || undefined;
  return copyCloudNode(entry.container, entry.node, { container: driveId, parent });
}

export default memo(CloudNoteDialog);
