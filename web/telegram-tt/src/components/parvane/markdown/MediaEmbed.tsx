import type { TeactNode } from '../../../lib/teact/teact';
import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudFileKind } from '../cloud/cloudModel';

import buildClassName from '../../../util/buildClassName';
import { fileTypeLabel } from '../cloud/cloudModel';
import { formatCardSize } from '../notes/notesCanvasFiles';
import { CANVAS_IMAGE_MAX_BYTES, getCanvasImageCache } from '../notes/notesCanvasImages';

import useAppLayout from '../../../hooks/useAppLayout';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from '../notes/PvIcon';

import styles from './MediaEmbed.module.scss';

type OwnProps = {
  name: string;
  alt?: string;
  // Файла нет (удалён, переименован, не вошёл в статью)
  isMissing?: boolean;
  kind?: CloudFileKind;
  size?: number;
  // Ключ кэша картинок — версия содержимого файла
  cacheKey?: string;
  load?: () => Promise<Blob | undefined>;
  loadThumb?: () => Promise<string | undefined>;
  onDownload?: NoneToVoidFunction;
};

// Столько встроенный файл, ушедший с экрана, ещё держит картинку
const OFFSCREEN_KEEP_MS = 4000;
// Видео и аудио читаются целиком в память: больше этого — только скачать
const PLAYER_MAX_BYTES_DESKTOP = 256 * 1024 * 1024;
const PLAYER_MAX_BYTES_MOBILE = 64 * 1024 * 1024;

// Встроенный файл заметки и статьи (этап 6 плана 15 окт 2026): картинка — сама (миниатюра — пока читается),
// видео и аудио — проигрыватель по нажатию (до того — миниатюра и кнопка), прочее — карточка с «Скачать»
const MediaEmbed = ({
  name, alt, isMissing, kind = 'other', size = 0, cacheKey, load, loadThumb, onDownload,
}: OwnProps) => {
  const lang = useLang();
  const { isMobile } = useAppLayout();
  const ref = useRef<HTMLDivElement>();
  const [isOnScreen, setIsOnScreen] = useState(false);
  const [thumbUrl, setThumbUrl] = useState<string>();
  const [imageUrl, setImageUrl] = useState<string>();
  const [playerUrl, setPlayerUrl] = useState<string>();
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const isPlayable = kind === 'video' || kind === 'audio';
  const isTooLarge = isPlayable && size > (isMobile ? PLAYER_MAX_BYTES_MOBILE : PLAYER_MAX_BYTES_DESKTOP);
  const isImage = kind === 'photo' && size <= CANVAS_IMAGE_MAX_BYTES;

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setIsOnScreen(true);
      return undefined;
    }
    let leaveTimer: number | undefined;
    const observer = new IntersectionObserver((entries) => {
      window.clearTimeout(leaveTimer);
      if (entries.some((entry) => entry.isIntersecting)) {
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
    if (!isOnScreen || !loadThumb || isMissing) return undefined;
    let isActual = true;
    void loadThumb().then((url) => {
      if (isActual && url) setThumbUrl(url);
    }).catch(() => undefined);
    return () => {
      isActual = false;
    };
  }, [isOnScreen, loadThumb, isMissing]);

  useEffect(() => {
    setImageUrl(undefined);
    if (!isOnScreen || !isImage || !load || !cacheKey || isMissing) return undefined;
    let isActual = true;
    const cache = getCanvasImageCache();
    void cache.acquire(cacheKey, load).then((url) => {
      if (isActual && url) setImageUrl(url);
    });
    return () => {
      isActual = false;
      cache.release(cacheKey);
    };
  }, [isOnScreen, isImage, load, cacheKey, isMissing]);

  // Адрес проигрывателя живёт, пока встроенный файл на экране страницы
  useEffect(() => () => {
    if (playerUrl) URL.revokeObjectURL(playerUrl);
  }, [playerUrl]);

  const handlePlay = useLastCallback(async () => {
    if (!load || state === 'loading') return;
    setState('loading');
    const blob = await load().catch(() => undefined);
    if (!blob) {
      setState('failed');
      return;
    }
    setState('idle');
    setPlayerUrl(URL.createObjectURL(blob));
  });

  const caption = alt && alt !== name ? alt : undefined;

  const renderContent = (): [string, TeactNode] => {
    if (isMissing) {
      return ['missing', (
        <div className={buildClassName(styles.card, styles.missing)}>
          <PvIcon name="x" />
          <span className={styles.cardName}>{name}</span>
          <span className={styles.cardMeta}>{lang('KnowledgeCanvasFileMissing')}</span>
        </div>
      )];
    }
    if (kind === 'photo' && (imageUrl || thumbUrl || isImage)) {
      const url = imageUrl || thumbUrl;
      return [imageUrl ? 'image' : url ? 'thumb' : 'loading', (
        <figure className={styles.figure}>
          {url ? <img className={styles.image} src={url} alt={caption || name} />
            : <span className={styles.placeholder} />}
          {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
        </figure>
      )];
    }
    if (playerUrl) {
      return ['player', (
        <figure className={styles.figure}>
          {kind === 'video' ? (
            <video className={styles.video} src={playerUrl} controls autoPlay playsInline />
          ) : (
            <audio className={styles.audio} src={playerUrl} controls autoPlay />
          )}
          <figcaption className={styles.caption}>{caption || name}</figcaption>
        </figure>
      )];
    }
    if (isPlayable && !isTooLarge && load) {
      return [state === 'failed' ? 'failed' : kind, (
        <figure className={styles.figure}>
          <button
            type="button"
            className={buildClassName(styles.poster, kind === 'audio' && styles.posterAudio)}
            aria-label={`${lang('KnowledgeEmbedPlay')}: ${name}`}
            disabled={state === 'loading'}
            onClick={handlePlay}
          >
            {thumbUrl && kind === 'video' && <img className={styles.posterImage} src={thumbUrl} alt="" />}
            <span className={styles.playButton}>
              <PvIcon name={state === 'loading' ? 'refresh' : 'play'} />
            </span>
            {kind === 'audio' && <span className={styles.cardName}>{name}</span>}
          </button>
          <figcaption className={styles.caption}>
            {state === 'failed' ? lang('KnowledgeEmbedFailed') : caption || `${name} · ${formatCardSize(size)}`}
          </figcaption>
        </figure>
      )];
    }
    return ['file', (
      <div className={styles.card}>
        <span className={styles.cardIcon}>
          <PvIcon name="file" />
          <span className={styles.cardType}>{fileTypeLabel(name)}</span>
        </span>
        <span className={styles.cardName}>{name}</span>
        <span className={styles.cardMeta}>{formatCardSize(size)}</span>
        {onDownload && (
          <button
            type="button"
            className={styles.cardButton}
            aria-label={`${lang('KnowledgeEmbedDownload')}: ${name}`}
            onClick={onDownload}
          >
            <PvIcon name="download" isSmall />
          </button>
        )}
      </div>
    )];
  };

  const [embedState, content] = renderContent();
  // Корень постоянный: наблюдатель видимости следит за ним при любой смене вида
  return <div ref={ref} className={styles.root} data-embed-state={embedState}>{content}</div>;
};

export default memo(MediaEmbed);
