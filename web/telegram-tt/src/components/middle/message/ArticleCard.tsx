import { memo, useMemo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiArticle } from '../../../api/types';
import type { MdBlock } from '../../parvane/markdown/markdown';

import buildClassName from '../../../util/buildClassName';
import { getReadingMinutes } from '../../parvane/article/articleReadingTime';
import { saveArticleToNotes } from '../../parvane/article/articleSave';
import { inlineText, parseMarkdown } from '../../parvane/markdown/markdown';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useModuleGate from '../../../hooks/useModuleGate';

import ArticleViewer from '../../parvane/article/ArticleViewer';
import PvModuleOff from '../../parvane/notes/PvModuleOff';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './ArticleCard.module.scss';

type OwnProps = {
  article: ApiArticle;
};

const PREVIEW_LINES = 3;
const PREVIEW_MAX_LENGTH = 220;

// Parvane (ARTICLE-1): статья в чате — карточка с началом текста, «Читать» и «В заметки» (доска `ZpChat`);
// замена «Статьи» Telegram, где вместо редактора статей — заметки
const ArticleCard = ({ article }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [isOpen, open, close] = useFlag();
  const [isSaving, setIsSaving] = useState(false);
  const gate = useModuleGate('notes');

  const preview = useMemo(() => buildPreview(article), [article]);
  const minutes = useMemo(() => getReadingMinutes(article.markdown), [article.markdown]);

  const handleSave = useLastCallback(async () => {
    setIsSaving(true);
    try {
      const saved = await saveArticleToNotes(article, lang);
      showNotification({ message: saved ? lang('ArticleSaved', { title: saved }) : lang('ArticleSaveFailed') });
    } finally {
      setIsSaving(false);
    }
  });

  // «Заметки» выключены на устройстве: кнопка ведёт в лист «Модуль выключен», после включения статья сохраняется
  const handleSaveClick = useLastCallback(() => gate.run(handleSave));

  return (
    <div className={styles.root} data-article-card={article.title}>
      <div className={styles.label} data-article-reading-time>
        {lang('ArticleLabel')}
        {' · '}
        {lang('ArticleReadingTime', { count: minutes }, { pluralValue: minutes })}
      </div>
      <div className={styles.title}>{article.title}</div>
      {preview && <p className={styles.preview}>{preview}</p>}
      <div className={styles.actions}>
        <span data-article-read>
          <button type="button" className={buildClassName(kit.chip, kit.chipOn, styles.action)} onClick={open}>
            {lang('ArticleRead')}
          </button>
        </span>
        {(gate.isOn || gate.canEnable) && (
          <button
            type="button"
            className={buildClassName(kit.chip, styles.action)}
            disabled={isSaving}
            data-article-to-notes
            onClick={handleSaveClick}
          >
            {lang('ArticleToNotes')}
          </button>
        )}
      </div>
      <ArticleViewer
        isOpen={isOpen}
        title={article.title}
        markdown={article.markdown}
        media={article.media}
        onClose={close}
      />
      <PvModuleOff
        isOpen={gate.isAsked}
        module="notes"
        hint={lang('ModuleOffHintNote')}
        onEnable={gate.enable}
        onClose={gate.dismiss}
      />
    </div>
  );
};

// Начало текста без разметки: первые строки абзацев, списков и цитат
function buildPreview(article: ApiArticle) {
  const lines: string[] = [];
  const collect = (blocks: MdBlock[]) => {
    for (const block of blocks) {
      if (lines.length >= PREVIEW_LINES) break;
      if (block.type === 'paragraph' || block.type === 'heading') {
        lines.push(...inlineText(block.text).split('\n'));
      } else if (block.type === 'quote') {
        collect(block.blocks);
      } else if (block.type === 'list') {
        lines.push(...block.items.map((item) => `• ${inlineText(item.text)}`));
      }
    }
  };
  collect(parseMarkdown(article.markdown, article.title));
  const text = lines.slice(0, PREVIEW_LINES).join('\n');
  return text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…` : text;
}

export default memo(ArticleCard);
