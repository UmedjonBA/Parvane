import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudNode } from '../cloud/cloudModel';
import type { CanvasImageQuality } from './notesCanvasImages';

import { callApi } from '../../../api/gramjs';
import { fileTypeLabel } from '../cloud/cloudModel';
import { fileNameOfPath, formatCardSize } from './notesCanvasFiles';
import { canvasImageSource, getCanvasImageCache } from './notesCanvasImages';

import useLang from '../../../hooks/useLang';

import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';

type OwnProps = {
  path: string;
  container?: string;
  // Файл личного диска по пути карточки; нет — файл удалён, переименован либо перенесён
  node?: CloudNode;
  // Настройка устройства: картинка — сам файл либо миниатюра облака (экономия трафика)
  quality: CanvasImageQuality;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Содержимое карточки файла облака: у картинки — она сама в полном качестве (миниатюра облака, та же, что в
// «Файлах», стоит заглушкой, пока файл читается, и остаётся при настройке «миниатюрами»), у прочих — значок,
// имя и размер. Читается, когда карточка показалась на экране. Адрес миниатюры хранит провайдер, адрес
// картинки — общий кэш холста: смена масштаба и перерисовки ничего не качают заново
const CanvasFileBody = ({
  path, container, node, quality,
}: OwnProps) => {
  const lang = useLang();
  const ref = useRef<HTMLDivElement>();
  const [isSeen, setIsSeen] = useState(false);
  const [thumbUrl, setThumbUrl] = useState<string>();
  const [fullUrl, setFullUrl] = useState<string>();
  const nodeId = node?.id;
  const thumbId = node?.thumb?.fileId;
  const fileId = node?.blob?.fileId;
  const isFull = canvasImageSource(node, quality) === 'full';

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setIsSeen(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setIsSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setThumbUrl(undefined);
    if (!isSeen || !container || !nodeId || !thumbId) return undefined;
    let isActual = true;
    void callParvane('parvaneCloudThumb', { container, node: nodeId }).then((url) => {
      if (isActual && typeof url === 'string') setThumbUrl(url);
    }).catch(() => undefined);
    return () => {
      isActual = false;
    };
  }, [isSeen, container, nodeId, thumbId]);

  useEffect(() => {
    setFullUrl(undefined);
    if (!isSeen || !isFull || !container || !nodeId || !fileId) return undefined;
    let isActual = true;
    const cache = getCanvasImageCache();
    void cache.acquire(fileId, async () => {
      const blob = await callParvane('parvaneCloudOpenBlob', { container, node: nodeId });
      return blob instanceof Blob ? blob : undefined;
    }).then((url) => {
      if (isActual && url) setFullUrl(url);
    });
    return () => {
      isActual = false;
      cache.release(fileId);
    };
  }, [isSeen, isFull, container, nodeId, fileId]);

  // Не прочитавшаяся картинка (нет связи) остаётся миниатюрой
  const imageUrl = fullUrl || thumbUrl;
  const name = node?.name || fileNameOfPath(path);
  const state = !node ? 'missing' : imageUrl ? 'image' : 'file';

  return (
    <div ref={ref} className={styles.canvasFile} data-canvas-file={state}>
      {imageUrl ? (
        <img
          className={styles.canvasFileImage}
          src={imageUrl}
          alt=""
          draggable={false}
          data-canvas-image={fullUrl ? 'full' : 'thumb'}
        />
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
