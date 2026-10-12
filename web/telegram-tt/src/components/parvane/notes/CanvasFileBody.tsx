import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudNode } from '../cloud/cloudModel';

import { callApi } from '../../../api/gramjs';
import { fileTypeLabel } from '../cloud/cloudModel';
import { fileNameOfPath, formatCardSize } from './notesCanvasFiles';

import useLang from '../../../hooks/useLang';

import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';

type OwnProps = {
  path: string;
  container?: string;
  // Файл личного диска по пути карточки; нет — файл удалён, переименован либо перенесён
  node?: CloudNode;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Содержимое карточки файла облака: у картинки — миниатюра (та же расшифрованная миниатюра, что в «Файлах»;
// читается, когда карточка показалась на экране, адрес хранит провайдер), у прочих — значок, имя и размер
const CanvasFileBody = ({ path, container, node }: OwnProps) => {
  const lang = useLang();
  const ref = useRef<HTMLDivElement>();
  const [thumbUrl, setThumbUrl] = useState<string>();
  const nodeId = node?.id;
  const thumbId = node?.thumb?.fileId;

  useEffect(() => {
    setThumbUrl(undefined);
    if (!container || !nodeId || !thumbId) return undefined;
    let isActual = true;
    const load = () => {
      void callParvane('parvaneCloudThumb', { container, node: nodeId }).then((url) => {
        if (isActual && typeof url === 'string') setThumbUrl(url);
      }).catch(() => undefined);
    };
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        isActual = false;
      };
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    });
    observer.observe(element);
    return () => {
      isActual = false;
      observer.disconnect();
    };
  }, [container, nodeId, thumbId]);

  const name = node?.name || fileNameOfPath(path);
  const state = !node ? 'missing' : thumbUrl ? 'image' : 'file';

  return (
    <div ref={ref} className={styles.canvasFile} data-canvas-file={state}>
      {thumbUrl ? (
        <img className={styles.canvasFileImage} src={thumbUrl} alt="" draggable={false} />
      ) : (
        <div className={styles.canvasFileIcon}>
          <PvIcon name={node ? 'file' : 'x'} />
          {node && <span className={styles.canvasFileType}>{fileTypeLabel(node.name)}</span>}
        </div>
      )}
      <div className={styles.canvasFileFoot}>
        <span className={styles.canvasFileName}>{name}</span>
        <span className={styles.canvasFileSize}>
          {node ? formatCardSize(node.size) : lang('KnowledgeCanvasFileMissing')}
        </span>
      </div>
    </div>
  );
};

export default memo(CanvasFileBody);
