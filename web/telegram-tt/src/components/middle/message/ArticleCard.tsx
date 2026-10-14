import { memo, useMemo } from '../../../lib/teact/teact';

import type { ApiArticle } from '../../../api/types';

import { parseArticle } from '../../parvane/article/articleMarkdown';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';

import Icon from '../../common/icons/Icon';
import ArticleViewer from '../../parvane/article/ArticleViewer';
import Button from '../../ui/Button';

import styles from './ArticleCard.module.scss';

type OwnProps = {
  article: ApiArticle;
};

const PREVIEW_LINES = 3;
const PREVIEW_MAX_LENGTH = 220;

// Parvane (ARTICLE-1): статья в чате — карточка с началом текста и «Читать»; замена «Статьи» Telegram,
// где вместо редактора статей — заметки «Знаний»
const ArticleCard = ({ article }: OwnProps) => {
  const lang = useLang();
  const [isOpen, open, close] = useFlag();

  const preview = useMemo(() => buildPreview(article), [article]);

  return (
    <div className={styles.root} data-article-card={article.title}>
      <div className={styles.head}>
        <span className={styles.badge}>
          <Icon name="document" />
        </span>
        <div className={styles.titles}>
          <span className={styles.label}>{lang('ArticleLabel')}</span>
          <span className={styles.title}>{article.title}</span>
        </div>
      </div>
      {preview && <p className={styles.preview}>{preview}</p>}
      <div className={styles.actions} data-article-read>
        <Button size="tiny" noForcedUpperCase onClick={open}>{lang('ArticleRead')}</Button>
      </div>
      <ArticleViewer isOpen={isOpen} title={article.title} markdown={article.markdown} onClose={close} />
    </div>
  );
};

// Начало текста без разметки: первые строки абзацев, списков и цитат
function buildPreview(article: ApiArticle) {
  const lines: string[] = [];
  for (const block of parseArticle(article.markdown, article.title)) {
    if (lines.length >= PREVIEW_LINES) break;
    if (block.type === 'paragraph' || block.type === 'quote' || block.type === 'heading') {
      lines.push(...block.text.split('\n'));
    } else if (block.type === 'list') {
      lines.push(...block.items.map((item) => `• ${item.text}`));
    }
  }
  const text = lines.slice(0, PREVIEW_LINES).join('\n')
    .replace(/\*\*|`|\[\[|\]\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…` : text;
}

export default memo(ArticleCard);
