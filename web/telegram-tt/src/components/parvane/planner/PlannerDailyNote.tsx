import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { GlobalState } from '../../../global/types';

import buildClassName from '../../../util/buildClassName';
import { openNote } from '../../../util/parvaneSection';
import { getCloudData, loadCloud } from '../cloud/cloudStore';
import { previewLines } from '../notes/notesLook';
import { dailyNoteTemplate, dailyNoteTitle } from '../notes/notesModel';
import {
  loadNotes, openDailyNote, readDailyNote, saveNote,
} from '../notes/notesStore';

import useSelector from '../../../hooks/data/useSelector';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';

import styles from './Planner.module.scss';

type OwnProps = {
  day: string;
};

// Текст заметки дня: `text` нет — заметки на этот день ещё нет
type Peek = { day: string; text?: string };

// Столько строк начала заметки видно на карточке
const PREVIEW_LINES = 6;

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Карточка «Заметка дня» на «Сегодня»: начало текста заметки выбранного дня. Хранилище «Знаний» ради неё
// не открывается: по дереву облака читается один файл, экран его не ждёт. Нажатие на текст открывает
// заметку в «Знаниях»; «Изменить» — правка прямо здесь, как в прототипе (тогда хранилище читается: запись
// идёт тем же путём, что в «Знаниях», со сведением чужой версии). Правка меняет дерево облака — текст
// перечитывается
const PlannerDailyNote = ({ day }: OwnProps) => {
  const cloudData = useDerivedState(getCloudData);
  const currentUserId = useSelector(selectCurrentUserId);
  const [peek, setPeek] = useState<Peek>();

  const lang = useLang();

  useEffect(() => {
    void loadCloud(currentUserId);
  }, [currentUserId]);

  useEffect(() => {
    let isActual = true;
    void readDailyNote(day, cloudData).then((result) => {
      if (isActual && result) setPeek({ day, text: result.text });
    });
    return () => {
      isActual = false;
    };
  }, [day, cloudData]);

  // Текст другого дня (до ответа облака) не показывается
  const known = peek?.day === day ? peek : undefined;
  const preview = useMemo(() => (
    known?.text === undefined ? undefined
      : previewLines({ title: dailyNoteTitle(day), text: known.text }, PREVIEW_LINES)
  ), [known, day]);
  const lines = preview?.lines || [];
  const hasText = lines.length > 0;

  const handleOpen = useLastCallback(() => {
    openNote(dailyNoteTitle(day));
  });

  // Правка на месте: черновик от текста, который был на экране, — он же основа сведения с чужой версией
  const [edit, setEdit] = useState<{ day: string; base?: string; draft: string }>();
  const [isSaving, setIsSaving] = useState(false);
  const editing = edit?.day === day ? edit : undefined;

  const handleEdit = useLastCallback(() => {
    if (!known) return;
    void loadNotes(currentUserId);
    setEdit({ day, base: known.text, draft: known.text ?? dailyNoteTemplate(day) });
  });

  const handleDraft = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { value } = e.currentTarget;
    setEdit((current) => (current ? { ...current, draft: value } : current));
  });

  const handleDone = useLastCallback(async () => {
    if (!editing || isSaving) return;
    const isUntouched = editing.base === undefined
      ? editing.draft === dailyNoteTemplate(day) || !editing.draft.trim()
      : editing.draft === editing.base;
    if (isUntouched) {
      setEdit(undefined);
      return;
    }
    setIsSaving(true);
    try {
      await loadNotes(currentUserId);
      const vaultName = lang('KnowledgeVaultName');
      const id = await openDailyNote(day, vaultName, lang('KnowledgeDailyFolder'));
      const isSaved = Boolean(id) && await saveNote(id, editing.draft, vaultName, editing.base);
      if (isSaved) {
        setPeek({ day, text: editing.draft });
        setEdit(undefined);
      }
    } finally {
      setIsSaving(false);
    }
  });

  const handleEditorKey = useLastCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setEdit(undefined);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleDone();
    }
  });

  return (
    <section className={styles.card} data-today-note={hasText ? 'text' : known ? 'empty' : 'loading'}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{lang('PlannerDailyNote')}</h3>
        <span className={styles.grow} />
        {editing ? (
          <button
            type="button"
            className={buildClassName(styles.btn, styles.btnGhost)}
            data-today-daily-done
            disabled={isSaving}
            onClick={handleDone}
          >
            <Icon name="check" />
            {lang('Done')}
          </button>
        ) : (
          <button
            type="button"
            className={buildClassName(styles.btn, styles.btnGhost)}
            data-today-daily
            disabled={!known}
            onClick={handleEdit}
          >
            <Icon name="edit" />
            {lang('Edit')}
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          className={styles.dailyEditor}
          data-today-note-editor
          value={editing.draft}
          aria-label={lang('PlannerDailyNote')}
          placeholder={lang('PlannerDailyNotePlaceholder')}
          autoFocus
          onChange={handleDraft}
          onKeyDown={handleEditorKey}
        />
      ) : hasText ? (
        <button type="button" className={styles.dailyText} data-today-note-text onClick={handleOpen}>
          {lines.map((line, i) => (
            <span
              key={`${i}:${line.text}`}
              className={buildClassName(
                styles.dailyLine,
                line.mark === 'heading' && styles.dailyHeading,
                line.mark === 'done' && styles.dailyDone,
              )}
            >
              {line.mark && line.mark !== 'heading' && (
                <span className={styles.dailyMark} data-mark={line.mark} aria-hidden />
              )}
              <span className={styles.dailyLineText}>{line.text}</span>
            </span>
          ))}
          {preview?.hasMore && <span className={styles.dailyMore} aria-hidden>…</span>}
        </button>
      ) : known ? (
        <button type="button" className={styles.dailyEmpty} data-today-note-empty onClick={handleOpen}>
          {lang('PlannerDailyNoteWrite')}
        </button>
      ) : (
        <p className={styles.muted}>{lang('PlannerDailyNoteHint')}</p>
      )}
    </section>
  );
};

export default memo(PlannerDailyNote);
