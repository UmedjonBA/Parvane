import {
  memo, useEffect, useLayoutEffect, useMemo, useState,
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
import pv from './PlannerPv.module.scss';

type OwnProps = {
  day: string;
  // `field` — колонка дня компьютера (доска `RdPlan`): поле видно сразу, сохраняется по месту; `card` — телефон
  // (доска `PhonePlan`): карточка «Заметка дня» с первой строкой, нажатие раскрывает правку
  variant: 'field' | 'card';
};

// Текст заметки дня: `text` нет — заметки на этот день ещё нет
type Peek = { day: string; text?: string };

function selectCurrentUserId(global: GlobalState) {
  return global.currentUserId;
}

// Заметка дня в «Плане»: текст заметки выбранного дня. Хранилище «Заметок» ради неё не открывается: по дереву
// облака читается один файл. Запись — тем же путём, что в «Заметках», со сведением чужой версии; правка меняет
// дерево облака — текст перечитывается
const PlannerDailyNote = ({ day, variant }: OwnProps) => {
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
  const firstLine = useMemo(() => (
    known?.text === undefined ? undefined
      : previewLines({ title: dailyNoteTitle(day), text: known.text }, 1).lines[0]?.text
  ), [known, day]);
  const hasText = Boolean(firstLine);
  const isField = variant === 'field';

  const handleOpen = useLastCallback(() => {
    openNote(dailyNoteTitle(day));
  });

  // Правка: черновик от текста, который был на экране, — он же основа сведения с чужой версией
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
    setEdit((current) => (current?.day === day ? { ...current, draft: value } : {
      day, base: known?.text, draft: value,
    }));
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

  // Поле компьютера сохраняется, когда фокус уходит
  const handleBlur = useLastCallback(() => {
    void handleDone();
  });

  // Escape отменяет набранное. Общая очередь клавиш (`captureKeyboardListeners`) ловит Escape на документе в фазе
  // перехвата раньше поля, поэтому клавиша поля берётся ещё раньше — на `window`
  const handleWindowKey = useLastCallback((e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !(e.target instanceof HTMLTextAreaElement)
      || !e.target.matches('[data-today-note-editor]') || !e.target.closest('[data-today-note]')) {
      return;
    }
    e.stopPropagation();
    setEdit(undefined);
  });

  useLayoutEffect(() => {
    window.addEventListener('keydown', handleWindowKey, true);
    return () => window.removeEventListener('keydown', handleWindowKey, true);
  }, [handleWindowKey]);

  const handleEditorKey = useLastCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleDone();
    }
  });

  const noteState = hasText ? 'text' : known ? 'empty' : 'loading';
  const openButton = (
    <button
      type="button"
      className={buildClassName(styles.btn, styles.btnGhost)}
      data-today-note-open
      disabled={!known}
      onClick={handleOpen}
    >
      {lang('PlannerDailyNoteOpen')}
    </button>
  );

  if (isField) {
    return (
      <section className={styles.card} data-today-note={noteState}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{lang('PlannerDailyNote')}</h3>
          <span className={styles.grow} />
          {openButton}
        </div>
        <textarea
          className={styles.dailyEditor}
          data-today-note-editor
          value={editing ? editing.draft : known?.text || ''}
          aria-label={lang('PlannerDailyNote')}
          placeholder={lang('PlannerDailyNoteField')}
          disabled={!known && !editing}
          readOnly={isSaving}
          onChange={handleDraft}
          onBlur={handleBlur}
          onKeyDown={handleEditorKey}
        />
      </section>
    );
  }

  if (editing) {
    return (
      <section className={styles.card} data-today-note={noteState}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{lang('PlannerDailyNote')}</h3>
          <span className={styles.grow} />
          {openButton}
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
        </div>
        <textarea
          className={styles.dailyEditor}
          data-today-note-editor
          value={editing.draft}
          aria-label={lang('PlannerDailyNote')}
          placeholder={lang('PlannerDailyNoteField')}
          autoFocus
          onChange={handleDraft}
          onKeyDown={handleEditorKey}
        />
      </section>
    );
  }

  return (
    <button
      type="button"
      className={pv.noteCard}
      data-today-note={noteState}
      data-today-daily
      disabled={!known}
      onClick={handleEdit}
    >
      <Icon name="document" className={pv.noteCardIcon} />
      <span className={pv.noteCardText}>
        <span className={pv.noteCardTitle}>{lang('PlannerDailyNote')}</span>
        <span className={pv.noteCardSub} data-today-note-text={hasText || undefined}>
          {hasText ? firstLine : known ? lang('PlannerDailyNoteEmpty') : lang('PlannerDailyNoteHint')}
        </span>
      </span>
    </button>
  );
};

export default memo(PlannerDailyNote);
