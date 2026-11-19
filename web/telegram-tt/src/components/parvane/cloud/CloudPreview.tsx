import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { PvIconName } from '../notes/PvIcon';
import type { CloudItemAction } from './CloudItem';
import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { callApi } from '../../../api/gramjs';
import {
  CLOUD_TEXT_PREVIEW_MAX_BYTES, decodeTextPreview, fileTypeLabel, kindOfFile,
} from './cloudModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Modal from '../../ui/Modal';
import PvIcon from '../notes/PvIcon';
import PvLoading from '../notes/PvLoading';

import styles from './CloudSheets.module.scss';

type Entry = { container: string; node: CloudNode };

type OwnProps = {
  container?: string;
  node?: CloudNode;
  maxBytes: number;
  // Файлы той же папки — для перехода «‹ ›»
  siblings?: Entry[];
  // Телефон: действия под просмотром, а не в шапке
  isNarrow?: boolean;
  canEdit?: boolean;
  // Просмотр вне «Файлов» (карточка холста): из действий только скачивание
  isDownloadOnly?: boolean;
  onNavigate?: (container: string, node: CloudNode) => void;
  onAction: (action: CloudItemAction, container: string, node: CloudNode) => void;
  onMore?: (container: string, node: CloudNode) => void;
  onClose: NoneToVoidFunction;
};

