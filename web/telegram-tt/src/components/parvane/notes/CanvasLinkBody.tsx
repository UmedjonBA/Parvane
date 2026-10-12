import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { LinkPreview, LinkPreviewSource } from './notesCanvasFiles';

import { callApi } from '../../../api/gramjs';
import { buildLinkPreview, hasPreviewContent, hostOf } from './notesCanvasFiles';

import useLang from '../../../hooks/useLang';

import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';

type OwnProps = {
  url: string;
};

type Loaded = LinkPreview & { imageUrl?: string };

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Превью по адресу — в памяти до конца сеанса; в файл холста оно не пишется
const previews = new Map<string, Promise<Loaded>>();

function loadPreview(url: string) {
  let cached = previews.get(url);
  if (cached) return cached;
  cached = callParvane('parvaneLinkPreview', { url }).catch(() => undefined).then((raw) => {
    const preview = buildLinkPreview(url, raw as LinkPreviewSource | undefined);
    // Недоступное превью не запоминается: при следующем открытии холста будет новая попытка
    if (!hasPreviewContent(preview)) previews.delete(url);
    return { ...preview, imageUrl: imageUrlOf(preview) };
  });
  previews.set(url, cached);
  return cached;
}

function imageUrlOf(preview: LinkPreview) {
  if (!preview.imageBase64 || !preview.imageMime) return undefined;
  try {
    const bytes = Uint8Array.from(atob(preview.imageBase64), (char) => char.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: preview.imageMime }));
  } catch (err) {
    return undefined;
  }
}

// Содержимое карточки-ссылки: картинка, заголовок и описание страницы (их добывает шард `preview` —
// браузер на чужой сайт не ходит), узел сайта и кнопка «открыть в новой вкладке»
const CanvasLinkBody = ({ url }: OwnProps) => {
  const lang = useLang();
  const [preview, setPreview] = useState<Loaded>();

  useEffect(() => {
    let isActual = true;
    setPreview(undefined);
    void loadPreview(url).then((loaded) => {
      if (isActual) setPreview(loaded);
    });
    return () => {
      isActual = false;
    };
  }, [url]);

  const state = !preview ? 'loading' : hasPreviewContent(preview) ? 'ready' : 'none';

  return (
    <div className={styles.canvasLink} data-canvas-link={state}>
      {preview?.imageUrl && (
        <img className={styles.canvasLinkImage} src={preview.imageUrl} alt="" draggable={false} />
      )}
      <div className={styles.canvasLinkText}>
        {state === 'loading' && (
          <>
            <i className={styles.canvasSkeleton} />
            <i className={styles.canvasSkeleton} />
          </>
        )}
        {preview?.title && <div className={styles.canvasLinkTitle}>{preview.title}</div>}
        {preview?.description && <div className={styles.canvasLinkDescription}>{preview.description}</div>}
        {state === 'none' && <div className={styles.canvasLinkUrl}>{url}</div>}
      </div>
      <div className={styles.canvasLinkFoot}>
        <PvIcon name="link" isSmall />
        <span className={styles.canvasLinkHost}>{preview?.siteName || hostOf(url)}</span>
        <a
          className={styles.canvasLinkOpen}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={lang('KnowledgeCanvasLinkOpen')}
          aria-label={lang('KnowledgeCanvasLinkOpen')}
          data-canvas-open
        >
          <PvIcon name="open" isSmall />
        </a>
      </div>
    </div>
  );
};

export default memo(CanvasLinkBody);
