import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import type { MdBlock, MdEmbed, MdInline } from './markdown';

import buildClassName from '../../../util/buildClassName';
import { parseInline } from './markdown';

import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Markdown.module.scss';

type OwnProps = {
  blocks: MdBlock[];
  className?: string;
  // `[[заметка]]`: в заметке — переход, в статье — подсветка
  renderNote?: (part: Extract<MdInline, { type: 'note' }>, key: string) => TeactNode;
  renderEmbed: (embed: MdEmbed) => TeactNode;
  // Пункты с галочкой: заметка отмечает пункт по номеру строки; без обработчика галочка только показывается
  onToggleTask?: (line: number, isDone: boolean) => void;
  // Пункт, ставший задачей «Плана»: текст без служебной метки и хвост (дата)
  taskTail?: (text: string) => { text: string; tail?: TeactNode };
};

// Показ Markdown заметки и статьи (этап 6 плана 15 окт 2026): один вид для обоих
const MarkdownBlocks = ({
  blocks, className, renderNote, renderEmbed, onToggleTask, taskTail,
}: OwnProps) => {
  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onToggleTask?.(Number(e.currentTarget.dataset.line), e.currentTarget.checked);
  });

  const renderInline = (text: string): TeactNode[] => parseInline(text).map((part, i) => {
    const key = `${i}${part.type}`;
    switch (part.type) {
      case 'bold':
        return <strong key={key}>{part.text}</strong>;
      case 'italic':
        return <em key={key}>{part.text}</em>;
      case 'strike':
        return <s key={key}>{part.text}</s>;
      case 'code':
        return <code key={key} className={styles.code}>{part.text}</code>;
      case 'note':
        return renderNote ? renderNote(part, key) : <span key={key} className={styles.note}>{part.text}</span>;
      case 'tag':
        return <span key={key} className={styles.tag}>{part.text}</span>;
      case 'link':
        return (
          <a key={key} className={styles.link} href={part.url} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        );
      default:
        return part.text;
    }
  });

  return (
    <div className={buildClassName(styles.root, className)}>
      {blocks.map((block) => {
        const key = `${block.line}${block.type}`;
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
            return <pre key={key} className={styles.pre}>{block.text}</pre>;
          case 'rule':
            return <hr key={key} className={styles.rule} />;
          case 'embed':
            return <div key={key} className={styles.embed} data-md-embed={block.name}>{renderEmbed(block)}</div>;
          case 'table':
            return (
              <div key={key} className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {block.header.map((cell, n) => (
                        <th key={n} style={block.align[n] ? `text-align: ${block.align[n]}` : undefined}>
                          {renderInline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, n) => (
                          <td key={n} style={block.align[n] ? `text-align: ${block.align[n]}` : undefined}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'list': {
            const Tag = block.isOrdered ? 'ol' : 'ul';
            return (
              <Tag key={key} className={buildClassName(styles.list, block.isOrdered && styles.ordered)}>
                {block.items.map((item) => {
                  const indent = item.depth ? `margin-inline-start: ${item.depth * 1.25}rem` : undefined;
                  if (item.isChecked === undefined) {
                    return <li key={item.line} className={styles.item} style={indent}>{renderInline(item.text)}</li>;
                  }
                  const { text, tail } = taskTail ? taskTail(item.text) : { text: item.text, tail: undefined };
                  return (
                    <li
                      key={item.line}
                      className={buildClassName(styles.item, styles.task, item.isChecked && styles.taskDone)}
                      style={indent}
                      data-checked={String(item.isChecked)}
                    >
                      <label className={styles.taskLabel}>
                        <input
                          type="checkbox"
                          className={styles.check}
                          checked={item.isChecked}
                          disabled={!onToggleTask}
                          data-line={item.line}
                          onChange={handleToggle}
                        />
                        <span className={styles.taskText}>
                          {renderInline(text)}
                          {tail}
                        </span>
                      </label>
                    </li>
                  );
                })}
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

export default memo(MarkdownBlocks);
