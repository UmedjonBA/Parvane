import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { formatFileSize } from '../../../util/textFormat';
import { callApi } from '../../../api/gramjs';
import { kindOfFile } from './cloudModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Loading from '../../ui/Loading';
import PvIcon from '../notes/PvIcon';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './Cloud.module.scss';

type Entry = { container: string; node: CloudNode };

type OwnProps = {
  container?: string;
  node?: CloudNode;
  maxBytes: number;
  // Файлы той же папки — для перехода «‹ ›»
  siblings?: Entry[];
  // Где лежит и у кого есть доступ — строками сведений
  folderText?: string;
  accessText?: string;
  onNavigate?: (container: string, node: CloudNode) => void;
  onDownload: (container: string, node: CloudNode) => void;
  onSend?: (container: string, node: CloudNode) => void;
  onMore?: (container: string, node: CloudNode) => void;
  onClose: NoneToVoidFunction;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Просмотр файла облака без скачивания на диск: фото, видео, аудио и PDF — средствами браузера из
// расшифрованного содержимого; остальное — скачать. Под просмотром — сведения и действия
const CloudPreview = ({
  container, node, maxBytes, siblings, folderText, accessText, onNavigate, onDownload, onSend, onMore, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [url, setUrl] = useState<string>();
  const [hasFailed, setHasFailed] = useState(false);
  const kind = node ? kindOfFile(node.mime, node.name) : 'other';
  const canPreview = Boolean(node) && kind !== 'other' && node.size <= maxBytes;

  useEffect(() => {
    setUrl(undefined);
    setHasFailed(false);
    if (!container || !node || !canPreview) return undefined;
    let isActual = true;
    let created: string | undefined;
    void callParvane('parvaneCloudOpenBlob', { container, node: node.id }).then((blob) => {
      if (!isActual) return;
      if (!(blob instanceof Blob)) {
        setHasFailed(true);
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
  }, [container, node, canPreview, kind]);

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
  const handleDownload = useLastCallback(() => onDownload(container!, node!));
  const handleSend = useLastCallback(() => onSend?.(container!, node!));
  const handleMore = useLastCallback(() => onMore?.(container!, node!));

  const isBig = canPreview && !hasFailed && (kind === 'photo' || kind === 'video' || kind === 'pdf');
  const dateText = node?.mtime
    ? new Date(node.mtime).toLocaleDateString(lang.code, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  return (
    <PvSheet
      isOpen={isOpen}
      title={node?.name}
      isWide={isBig}
      headBefore={hasNeighbours && (
        <button type="button" className={kit.ib} aria-label={lang('KnowledgeFilesPrevious')} onClick={handlePrevious}>
          <PvIcon name="left" />
        </button>
      )}
      headAfter={hasNeighbours && (
        <button type="button" className={kit.ib} aria-label={lang('KnowledgeFilesNext')} onClick={handleNext}>
          <PvIcon name="right" />
        </button>
      )}
      onClose={onClose}
    >
      <div className={buildClassName(styles.previewArt, isBig && styles.previewArtBig)} data-preview-kind={kind}>
        {(!canPreview || hasFailed) && (
          <div className={styles.previewStub}>
            <PvIcon name={kind === 'photo' ? 'image' : 'note'} className={styles.previewStubIcon} />
            <span>{lang('ParvaneCloudPreviewUnavailable')}</span>
          </div>
        )}
        {canPreview && !hasFailed && !url && <Loading />}
        {url && kind === 'photo' && <img className={styles.previewMedia} src={url} alt={node!.name} />}
        {url && kind === 'video' && <video className={styles.previewMedia} src={url} controls autoPlay />}
        {url && kind === 'audio' && <audio className={styles.previewAudio} src={url} controls autoPlay />}
        {url && kind === 'pdf' && <iframe className={styles.previewFrame} src={url} title={node!.name} />}
      </div>
      {node && (
        <div className={styles.previewFacts}>
          <span className={kit.muted}>{lang('ParvaneCloudSize')}</span>
          <span>{formatFileSize(lang, node.size)}</span>
          <span className={kit.muted}>{lang('ParvaneCloudModified')}</span>
          <span>{dateText}</span>
          {folderText && (
            <>
              <span className={kit.muted}>{lang('ParvaneCloudFolder')}</span>
              <span dir="auto">{folderText}</span>
            </>
          )}
          {accessText && (
            <>
              <span className={kit.muted}>{lang('ParvaneCloudShare')}</span>
              <span dir="auto">{accessText}</span>
            </>
          )}
        </div>
      )}
      <div className={kit.sheetButtons}>
        <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} onClick={handleDownload}>
          <PvIcon name="download" isSmall />
          {lang('ParvaneCloudDownload')}
        </button>
        {onSend && (
          <button type="button" className={kit.btn} onClick={handleSend}>
            <PvIcon name="chat" isSmall />
            {lang('KnowledgeFilesToChat')}
          </button>
        )}
        {onMore && (
          <button type="button" className={kit.btn} onClick={handleMore}>
            <PvIcon name="dots" isSmall />
            {lang('MenuMore')}
          </button>
        )}
      </div>
      <div className={buildClassName(kit.muted, kit.small)}>{lang('KnowledgeFilesDecryptedHere')}</div>
    </PvSheet>
  );
};

export default memo(CloudPreview);
