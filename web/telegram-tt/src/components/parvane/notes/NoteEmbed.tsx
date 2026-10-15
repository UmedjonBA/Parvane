import { memo, useMemo } from '../../../lib/teact/teact';

import type { CloudNode } from '../cloud/cloudModel';
import type { MdEmbed } from '../markdown/markdown';

import { callApi } from '../../../api/gramjs';
import { kindOfFile } from '../cloud/cloudModel';
import { downloadCloudNode } from '../cloud/cloudStore';
import { resolveEmbed } from './notesEmbeds';

import useLastCallback from '../../../hooks/useLastCallback';

import MediaEmbed from '../markdown/MediaEmbed';

import styles from './Knowledge.module.scss';

type OwnProps = {
  embed: MdEmbed;
  noteId: string;
  // Личный диск: id контейнера и его узлы
  driveId?: string;
  nodes: CloudNode[];
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
// Скачивание через память — до этого размера; больше — потоком в выбранный файл
const DOWNLOAD_MEMORY_BYTES = 256 * 1024 * 1024;

// Встроенный файл заметки: файл личного диска по имени либо пути; внешний адрес — ссылкой (не загружается)
const NoteEmbed = ({
  embed, noteId, driveId, nodes,
}: OwnProps) => {
  const node = useMemo(() => (embed.url ? undefined : resolveEmbed(nodes, embed.name, noteId)), [embed, nodes, noteId]);

  const load = useLastCallback(async () => {
    if (!driveId || !node) return undefined;
    const blob = await callParvane('parvaneCloudOpenBlob', { container: driveId, node: node.id, blob: node.blob });
    return blob instanceof Blob ? blob : undefined;
  });

  const loadThumb = useLastCallback(async () => {
    if (!driveId || !node?.thumb) return undefined;
    const url = await callParvane('parvaneCloudThumb', {
      container: driveId, node: node.id, blob: node.blob, thumb: node.thumb,
    });
    return typeof url === 'string' ? url : undefined;
  });

  const handleDownload = useLastCallback(() => {
    if (driveId && node) void downloadCloudNode(driveId, node, DOWNLOAD_MEMORY_BYTES);
  });

  if (embed.url) {
    return (
      <a className={styles.link} href={embed.url} target="_blank" rel="noopener noreferrer">
        {embed.alt || embed.url}
      </a>
    );
  }

  return (
    <MediaEmbed
      name={node?.name || embed.name}
      alt={embed.alt}
      isMissing={!node}
      kind={node ? kindOfFile(node.mime || '', node.name) : undefined}
      size={node?.size}
      cacheKey={node?.blob?.fileId}
      load={load}
      loadThumb={node?.thumb ? loadThumb : undefined}
      onDownload={handleDownload}
    />
  );
};

export default memo(NoteEmbed);
