import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useRef } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MdBlock, MdCallout, MdEmbed, MdListItem } from './markdown';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import {
  MD_BOLD, MD_CODE, MD_ITALIC, MD_MARK, MD_STRIKE, MD_SUB, MD_SUP, MD_UNDERLINE, parseInline,
} from './markdown';

import useAsync from '../../../hooks/useAsync';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';

import '../../common/code/CodeBlock.scss';
import styles from './Markdown.module.scss';

type OwnProps = {
  blocks: MdBlock[];
  className?: string;
  // `[[заметка]]`: в заметке — переход, в статье — подсветка
  renderNote?: (part: { text: string; target: string }, key: string) => TeactNode;
  renderEmbed: (embed: MdEmbed) => TeactNode;
  // Пункты с галочкой: заметка отмечает пункт по номеру строки; без обработчика галочка только показывается
  onToggleTask?: (line: number, isDone: boolean) => void;
  // Пункт, ставший задачей «Плана»: текст без служебной метки и хвост (дата)
  taskTail?: (text: string) => { text: string; tail?: TeactNode };
};

type Context = Pick<OwnProps, 'renderNote' | 'renderEmbed' | 'taskTail'> & {
  hasToggle: boolean;
  calloutTitle: (callout: MdCallout) => string;
};

// Виды callouts GitHub и Obsidian → тон рамки; прочие — акцент
const CALLOUT_TONES: Record<string, string> = {
  note: 'blue',
  info: 'blue',
  todo: 'blue',
  abstract: 'aqua',
  summary: 'aqua',
  tldr: 'aqua',
  tip: 'green',
  hint: 'green',
  success: 'green',
  check: 'green',
  done: 'green',
  important: 'purple',
  question: 'yellow',
  help: 'yellow',
  faq: 'yellow',
  warning: 'orange',
  attention: 'orange',
  caution: 'red',
  danger: 'red',
  error: 'red',
  failure: 'red',
  fail: 'red',
  missing: 'red',
  bug: 'red',
  example: 'purple',
  quote: 'muted',
  cite: 'muted',
};
const CALLOUT_KEYS = {
  note: 'MdCalloutNote',
  tip: 'MdCalloutTip',
  important: 'MdCalloutImportant',
  warning: 'MdCalloutWarning',
  caution: 'MdCalloutCaution',
} as const;
const STYLE_TAGS: [number, string][] = [
  [MD_SUP, 'sup'],
  [MD_SUB, 'sub'],
  [MD_MARK, 'mark'],
  [MD_UNDERLINE, 'u'],
  [MD_STRIKE, 's'],
  [MD_ITALIC, 'em'],
  [MD_BOLD, 'strong'],
];

// Показ Markdown заметки и статьи (этап 6 плана 15 окт 2026; доработка 6 ноя 2026): один вид для обоих
const MarkdownBlocks = ({
  blocks, className, renderNote, renderEmbed, onToggleTask, taskTail,
}: OwnProps) => {
  const rootRef = useRef<HTMLDivElement>();
  const lang = useLang();

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onToggleTask?.(Number(e.currentTarget.dataset.line), e.currentTarget.checked);
  });

  // Якорь `#раздел` — прокрутка к заголовку этого же текста
  const handleClick = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-md-anchor]');
    if (!link) return;
    e.preventDefault();
    const id = link.dataset.mdAnchor!;
    const heading = Array.from(rootRef.current!.querySelectorAll<HTMLElement>('[data-md-id]'))
      .find((element) => element.dataset.mdId === id || element.dataset.mdId === id.toLowerCase());
    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const calloutTitle = useLastCallback((callout: MdCallout) => {
    if (callout.title) return callout.title;
    const key = CALLOUT_KEYS[callout.kind as keyof typeof CALLOUT_KEYS];
    return key ? lang(key) : callout.kind[0].toUpperCase() + callout.kind.slice(1);
  });

  const context: Context = {
    renderNote, renderEmbed, taskTail, hasToggle: Boolean(onToggleTask), calloutTitle,
  };

  return (
    <div ref={rootRef} className={buildClassName(styles.root, className)} onClick={handleClick}>
      {renderBlocks(blocks, context, handleToggle)}
    </div>
  );
};

