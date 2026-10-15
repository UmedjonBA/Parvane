import { memo, useMemo } from '../../../lib/teact/teact';

import type { ApiArticleMedia } from '../../../api/types';
import type { MdEmbed } from '../markdown/markdown';

import download from '../../../util/download';
import { callApi } from '../../../api/gramjs';
import { kindOfFile } from '../cloud/cloudModel';
import { parseMarkdown } from '../markdown/markdown';
import { findMedia } from './articleMedia';

import useLastCallback from '../../../hooks/useLastCallback';

import MarkdownBlocks from '../markdown/MarkdownBlocks';
import MediaEmbed from '../markdown/MediaEmbed';

import styles from './Article.module.scss';

type OwnProps = {
  title: string;
  markdown: string;
  media?: ApiArticleMedia[];
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Текст статьи для чтения: тот же показ Markdown, что у заметки; встроенные файлы — вложения статьи
const ArticleBody = ({ title, markdown, media }: OwnProps) => {
  const blocks = useMemo(() => parseMarkdown(markdown, title), [markdown, title]);

  const renderEmbed = useLastCallback((embed: MdEmbed) => {
    if (embed.url) {
      return (
        <a className={styles.link} href={embed.url} target="_blank" rel="noopener noreferrer">
          {embed.alt || embed.url}
        </a>
      );
    }
    return <ArticleEmbed embed={embed} item={findMedia(media, embed.name)} />;
  });

  return (
    <div data-article-body>
      <MarkdownBlocks blocks={blocks} renderEmbed={renderEmbed} />
    </div>
  );
};

const ArticleEmbed = memo(({ embed, item }: { embed: MdEmbed; item?: ApiArticleMedia }) => {
  const fileId = item?.fileId;
  const load = useLastCallback(async () => {
    if (!fileId) return undefined;
    const blob = await callParvane('parvaneArticleMediaBlob', { fileId });
    return blob instanceof Blob ? blob : undefined;
  });
  const handleDownload = useLastCallback(async () => {
    const blob = await load();
    if (!blob || !item) return;
    const url = URL.createObjectURL(blob);
    download(url, item.name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  return (
    <MediaEmbed
      name={item?.name || embed.name}
      alt={embed.alt}
      isMissing={!item}
      kind={item ? kindOfFile(item.mimeType, item.name) : undefined}
      size={item?.size}
      cacheKey={fileId}
      load={load}
      onDownload={handleDownload}
    />
  );
});

export default memo(ArticleBody);
