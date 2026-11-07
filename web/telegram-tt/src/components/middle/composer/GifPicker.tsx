import { memo, useEffect, useRef } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiVideo } from '../../../api/types';

import { SLIDE_TRANSITION_DURATION } from '../../../config';
import { selectCurrentMessageList, selectIsChatWithSelf } from '../../../global/selectors';
import { IS_TOUCH_ENV } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import { openSystemFilesDialog } from '../../../util/systemFilesDialog';
import { callApi } from '../../../api/gramjs';

import useFlag from '../../../hooks/useFlag';
import { useIntersectionObserver } from '../../../hooks/useIntersectionObserver';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useAsyncRendering from '../../right/hooks/useAsyncRendering';

import GifButton from '../../common/GifButton';
import Icon from '../../common/icons/Icon';
import Loading from '../../ui/Loading';
import Transition from '../../ui/Transition.tsx';

import styles from './GifPicker.module.scss';

type OwnProps = {
  className: string;
  loadAndPlay: boolean;
  canSendGifs?: boolean;
  onGifSelect?: (gif: ApiVideo, isSilent?: boolean, shouldSchedule?: boolean) => void;
  onGifAddCaption?: (gif: ApiVideo) => void;
};

type StateProps = {
  savedGifs?: ApiVideo[];
  isSavedMessages?: boolean;
};

type GifUploadResult = { isOk: true } | { error: 'TOO_BIG' | 'UNSUPPORTED' | 'FAILED' };

const INTERSECTION_DEBOUNCE = 300;
// GIF-1: свой GIF из файла — анимированный .gif, .mp4 или .webm
const GIF_UPLOAD_ACCEPT = '.gif,.mp4,.webm,image/gif,video/mp4,video/webm';
const GIF_UPLOAD_ERROR_KEYS = {
  TOO_BIG: 'ParvaneUploadGifTooBig',
  UNSUPPORTED: 'ParvaneUploadGifUnsupported',
  FAILED: 'ParvaneUploadGifFailed',
} as const;

const GifPicker = ({
  className,
  loadAndPlay,
  canSendGifs,
  savedGifs,
  isSavedMessages,
  onGifSelect,
  onGifAddCaption,
}: OwnProps & StateProps) => {
  const { loadSavedGifs, saveGif, showNotification } = getActions();

  const containerRef = useRef<HTMLDivElement>();

  const {
    observe: observeIntersection,
  } = useIntersectionObserver({ rootRef: containerRef, debounceMs: INTERSECTION_DEBOUNCE });

  useEffect(() => {
    if (loadAndPlay) {
      loadSavedGifs();
    }
  }, [loadAndPlay, loadSavedGifs]);

  const handleUnsaveClick = useLastCallback((gif: ApiVideo) => {
    saveGif({ gif, shouldUnsave: true });
  });

  const [isUploading, markUploading, unmarkUploading] = useFlag();

  const canRenderContents = useAsyncRendering([], SLIDE_TRANSITION_DURATION);
  const isLoading = canSendGifs && (!canRenderContents || !savedGifs);
  const lang = useLang();

  const handleUploadFile = useLastCallback(async (file: File) => {
    markUploading();
    // Метод провайдера Parvane — вне типов MTProto-API
    const callParvane = callApi as unknown as (
      method: string, args: unknown,
    ) => Promise<GifUploadResult | undefined>;
    const result = await callParvane('parvaneUploadGif', { file });
    unmarkUploading();
    if (result && 'isOk' in result) return;
    showNotification({ message: lang(GIF_UPLOAD_ERROR_KEYS[result?.error || 'FAILED']) });
  });

  const handleUploadClick = useLastCallback(() => {
    openSystemFilesDialog(GIF_UPLOAD_ACCEPT, (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) void handleUploadFile(file);
    }, true);
  });

  function renderUploadButton() {
    return (
      <button
        key="upload"
        type="button"
        className={buildClassName(styles.gifButton, styles.uploadButton)}
        disabled={isUploading}
        aria-label={lang('ParvaneUploadGif')}
        data-gif-upload
        onClick={handleUploadClick}
      >
        <Icon name="add" className={styles.uploadIcon} />
        <span className={styles.uploadLabel}>
          {lang(isUploading ? 'ParvaneUploadGifProgress' : 'ParvaneUploadGif')}
        </span>
      </button>
    );
  }

  return (
    <Transition
      ref={containerRef}
      className={buildClassName(styles.root, className, IS_TOUCH_ENV ? 'no-scrollbar' : 'custom-scroll')}
      slideClassName={styles.grid}
      activeKey={isLoading ? 0 : 1}
      name="fade"
      shouldCleanup
    >
      {!canSendGifs ? (
        <div className={styles.pickerDisabled}>{lang('GifPickerBlocked')}</div>
      ) : canRenderContents && savedGifs && savedGifs.length ? (
        [renderUploadButton(), ...savedGifs.map((gif) => (
          <GifButton
            key={gif.id}
            gif={gif}
            className={styles.gifButton}
            observeIntersection={observeIntersection}
            isDisabled={!loadAndPlay}
            isSavedMessages={isSavedMessages}
            onClick={canSendGifs ? onGifSelect : undefined}
            onUnsaveClick={handleUnsaveClick}
            onAddCaption={canSendGifs ? onGifAddCaption : undefined}
          />
        ))]
      ) : canRenderContents && savedGifs ? (
        [renderUploadButton(), <div key="empty" className={styles.emptyHint}>{lang('GifPickerEmpty')}</div>]
      ) : (
        <Loading className={styles.loading} color="yellow" />
      )}
    </Transition>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { chatId } = selectCurrentMessageList(global) || {};
    const isSavedMessages = Boolean(chatId) && selectIsChatWithSelf(global, chatId);
    return {
      savedGifs: global.gifs.saved.gifs,
      isSavedMessages,
    };
  },
)(GifPicker));
