import type { TeactNode } from '../../../lib/teact/teact';
import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { PlannerState } from '../planner/plannerModel';
import type { NotesIndex } from './notesModel';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { formatDay, formatRepeat } from '../planner/plannerFormat';
import { parseNote, setTaskDone } from './notesModel';
import { getNoteTasks } from './notesTasks';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import ConfirmDialog from '../../ui/ConfirmDialog';

import styles from './Knowledge.module.scss';

type OwnProps = {
  note: NoteEntry;
  index: NotesIndex;
  planner: PlannerState;
  onBack?: NoneToVoidFunction;
  onOpenTitle: (title: string) => void;
  onSave: (noteId: string, text: string) => Promise<boolean>;
  onRename: (noteId: string, title: string) => void;
  onDelete: (noteId: string) => void;
};

type PlannedItem = { key: string; name: string; when: string; sort: string };

const TITLE_MAX_LENGTH = 120;
const INLINE = /(\[\[[^\]\n]+\]\]|`[^`\n]+`|\*\*[^*\n]+\*\*|(?:^|\s)#[\p{L}\d_/-]+)/gu;
const TASK_LINE = /^(\s*)[-*+] \[( |x|X)\](?: (.*))?$/;
const LIST_LINE = /^(\s*)[-*+] (.*)$/;
const HEADING = /^(#{1,3}) (.*)$/;
const MARKER = / \^t[a-z0-9]{4,12}\s*$/;
const FENCE = '```';

