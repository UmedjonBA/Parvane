import { memo } from '../../../lib/teact/teact';

import type { EditorTool } from './notesEditorInsert';

import { EDITOR_TOOL_SIGNS, EDITOR_TOOLS } from './notesEditorInsert';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './NoteView.module.scss';

type OwnProps = {
  // Заметки для незакрытой ссылки `[[…`; нет ссылки под курсором — `undefined`
  linkTitles?: string[];
  // Набранное начало названия, для которого заметки ещё нет
  newLinkTitle?: string;
  onTool: (tool: EditorTool) => void;
  onLink: (title: string) => void;
  onFile: NoneToVoidFunction;
  onCloudFile: NoneToVoidFunction;
};

const TOOL_LABELS = {
  heading: 'KnowledgeToolHeading',
  bold: 'KnowledgeToolBold',
  task: 'KnowledgeToolTask',
  link: 'KnowledgeToolLink',
  code: 'KnowledgeToolCode',
  callout: 'KnowledgeToolCallout',
  list: 'KnowledgeToolList',
} as const;

// Низ редактора заметки (доска `PhNotesMore`): подсказка заметки для ссылки и кнопки разметки
const NoteEditorTools = ({
  linkTitles, newLinkTitle, onTool, onLink, onFile, onCloudFile,
}: OwnProps) => {
  const lang = useLang();

  const handleTool = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onTool(e.currentTarget.dataset.tool as EditorTool);
  });

  const handleLink = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onLink(e.currentTarget.dataset.title!);
  });

  // Нажатие на кнопку не забирает фокус у редактора: выделение текста остаётся на месте
  const keepFocus = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
  });

  return (
    <>
      {linkTitles && (
        <div className={styles.suggest} data-note-link-suggest onMouseDown={keepFocus}>
          <span className={styles.suggestLabel}>{lang('KnowledgeLinkSuggest')}</span>
          {linkTitles.map((title) => (
            <button key={title} type="button" className={styles.suggestChip} data-title={title} onClick={handleLink}>
              {title}
            </button>
          ))}
          {newLinkTitle && (
            <button
              type="button"
              className={styles.suggestChip}
              data-title={newLinkTitle}
              data-note-link-new
              onClick={handleLink}
            >
              {lang('KnowledgeLinkNew', { name: newLinkTitle })}
            </button>
          )}
        </div>
      )}
      <div className={styles.tools} role="toolbar" aria-label={lang('KnowledgeTools')} onMouseDown={keepFocus}>
        {EDITOR_TOOLS.map((tool) => (
          <button
            key={tool}
            type="button"
            className={styles.tool}
            aria-label={lang(TOOL_LABELS[tool])}
            title={lang(TOOL_LABELS[tool])}
            data-tool={tool}
            onClick={handleTool}
          >
            {EDITOR_TOOL_SIGNS[tool]}
          </button>
        ))}
        <span className={styles.toolsGap} data-note-insert>
          <button
            type="button"
            className={styles.tool}
            aria-label={lang('KnowledgeInsertFile')}
            title={lang('KnowledgeInsertFile')}
            data-note-insert-file
            onClick={onFile}
          >
            <PvIcon name="upload" isSmall />
          </button>
          <button
            type="button"
            className={styles.tool}
            aria-label={lang('KnowledgeInsertFromCloud')}
            title={lang('KnowledgeInsertFromCloud')}
            data-note-insert-cloud
            onClick={onCloudFile}
          >
            <PvIcon name="folder" isSmall />
          </button>
        </span>
      </div>
    </>
  );
};

export default memo(NoteEditorTools);
