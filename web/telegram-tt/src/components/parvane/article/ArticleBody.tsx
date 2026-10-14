import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useMemo } from '../../../lib/teact/teact';

import type { ArticleInline } from './articleMarkdown';

import buildClassName from '../../../util/buildClassName';
import { parseArticle, parseArticleInline } from './articleMarkdown';

import useLang from '../../../hooks/useLang';

import styles from './Article.module.scss';

type OwnProps = {
  title: string;
  markdown: string;
};

// Текст статьи для чтения: блоки Markdown заметки, без правки
const ArticleBody = ({ title, markdown }: OwnProps) => {
  const lang = useLang();
  const blocks = useMemo(() => parseArticle(markdown, title), [markdown, title]);

  return (
    <div className={styles.body} data-article-body>
      {blocks.map((block, i) => {
        const key = `${i}${block.type}`;
        switch (block.type) {
          case 'heading':
            return (
              <div
                key={key}
                role="heading"
                aria-level={block.level + 1}
                className={buildClassName(styles.heading, styles[`heading${block.level}`])}
              >
                {renderInline(block.text)}
              </div>
            );
          case 'paragraph':
            return <p key={key} className={styles.paragraph}>{renderInline(block.text)}</p>;
          case 'quote':
            return <blockquote key={key} className={styles.quote}>{renderInline(block.text)}</blockquote>;
          case 'code':
            return <pre key={key} className={styles.code}>{block.text}</pre>;
          case 'rule':
            return <hr key={key} className={styles.rule} />;
          case 'image':
            return (
              <p key={key} className={styles.image}>{lang('ArticleImageOmitted', { name: block.name })}</p>
            );
          case 'list': {
            const Tag = block.isOrdered ? 'ol' : 'ul';
            return (
              <Tag key={key} className={styles.list}>
                {block.items.map((item, n) => (
                  <li
                    key={n}
                    className={buildClassName(styles.item, item.isChecked !== undefined && styles.task)}
                    style={item.depth ? `margin-inline-start: ${item.depth * 1.25}rem` : undefined}
                    data-checked={item.isChecked !== undefined ? String(item.isChecked) : undefined}
                  >
                    {item.isChecked !== undefined && (
                      <span className={buildClassName(styles.check, item.isChecked && styles.checkDone)} />
                    )}
                    <span className={item.isChecked && styles.done}>{renderInline(item.text)}</span>
                  </li>
                ))}
              </Tag>
            );
          }
          default:
            return undefined;
        }
      })}
    </div>
  );
};

function renderInline(text: string): TeactNode[] {
  return parseArticleInline(text).map((part: ArticleInline, i) => {
    switch (part.type) {
      case 'bold':
        return <strong key={i}>{part.text}</strong>;
      case 'italic':
        return <em key={i}>{part.text}</em>;
      case 'code':
        return <code key={i} className={styles.inlineCode}>{part.text}</code>;
      case 'note':
        return <span key={i} className={styles.noteLink}>{part.text}</span>;
      case 'tag':
        return <span key={i} className={styles.tag}>{part.text}</span>;
      case 'link':
        return (
          <a key={i} className={styles.link} href={part.url} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        );
      default:
        return part.text;
    }
  });
}

export default memo(ArticleBody);
