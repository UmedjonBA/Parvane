import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { CloudNode } from './cloudModel';

import { callApi } from '../../../api/gramjs';
import { kindOfFile } from './cloudModel';

import useLang from '../../../hooks/useLang';

import Button from '../../ui/Button';
import Loading from '../../ui/Loading';
import Modal from '../../ui/Modal';

import styles from './Cloud.module.scss';

type OwnProps = {
  container?: string;
  node?: CloudNode;
  maxBytes: number;
  onDownload: (container: string, node: CloudNode) => void;
  onClose: NoneToVoidFunction;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Просмотр файла облака без скачивания на диск: фото, видео, аудио и PDF —
// средствами браузера из расшифрованного содержимого; остальное — скачать
const CloudPreview = ({
  container, node, maxBytes, onDownload, onClose,
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

  return (
    <Modal
      isOpen={isOpen}
      title={node?.name}
      className={styles.preview}
      hasCloseButton
      onClose={onClose}
    >
      <div className={styles.previewBody} data-preview-kind={kind}>
        {(!canPreview || hasFailed) && (
          <div className={styles.previewStub}>{lang('ParvaneCloudPreviewUnavailable')}</div>
        )}
        {canPreview && !hasFailed && !url && <Loading />}
        {url && kind === 'photo' && <img className={styles.previewMedia} src={url} alt={node!.name} />}
        {url && kind === 'video' && <video className={styles.previewMedia} src={url} controls autoPlay />}
        {url && kind === 'audio' && <audio className={styles.previewAudio} src={url} controls autoPlay />}
        {url && kind === 'pdf' && <iframe className={styles.previewFrame} src={url} title={node!.name} />}
      </div>
      <div className="dialog-buttons">
        {isOpen && (
          <Button className="confirm-dialog-button" isText onClick={() => onDownload(container!, node!)}>
            {lang('ParvaneCloudDownload')}
          </Button>
        )}
        <Button className="confirm-dialog-button" isText onClick={onClose}>{lang('ParvaneCloudClose')}</Button>
      </div>
    </Modal>
  );
};

export default memo(CloudPreview);
