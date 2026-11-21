import type { TeactNode } from '../../../lib/teact/teact';
import {
  memo, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { FolderSubmitError, NoteFolder } from './notesFolders';

import buildClassName from '../../../util/buildClassName';
import { FOLDER_ERROR_KEYS, FOLDER_NAME_MAX, folderCaption } from './notesFolders';
import { folderColor } from './notesLook';
import { FOLDER_TONES } from './notesMeta';
import {
  changeNotesMeta, getNoteFolders, getNotesMeta, nestNoteFolder,
} from './notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './NoteExtras.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  folder: NoteFolder;
  // Переименовать папку; возвращает причину отказа
  onRename: (name: string) => Promise<FolderSubmitError | undefined>;
  onDelete?: NoneToVoidFunction;
  onDone: NoneToVoidFunction;
};

type Section = 'rename' | 'tone' | 'nest';

const TONE_OF_COLOR = /--pv-([a-z]+)/;
const TONE_KEYS = {
  blue: 'KnowledgeToneBlue',
  green: 'KnowledgeToneGreen',
  orange: 'KnowledgeToneOrange',
  purple: 'KnowledgeTonePurple',
  aqua: 'KnowledgeToneAqua',
  red: 'KnowledgeToneRed',
} as const;

// Действия с папкой строками (доска `ZpNotesX`): «Переименовать» раскрывает поле, «Цвет папки» — со значением
// словом, кружки цветов — в раскрытии (цвет есть у верхних папок, вложенные берут цвет верхней), «Вложить в
// другую папку» — список папок, «Удалить папку» — вопрос
const NoteFolderActions = ({
  folder, onRename, onDelete, onDone,
}: OwnProps) => {
  const inputRef = useRef<HTMLInputElement>();
  const lang = useLang();
  const meta = useDerivedState(getNotesMeta);
  const folders = useDerivedState(getNoteFolders);
  const [section, setSection] = useState<Section>();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const [error, setError] = useState<FolderSubmitError>();
  const isTop = !folder.path.includes('/');
  // Цвет папки без выбора (`notesLook.folderColor`: свои — синий, справка — бирюзовый); выбрать его — снять выбор
  const defaultTone = FOLDER_TONES.find((item) => item === TONE_OF_COLOR.exec(folderColor(folder.path))?.[1])
    || FOLDER_TONES[0];
  const tone = meta.tones[folder.id] || defaultTone;
  // Куда можно вложить: не в саму себя и не в свои подпапки
  const targets = folders.filter(({ path }) => path !== folder.path && !path.startsWith(`${folder.path}/`));

  // Другая папка — разделы свёрнуты
  useLayoutEffect(() => {
    setSection(undefined);
    setError(undefined);
  }, [folder.id]);

  // Поле названия ставится и получает фокус в кадре раскрытия: набранное сразу после нажатия не теряется
  useLayoutEffect(() => {
    if (section !== 'rename' || !inputRef.current) return;
    inputRef.current.value = folder.name;
    inputRef.current.focus();
    inputRef.current.select();
  }, [section, folder.name]);

  const toggleSection = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const next = e.currentTarget.dataset.section as Section;
    setError(undefined);
    setSection((current) => (current === next ? undefined : next));
  });

  const handleRename = useLastCallback(async () => {
    const value = (inputRef.current?.value || '').trim();
    if (isBusy) return;
    if (!value) {
      setError('bad-name');
      return;
    }
    markBusy();
    const failure = await onRename(value);
    unmarkBusy();
    setError(failure);
    if (!failure) onDone();
  });

  const handleKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void handleRename();
  });

  const handleTone = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const next = FOLDER_TONES.find((item) => item === e.currentTarget.dataset.tone);
    void changeNotesMeta({
      kind: 'tone', folder: folder.id, tone: next === defaultTone && !meta.tones[folder.id] ? undefined : next,
    });
  });

  const handleNest = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isBusy) return;
    markBusy();
    const failure = await nestNoteFolder(folder.id, e.currentTarget.dataset.folderId || undefined);
    unmarkBusy();
    setError(failure);
    if (!failure) onDone();
  });

  function renderRow(name: Section, lead: TeactNode, title: string, value?: string) {
    return (
      <button
        type="button"
        className={buildClassName(kit.row, section === name && kit.rowSel)}
        aria-expanded={section === name}
        data-section={name}
        data-folder-rename={name === 'rename' ? '' : undefined}
        data-folder-color={name === 'tone' ? tone : undefined}
        data-folder-nest={name === 'nest' ? '' : undefined}
        onClick={toggleSection}
      >
        {lead}
        <span className={buildClassName(kit.rowText, kit.ttl)}>{title}</span>
        {value && <span className={styles.folderValue} data-folder-color-value>{value}</span>}
      </button>
    );
  }

  return (
    <div className={styles.folderActions} data-folder-actions>
      {renderRow('rename', <PvIcon name="edit" isSmall />, lang('KnowledgeFolderRename'))}
      {section === 'rename' && (
        <div className={styles.folderOpen}>
          <input
            ref={inputRef}
            id="knowledge-folder-name"
            className={kit.input}
            maxLength={FOLDER_NAME_MAX}
            placeholder={lang('KnowledgeFolderName')}
            aria-label={lang('KnowledgeFolderName')}
            autoComplete="off"
            onKeyDown={handleKey}
          />
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            disabled={isBusy}
            data-folder-submit
            onClick={handleRename}
          >
            {lang('KnowledgeFolderRename')}
          </button>
        </div>
      )}
      {isTop && renderRow(
        'tone',
        <span className={styles.toneDot} style={`--c: var(--pv-${tone})`} aria-hidden="true" />,
        lang('KnowledgeFolderColor'),
        lang(TONE_KEYS[tone]),
      )}
      {section === 'tone' && (
        <div className={buildClassName(styles.toneRow, styles.folderOpen)}>
          {FOLDER_TONES.map((item) => (
            <button
              key={item}
              type="button"
              className={buildClassName(styles.tone, item === tone && styles.toneOn)}
              style={`--c: var(--pv-${item})`}
              aria-label={lang(TONE_KEYS[item])}
              title={lang(TONE_KEYS[item])}
              aria-pressed={item === tone}
              data-tone={item}
              onClick={handleTone}
            />
          ))}
        </div>
      )}
      {renderRow('nest', <PvIcon name="move" isSmall />, lang('KnowledgeFolderNest'))}
      {section === 'nest' && (
        <div className={styles.folderList} data-folder-nest-list>
          {folder.path.includes('/') && (
            <button type="button" className={kit.row} disabled={isBusy} data-folder-nest-target="" onClick={handleNest}>
              <span className={buildClassName(kit.rowText, kit.ttl)}>{lang('KnowledgeFolderNestTop')}</span>
            </button>
          )}
          {targets.map((target) => (
            <button
              key={target.id}
              type="button"
              className={kit.row}
              disabled={isBusy}
              data-folder-id={target.id}
              data-folder-nest-target={target.path}
              onClick={handleNest}
            >
              <span className={buildClassName(kit.rowText, kit.ttl)}>{folderCaption(target.path)}</span>
            </button>
          ))}
        </div>
      )}
      {onDelete && (
        <button
          type="button"
          className={buildClassName(kit.row, kit.rowRed)}
          disabled={isBusy}
          data-folder-delete
          onClick={onDelete}
        >
          <PvIcon name="trash" isSmall />
          <span className={buildClassName(kit.rowText, kit.ttl)}>{lang('KnowledgeFolderDelete')}</span>
        </button>
      )}
      {error && (
        <p className={kit.fieldError} role="alert" data-folder-error={error}>{lang(FOLDER_ERROR_KEYS[error])}</p>
      )}
    </div>
  );
};

export default memo(NoteFolderActions);