// Заметка: чтение с живыми ссылками, тегами и галочками; правка — текстом `.md`.
// Ниже — «Запланировано» (записи «Плана» со ссылкой сюда) и обратные ссылки
const NoteView = ({
  note, index, planner, onBack, onOpenTitle, onSave, onRename, onDelete,
}: OwnProps) => {
  const [draft, setDraft] = useState<string>();
  const [title, setTitle] = useState(note.title);
  const [isSaving, markSaving, unmarkSaving] = useFlag();
  const [isDeleteOpen, openDelete, closeDelete] = useFlag();

  const lang = useLang();

  useEffect(() => {
    setDraft(undefined);
    setTitle(note.title);
  }, [note.id, note.title]);

  const isEditing = draft !== undefined;
  const parsed = useMemo(() => parseNote(note.text), [note.text]);
  const backlinks = useMemo(() => index.backlinks(note.id), [index, note.id]);

  const planned = useMemo(() => {
    const link = `[[${note.title.toLowerCase()}`;
    const items: PlannedItem[] = [];
    const linked = (name: string) => name.toLowerCase().includes(link);
    const fromNote = new Set(getNoteTasks(planner, note.id).map(({ id }) => id));
    planner.tasks.forEach((task) => {
      if (!fromNote.has(task.id) && !linked(task.name)) return;
      const day = task.day || task.due;
      items.push({
        key: `t${task.id}`,
        name: task.name,
        when: task.repeat ? formatRepeat(lang, task.repeat)
          : day ? `${formatDay(lang, day)}${task.start ? `, ${task.start}` : ''}` : lang('KnowledgeNoDate'),
        sort: task.repeat?.startDay || day || '9999',
      });
    });
    planner.events.forEach((event) => {
      if (!linked(event.name)) return;
      items.push({
        key: `e${event.id}`,
        name: event.name,
        when: event.repeat ? `${formatRepeat(lang, event.repeat)}, ${event.start}`
          : `${event.day ? formatDay(lang, event.day) : ''}${event.isAllDay ? '' : `, ${event.start}`}`,
        sort: event.repeat?.startDay || event.day || '9999',
      });
    });
    return items.sort((a, b) => (a.sort < b.sort ? -1 : 1));
  }, [planner, note.id, note.title, lang]);

  const handleEdit = useLastCallback(() => {
    setDraft(note.text);
  });

  const handleCancel = useLastCallback(() => {
    setDraft(undefined);
  });

  const handleDraft = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.currentTarget.value);
  });

  const handleSave = useLastCallback(async () => {
    if (draft === undefined) return;
    markSaving();
    const isSaved = await onSave(note.id, draft);
    unmarkSaving();
    if (isSaved) setDraft(undefined);
  });

  const handleTitle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.currentTarget.value);
  });

  // Значение берётся из самого поля: уход фокуса может прийти раньше перерисовки с набранным текстом
  const handleTitleBlur = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const next = e.currentTarget.value.trim();
    if (next && next !== note.title) onRename(note.id, next);
    else setTitle(note.title);
  });

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const line = Number(e.currentTarget.dataset.line);
    void onSave(note.id, setTaskDone(note.text, line, e.currentTarget.checked));
  });

  const handleLink = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpenTitle(e.currentTarget.dataset.title!);
  });

  const handleDelete = useLastCallback(() => {
    closeDelete();
    onDelete(note.id);
  });

  const renderInline = (text: string) => text.split(INLINE).map((part, i) => {
    const key = `${i}${part}`;
    if (part.startsWith('[[')) {
      const [target, alias] = part.slice(2, -2).split('|');
      const isMissing = !index.byTitle(target);
      return (
        <button
          key={key}
          type="button"
          className={buildClassName(styles.link, isMissing && styles.linkMissing)}
          data-title={target.trim()}
          title={isMissing ? lang('KnowledgeMissingNote') : undefined}
          onClick={handleLink}
        >
          {(alias || target).trim()}
        </button>
      );
    }
    if (part.startsWith('`')) return <code key={key} className={styles.code}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (/^\s?#[\p{L}\d_/-]+$/u.test(part)) return <span key={key} className={styles.tag}>{part}</span>;
    return part;
  });

  // Построчно: заголовки, пункты с галочками, списки, код; пустая строка — отступ
  const renderBody = () => {
    const lines = note.text.split('\n');
    const bodyStart = lines.length - parsed.body.split('\n').length;
    const out: TeactNode[] = [];
    let isCode = false;
    lines.forEach((line, i) => {
      if (i < bodyStart) return;
      if (line.trim().startsWith(FENCE)) {
        isCode = !isCode;
        return;
      }
      if (isCode) {
        out.push(<pre key={i} className={styles.pre}>{line}</pre>);
        return;
      }
      const task = TASK_LINE.exec(line);
      if (task) {
        out.push(
          <label key={i} className={styles.taskLine} style={`padding-inline-start: ${task[1].length * 0.5}rem`}>
            <input
              type="checkbox"
              className={styles.taskCheck}
              checked={task[2] !== ' '}
              data-line={i}
              onChange={handleToggle}
            />
            <span className={task[2] !== ' ' ? styles.taskDone : undefined}>
              {renderInline((task[3] || '').replace(MARKER, ''))}
            </span>
          </label>,
        );
        return;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        out.push(
          <div key={i} className={buildClassName(styles.heading, styles[`heading${heading[1].length}`])}>
            {renderInline(heading[2])}
          </div>,
        );
        return;
      }
      const item = LIST_LINE.exec(line);
      if (item) {
        out.push(
          <div key={i} className={styles.listLine} style={`padding-inline-start: ${item[1].length * 0.5 + 1}rem`}>
            {renderInline(item[2])}
          </div>,
        );
        return;
      }
      out.push(line.trim()
        ? <p key={i} className={styles.paragraph}>{renderInline(line)}</p>
        : <div key={i} className={styles.gap} />);
    });
    return out;
  };

  const properties = Object.entries(parsed.properties);

  return (
    <article className={styles.note} data-note-id={note.id} data-note-title={note.title}>
      <div className={styles.noteHead}>
        {onBack && (
          <Button
            round
            size="smaller"
            color="translucent"
            iconName="arrow-left"
            ariaLabel={lang('KnowledgeBack')}
            onClick={onBack}
          />
        )}
        <input
          className={styles.noteTitle}
          value={title}
          maxLength={TITLE_MAX_LENGTH}
          aria-label={lang('KnowledgeNoteTitle')}
          onChange={handleTitle}
          onBlur={handleTitleBlur}
        />
        {isEditing ? (
          <>
            <Button size="smaller" isText onClick={handleCancel}>{lang('KnowledgeCancel')}</Button>
            <Button size="smaller" disabled={isSaving} onClick={handleSave}>{lang('KnowledgeSave')}</Button>
          </>
        ) : (
          <>
            <Button size="smaller" color="translucent" onClick={handleEdit}>{lang('KnowledgeEdit')}</Button>
            <Button
              round
              size="smaller"
              color="translucent"
              iconName="delete"
              ariaLabel={lang('KnowledgeDelete')}
              onClick={openDelete}
            />
          </>
        )}
      </div>
      {Boolean(note.folder || properties.length) && (
        <div className={styles.chips}>
          {note.folder && <span className={styles.chip}>{note.folder}</span>}
          {properties.map(([key, value]) => (
            <span
              key={key}
              className={styles.chip}
            >
              {`${key}: ${Array.isArray(value) ? value.join(', ') : value}`}
            </span>
          ))}
        </div>
      )}
      {isEditing ? (
        <textarea
          id="knowledge-note-editor"
          className={buildClassName('form-control', styles.editor)}
          value={draft}
          placeholder={lang('KnowledgeEditorPlaceholder')}
          aria-label={note.title}
          onChange={handleDraft}
        />
      ) : (
        <div className={styles.body} data-note-body>{renderBody()}</div>
      )}
      <section className={styles.block} data-note-planned>
        <h3 className={styles.blockTitle}>{lang('KnowledgePlanned')}</h3>
        {!planned.length && <p className={styles.muted}>{lang('KnowledgePlannedEmpty')}</p>}
        {planned.map((item) => (
          <div key={item.key} className={styles.blockRow}>
            <span className={styles.blockWhen}>{item.when}</span>
            <span>{item.name}</span>
          </div>
        ))}
      </section>
      <section className={styles.block} data-note-backlinks>
        <h3 className={styles.blockTitle}>{lang('KnowledgeBacklinks', { count: backlinks.length })}</h3>
        {!backlinks.length && <p className={styles.muted}>{lang('KnowledgeBacklinksEmpty')}</p>}
        {backlinks.map((other) => (
          <button
            key={other.id}
            type="button"
            className={styles.blockLink}
            data-title={other.title}
            onClick={handleLink}
          >
            {other.title}
          </button>
        ))}
      </section>
      <ConfirmDialog
        isOpen={isDeleteOpen}
        text={lang('KnowledgeDeleteConfirm', { name: note.title })}
        confirmLabel={lang('KnowledgeDelete')}
        confirmIsDestructive
        confirmHandler={handleDelete}
        onClose={closeDelete}
      />
    </article>
  );
};

export default memo(NoteView);