function renderBlocks(
  blocks: MdBlock[], context: Context, onToggle: (e: React.ChangeEvent<HTMLInputElement>) => void,
): TeactNode[] {
  return blocks.map((block) => {
    const key = `${block.line}${block.type}`;
    switch (block.type) {
      case 'heading':
        return (
          <div
            key={key}
            role="heading"
            aria-level={block.level}
            data-md-id={block.id}
            data-md-line={block.line}
            className={buildClassName(styles.heading, styles[`heading${block.level}`])}
          >
            {renderInline(block.text, context)}
          </div>
        );
      case 'paragraph':
        return (
          <p key={key} className={styles.paragraph} data-md-line={block.line}>{renderInline(block.text, context)}</p>
        );
      case 'quote':
        return block.callout ? renderCallout(key, block.line, block.callout, block.blocks, context, onToggle) : (
          <blockquote key={key} className={styles.quote} data-md-line={block.line}>
            {renderBlocks(block.blocks, context, onToggle)}
          </blockquote>
        );
      case 'code':
        return <CodeView key={key} text={block.text} language={block.lang} line={block.line} />;
      case 'rule':
        return <hr key={key} className={styles.rule} data-md-line={block.line} />;
      case 'embed':
        return (
          <div key={key} className={styles.embed} data-md-embed={block.name} data-md-line={block.line}>
            {context.renderEmbed(block)}
          </div>
        );
      case 'table':
        return (
          <div key={key} className={styles.tableWrap} data-md-line={block.line}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {block.header.map((cell, n) => (
                    <th key={n} style={block.align[n] ? `text-align: ${block.align[n]}` : undefined}>
                      {renderInline(cell, context)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, n) => (
                      <td key={n} style={block.align[n] ? `text-align: ${block.align[n]}` : undefined}>
                        {renderInline(cell, context)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list':
        return (
          <ul key={key} className={styles.list}>
            {block.items.map((item) => renderItem(item, context, onToggle))}
          </ul>
        );
      default:
        return undefined;
    }
  });
}

function renderCallout(
  key: string, line: number, callout: MdCallout, blocks: MdBlock[], context: Context,
  onToggle: (e: React.ChangeEvent<HTMLInputElement>) => void,
) {
  const tone = CALLOUT_TONES[callout.kind] || 'accent';
  const className = buildClassName(styles.callout, styles[`callout_${tone}`]);
  const title = <span className={styles.calloutTitle}>{renderInline(context.calloutTitle(callout), context)}</span>;
  const body = blocks.length ? <div className={styles.calloutBody}>{renderBlocks(blocks, context, onToggle)}</div>
    : undefined;
  if (callout.fold) {
    return (
      <details
        key={key}
        className={className}
        data-callout={callout.kind}
        data-md-line={line}
        open={callout.fold === 'open'}
      >
        <summary className={styles.calloutSummary}>{title}</summary>
        {body}
      </details>
    );
  }
  return (
    <div key={key} className={className} data-callout={callout.kind} data-md-line={line}>
      {title}
      {body}
    </div>
  );
}

function renderItem(item: MdListItem, context: Context, onToggle: (e: React.ChangeEvent<HTMLInputElement>) => void) {
  const indent = item.depth ? `margin-inline-start: ${item.depth * 1.25}rem` : undefined;
  const children = item.blocks?.length
    ? <div className={styles.itemBlocks}>{renderBlocks(item.blocks, context, onToggle)}</div> : undefined;
  if (item.isChecked === undefined) {
    return (
      <li key={item.line} className={styles.item} style={indent} data-md-line={item.line}>
        <span className={styles.marker} aria-hidden>
          {item.number !== undefined ? `${item.number}.` : '•'}
        </span>
        <div className={styles.itemBody}>
          <span className={styles.itemText}>{renderInline(item.text, context)}</span>
          {children}
        </div>
      </li>
    );
  }
  const { text, tail } = context.taskTail ? context.taskTail(item.text) : { text: item.text, tail: undefined };
  return (
    <li
      key={item.line}
      className={buildClassName(styles.item, styles.task, item.isChecked && styles.taskDone)}
      style={indent}
      data-checked={String(item.isChecked)}
      data-md-line={item.line}
    >
      {item.number !== undefined && <span className={styles.marker} aria-hidden>{`${item.number}.`}</span>}
      <div className={styles.itemBody}>
        <label className={styles.taskLabel}>
          <input
            type="checkbox"
            className={styles.check}
            checked={item.isChecked}
            disabled={!context.hasToggle}
            data-line={item.line}
            onChange={onToggle}
          />
          <span className={styles.taskText}>
            {renderInline(text, context)}
            {tail}
          </span>
        </label>
        {children}
      </div>
    </li>
  );
}

function renderInline(text: string, context: Context): TeactNode[] {
  const parts = parseInline(text);
  const nodes: TeactNode[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    const key = `${i}${part.type}`;
    if (part.type === 'link') {
      // Соседние куски одной ссылки — одна ссылка
      const group: TeactNode[] = [];
      let j = i;
      while (j < parts.length && parts[j].type === 'link' && parts[j].url === part.url) {
        group.push(renderStyled(parts[j].text, parts[j].style, String(j)));
        j++;
      }
      const url = part.url!;
      nodes.push(url.startsWith('#') ? (
        <a key={key} className={styles.link} href={url} data-md-anchor={safeDecode(url.slice(1))}>{group}</a>
      ) : (
        <a key={key} className={styles.link} href={url} target="_blank" rel="noopener noreferrer">{group}</a>
      ));
      i = j;
      continue;
    }
    if (part.type === 'note') {
      nodes.push(context.renderNote ? context.renderNote({ text: part.text, target: part.target! }, key)
        : <span key={key} className={styles.note}>{renderStyled(part.text, part.style, '0')}</span>);
    } else if (part.type === 'tag') {
      nodes.push(<span key={key} className={styles.tag}>{renderStyled(part.text, part.style, '0')}</span>);
    } else {
      nodes.push(renderStyled(part.text, part.style, key));
    }
    i++;
  }
  return nodes;
}

function renderStyled(text: string, style: number | undefined, key: string): TeactNode {
  if (!style) return text;
  let node: TeactNode = style & MD_CODE ? <code key={key} className={styles.code}>{text}</code> : text;
  for (const [flag, tag] of STYLE_TAGS) {
    if (!(style & flag)) continue;
    const Tag = tag as 'em';
    node = <Tag key={key} className={tag === 'mark' ? styles.mark : undefined}>{node}</Tag>;
  }
  return node;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Блок кода: подсветка по языку info string (та же, что у кода в сообщениях), язык подписью
const CodeView = memo(({ text, language, line }: { text: string; language?: string; line: number }) => {
  const { result: highlighted } = useAsync(() => {
    if (!language) return Promise.resolve(undefined);
    return import('../../../util/highlightCode')
      .then((lib) => lib.default(text, language))
      .catch(() => undefined);
  }, [language, text]);

  const { showNotification } = getActions();
  const lang = useLang();

  const handleCopy = useLastCallback(() => {
    copyTextToClipboard(text);
    showNotification({ message: lang('TextCopied') });
  });

  return (
    <div className={styles.codeBlock} data-md-code={language} data-md-line={line}>
      {language && <span className={styles.codeLang}>{language}</span>}
      {/* Как на GitHub: кнопка появляется при наведении, справа сверху внутри блока */}
      <button
        type="button"
        className={styles.codeCopy}
        aria-label={lang('Copy')}
        title={lang('Copy')}
        data-md-copy
        onClick={handleCopy}
      >
        <Icon name="copy" />
      </button>
      <pre className={styles.pre}>{highlighted ?? text}</pre>
    </div>
  );
});

export default memo(MarkdownBlocks);
