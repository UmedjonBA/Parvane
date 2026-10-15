import { memo, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { ApiArticleMedia } from '../../../api/types';

import { embedNames, renameEmbeds } from '../markdown/markdown';
import { parseNote } from '../notes/notesModel';
import {
  createNote, findNoteByTitle, loadNotes, saveChatFilesToVault,
} from '../notes/notesStore';
import { findMedia } from './articleMedia';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Modal from '../../ui/Modal';
import ArticleBody from './ArticleBody';

import styles from './Article.module.scss';

type OwnProps = {
  isOpen: boolean;
  title: string;
  markdown: string;
  media?: ApiArticleMedia[];
  onClose: NoneToVoidFunction;
};

// Окно чтения статьи (ARTICLE-1): текст заметки и «Сохранить в заметки» — копия ложится в «Знания»
const ArticleViewer = ({
  isOpen, title, markdown, media, onClose,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = useLastCallback(async () => {
    setIsSaving(true);
    try {
      // Хранилище читается раньше записи: без дерева облака папка «Знаний» создалась бы второй раз
      await loadNotes(getGlobal().currentUserId);
      let body = parseNote(markdown).body.trim();
      // Встроенные файлы статьи ложатся в хранилище рядом с заметкой; занятые имена получают номер
      const files = embedNames(body)
        .map((name) => ({ name, item: findMedia(media, name) }))
        .filter(({ item }) => item);
      if (files.length) {
        const renamed = await saveChatFilesToVault(lang('KnowledgeVaultName'), files.map(({ item }) => ({
          fileId: item!.fileId, name: item!.name, mime: item!.mimeType, size: item!.size,
        })));
        if (!renamed) {
          showNotification({ message: lang('ArticleSaveFailed') });
          return;
        }
        const targets = files.map(({ name, item }) => [name, renamed.get(item!.name) || item!.name] as const);
        body = renameEmbeds(body, new Map(targets));
      }
      const id = await createNote(title, lang('KnowledgeVaultName'), { text: `# ${title}\n\n${body}\n` });
      const saved = id ? findNoteByTitle(title) : undefined;
      showNotification({
        message: id
          ? lang('ArticleSaved', { title: saved?.id === id ? saved.title : title })
          : lang('ArticleSaveFailed'),
      });
    } finally {
      setIsSaving(false);
    }
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      hasCloseButton
      className={styles.viewer}
      contentClassName={styles.viewerContent}
    >
      <div data-article-viewer>
        <ArticleBody title={title} markdown={markdown} media={media} />
        <div className={styles.viewerActions} data-article-save>
          <Button size="smaller" noForcedUpperCase disabled={isSaving} onClick={handleSave}>
            {lang('ArticleSaveToNotes')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default memo(ArticleViewer);
