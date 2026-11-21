import { memo, useMemo } from '../../../lib/teact/teact';

import type { CloudNode } from '../cloud/cloudModel';
import type { MdEmbed } from '../markdown/markdown';

import { callApi } from '../../../api/gramjs';
import { kindOfFile } from '../cloud/cloudModel';
import { downloadCloudNode } from '../cloud/cloudStore';
import { resolveEmbed } from './notesEmbeds';

import useAppLayout from '../../../hooks/useAppLayout';
import useFlag from '../../../hooks/useFlag';
import useLastCallback from '../../../hooks/useLastCallback';

import CloudPreview from '../cloud/CloudPreview';
import MarkdownLink from '../markdown/MarkdownLink';
import MediaEmbed from '../markdown/MediaEmbed';
import CanvasFilePicker from './CanvasFilePicker';

import styles from './Knowledge.module.scss';

type OwnProps = {
  embed: MdEmbed;
  noteId: string;
  // Личный диск: id контейнера и его узлы
  driveId?: string;
  nodes: CloudNode[];
  // Файла нет: на место `![[name]]` встаёт выбранный файл диска (путь от корня диска)
  onRepick?: (name: string, path: string) => void;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
// Скачивание через память — до этого размера; больше — потоком в выбранный файл
const DOWNLOAD_MEMORY_BYTES = 256 * 1024 * 1024;
// Просмотр на весь экран читает файл в память: до этого размера
const PREVIEW_MAX_BYTES = 256 * 1024 * 1024;
const PREVIEW_MAX_BYTES_MOBILE = 64 * 1024 * 1024;

// Встроенный файл заметки: файл личного диска по имени либо пути; внешний адрес — ссылкой (не загружается).
// Картинка открывается на весь экран (просмотр «Файлов»), пропавший файл выбирается заново (доска `ZpNotesX`)
const NoteEmbed = ({
  embed, noteId, driveId, nodes, onRepick,
}: OwnProps) => {
  const { isMobile } = useAppLayout();
  const [isPreviewOpen, openPreview, closePreview] = useFlag();
  const [isPicking, startPicking, stopPicking] = useFlag();
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

  // Видео без миниатюры (загружено раньше): кадр снимается и дописывается в облако для всех устройств
  const loadVideoPoster = useLastCallback(async () => {
    if (!driveId || !node) return undefined;
    const url = await callParvane('parvaneCloudBackfillThumb', { container: driveId, node: node.id });
    return typeof url === 'string' ? url : undefined;
  });

  const handleDownload = useLastCallback(() => {
    if (driveId && node) void downloadCloudNode(driveId, node, DOWNLOAD_MEMORY_BYTES);
  });

  // Из просмотра — только скачивание
  const handlePreviewAction = useLastCallback(() => handleDownload());

  const handlePick = useLastCallback((path: string) => {
    stopPicking();
    onRepick?.(embed.name, path);
  });

  if (embed.url) {
    return (
      <MarkdownLink className={styles.link} url={embed.url} text={embed.alt || embed.url} />
    );
  }

  const kind = node ? kindOfFile(node.mime || '', node.name) : undefined;
  const thumbLoader = node?.thumb ? loadThumb : kind === 'video' ? loadVideoPoster : undefined;

  return (
    <>
      <MediaEmbed
        name={node?.name || embed.name}
        alt={embed.alt}
        isMissing={!node}
        kind={kind}
        size={node?.size}
        cacheKey={node?.blob?.fileId}
        load={load}
        loadThumb={thumbLoader}
        isFromDrive
        onDownload={handleDownload}
        onOpen={kind === 'photo' && driveId ? openPreview : undefined}
        onRepick={!node && onRepick ? startPicking : undefined}
      />
      {kind === 'photo' && (
        <CloudPreview
          container={isPreviewOpen ? driveId : undefined}
          node={isPreviewOpen ? node : undefined}
          maxBytes={isMobile ? PREVIEW_MAX_BYTES_MOBILE : PREVIEW_MAX_BYTES}
          isNarrow={isMobile}
          isDownloadOnly
          onAction={handlePreviewAction}
          onClose={closePreview}
        />
      )}
      {!node && onRepick && (
        <CanvasFilePicker isOpen={isPicking} nodes={nodes} onPick={handlePick} onClose={stopPicking} />
      )}
    </>
  );
};

export default memo(NoteEmbed);
