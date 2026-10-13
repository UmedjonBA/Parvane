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
  // Карточка на экране достаточно крупна для полного файла; мелкой хватает миниатюры
  isLarge: boolean;
};

// Столько карточка, ушедшая с экрана, ещё держит свою картинку: прокрутка туда-обратно не читает файл заново
const OFFSCREEN_KEEP_MS = 4000;

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Содержимое карточки файла облака: у картинки — она сама в полном качестве (миниатюра облака, та же, что в
// «Файлах», стоит заглушкой, пока файл читается, и остаётся при настройке «миниатюрами» и у мелкой на экране
// карточки), у прочих — значок, имя и размер. Полный файл читается, пока карточка на экране, и отпускается
// через паузу после ухода с него. Адрес миниатюры хранит провайдер, адрес картинки — общий кэш холста с
// очередью чтения и пределом памяти: смена масштаба и перерисовки ничего не качают заново
const CanvasFileBody = ({
  path, container, node, quality, isLarge,
}: OwnProps) => {
  const lang = useLang();
  const ref = useRef<HTMLDivElement>();
  const [isSeen, setIsSeen] = useState(false);
  const [isOnScreen, setIsOnScreen] = useState(false);
  const [thumbUrl, setThumbUrl] = useState<string>();
  const [fullUrl, setFullUrl] = useState<string>();
  const nodeId = node?.id;
  const thumbId = node?.thumb?.fileId;
  const fileId = node?.blob?.fileId;
  const isFull = isLarge && canvasImageSource(node, quality) === 'full';

  // Наблюдатель живёт всё время: `isSeen` — карточка показывалась хоть раз (миниатюра остаётся), `isOnScreen` —
  // она на экране сейчас; уход с экрана засчитывается через паузу
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setIsSeen(true);
      setIsOnScreen(true);
      return undefined;
    }
    let leaveTimer: number | undefined;
    const observer = new IntersectionObserver((entries) => {
      const isIn = entries.some((entry) => entry.isIntersecting);
      window.clearTimeout(leaveTimer);
      if (isIn) {
        setIsSeen(true);
        setIsOnScreen(true);
        return;
      }
      leaveTimer = window.setTimeout(() => setIsOnScreen(false), OFFSCREEN_KEEP_MS);
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(leaveTimer);
      observer.disconnect();
    };
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
    if (!isOnScreen || !isFull || !container || !nodeId || !fileId) return undefined;
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
  }, [isOnScreen, isFull, container, nodeId, fileId]);

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