type PreviewAction = { action: CloudItemAction; icon: PvIconName; title: string; isDanger?: boolean };

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Просмотр файла без скачивания на диск (доски `XpFiles`, `XdFiles`): всегда тёмный, на весь экран. Фото, видео,
// аудио и PDF — средствами браузера из расшифрованного содержимого, текстовые файлы — текстом; остальное —
// скачать, а на месте просмотра стоит тип файла. Действия — в шапке на компьютере, под просмотром на телефоне
const CloudPreview = ({
  container, node, maxBytes, siblings, isNarrow, canEdit, isDownloadOnly, onNavigate, onAction, onMore, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [url, setUrl] = useState<string>();
  const [text, setText] = useState<string>();
  const [hasFailed, setHasFailed] = useState(false);
  const kind = node ? kindOfFile(node.mime, node.name) : 'other';
  const isText = kind === 'text';
  const isTooLarge = node ? node.size > (isText ? Math.min(maxBytes, CLOUD_TEXT_PREVIEW_MAX_BYTES) : maxBytes) : false;
  const canPreview = Boolean(node) && kind !== 'other' && !isTooLarge;

  useEffect(() => {
    setUrl(undefined);
    setText(undefined);
    setHasFailed(false);
    if (!container || !node || !canPreview) return undefined;
    let isActual = true;
    let created: string | undefined;
    void callParvane('parvaneCloudOpenBlob', { container, node: node.id, blob: node.blob }).then(async (blob) => {
      if (!isActual) return;
      if (!(blob instanceof Blob)) {
        setHasFailed(true);
        return;
      }
      if (isText) {
        const decoded = decodeTextPreview(new Uint8Array(await blob.arrayBuffer()));
        if (!isActual) return;
        // Расширение текстовое, а внутри двоичные данные — показываем заглушку
        if (decoded === undefined) setHasFailed(true);
        else setText(decoded);
        return;
      }
      // Тип нужен браузеру, чтобы выбрать проигрыватель (в дереве он мог не сохраниться)
      const typed = kind === 'pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob;
      created = URL.createObjectURL(typed);
      setUrl(created);
    }).catch(() => setHasFailed(true));
    return () => {
      isActual = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [container, node, canPreview, kind, isText]);

  const isOpen = Boolean(container && node);
  const position = siblings && node ? siblings.findIndex((entry) => entry.node.id === node.id) : -1;
  const hasNeighbours = Boolean(siblings && siblings.length > 1 && position >= 0);

  const go = (step: number) => {
    if (!siblings || !hasNeighbours) return;
    const next = siblings[(position + step + siblings.length) % siblings.length];
    onNavigate?.(next.container, next.node);
  };

  const handlePrevious = useLastCallback(() => go(-1));
  const handleNext = useLastCallback(() => go(1));
  const handleMore = useLastCallback(() => onMore?.(container!, node!));

  const handleAction = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onAction(e.currentTarget.dataset.previewAction as CloudItemAction, container!, node!);
  });

  // Стрелки клавиатуры листают файлы папки
  useEffect(() => {
    if (!isOpen || !hasNeighbours) return undefined;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') handlePrevious();
      if (e.key === 'ArrowRight') handleNext();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, hasNeighbours, handlePrevious, handleNext]);

  const typeLabel = node ? fileTypeLabel(node.name) : '';
  const stubText = isTooLarge ? lang('ParvaneCloudPreviewTooLarge')
    : kind === 'other' && typeLabel ? lang('ParvaneCloudPreviewNoViewer', { type: typeLabel })
      : lang('ParvaneCloudPreviewUnavailable');
  const dateText = node?.mtime
    ? new Date(node.mtime).toLocaleDateString(lang.code, { day: 'numeric', month: 'short' }).replace(/\.$/, '') : '';
  const facts = [
    hasNeighbours && lang('ParvaneCloudPreviewPosition', { index: position + 1, count: siblings!.length }),
    node && formatFileSize(lang, node.size),
    !isNarrow && dateText,
  ].filter(Boolean).join(' · ');
  const actions: PreviewAction[] = [
    { action: 'download', icon: 'download', title: lang('ParvaneCloudDownload') },
    ...(isDownloadOnly ? [] : [
      { action: 'send', icon: 'chat', title: lang('KnowledgeFilesToChat') },
    ] satisfies PreviewAction[]),
    ...(canEdit && !isDownloadOnly ? [
      { action: 'link', icon: 'link', title: lang('ParvaneCloudLinkShort') },
      { action: 'delete', icon: 'trash', title: lang('ParvaneCloudToTrashShort'), isDanger: true },
    ] satisfies PreviewAction[] : []),
  ];

  return (
    <Modal isOpen={isOpen} className={styles.preview} onClose={onClose}>
      <div className={styles.previewBar} data-preview={node?.id}>
        {isNarrow && (
          <button type="button" className={styles.previewIcon} aria-label={lang('Close')} onClick={onClose}>
            <PvIcon name="x" />
          </button>
        )}
        <div className={styles.previewTitle}>
          <span className={styles.previewName} dir="auto">{node?.name}</span>
          <span className={styles.previewFacts}>{facts}</span>
        </div>
        {!isNarrow && actions.map((item) => (
          <button
            key={item.action}
            type="button"
            className={buildClassName(styles.previewChip, item.isDanger && styles.previewDanger)}
            data-preview-action={item.action}
            onClick={handleAction}
          >
            {item.title}
          </button>
        ))}
        {onMore && (
          <button type="button" className={styles.previewIcon} aria-label={lang('MenuMore')} onClick={handleMore}>
            <PvIcon name="dots" />
          </button>
        )}
        {!isNarrow && (
          <button type="button" className={styles.previewIcon} aria-label={lang('Close')} onClick={onClose}>
            <PvIcon name="x" />
          </button>
        )}
      </div>
      <div className={styles.previewStage}>
        {hasNeighbours && (
          <button
            type="button"
            className={buildClassName(styles.previewIcon, styles.previewArrow, styles.previewArrowPrev)}
            aria-label={lang('KnowledgeFilesPrevious')}
            onClick={handlePrevious}
          >
            <PvIcon name="left" />
          </button>
        )}
        <div
          className={buildClassName(styles.previewArt, (isText || kind === 'pdf') && styles.previewArtText)}
          data-preview-kind={kind}
        >
          {(!canPreview || hasFailed) && (
            <div className={styles.previewStub} data-preview-stub>
              {typeLabel ? (
                <span className={styles.previewType} data-preview-type>{typeLabel}</span>
              ) : (
                <PvIcon name={kind === 'photo' ? 'image' : 'file'} />
              )}
              <span>{stubText}</span>
            </div>
          )}
          {canPreview && !hasFailed && !url && text === undefined && <PvLoading />}
          {text !== undefined && (
            <pre className={buildClassName(styles.previewText, 'custom-scroll')} dir="auto" data-preview-text>
              {text}
            </pre>
          )}
          {url && kind === 'photo' && <img className={styles.previewMedia} src={url} alt={node!.name} />}
          {url && kind === 'video' && <video className={styles.previewMedia} src={url} controls autoPlay />}
          {url && kind === 'audio' && <audio className={styles.previewAudio} src={url} controls autoPlay />}
          {url && kind === 'pdf' && <iframe className={styles.previewFrame} src={url} title={node!.name} />}
        </div>
        {hasNeighbours && (
          <button
            type="button"
            className={buildClassName(styles.previewIcon, styles.previewArrow, styles.previewArrowNext)}
            aria-label={lang('KnowledgeFilesNext')}
            onClick={handleNext}
          >
            <PvIcon name="right" />
          </button>
        )}
      </div>
      <div className={styles.previewFoot}>
        {`${hasNeighbours ? `${lang('ParvaneCloudPreviewKeys')} · ` : ''}${lang('KnowledgeFilesDecryptedHere')}`}
      </div>
      {isNarrow && (
        <div className={styles.previewTabs}>
          {actions.map((item) => (
            <button
              key={item.action}
              type="button"
              className={buildClassName(styles.previewTab, item.isDanger && styles.previewDanger)}
              data-preview-action={item.action}
              onClick={handleAction}
            >
              <PvIcon name={item.icon} />
              {item.title}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
};

export default memo(CloudPreview);
