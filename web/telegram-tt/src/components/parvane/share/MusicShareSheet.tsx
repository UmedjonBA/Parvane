import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicCatalogTrack } from '../../../api/parvane/musicApi';
import type { SharedMusicLink, SharedPayload } from '../../../util/shareTarget';

import { openNote } from '../../../util/parvaneSection';
import { buildSharedMusicQuery, buildSharedText } from '../../../util/shareTarget';
import { putJob, startFetch } from '../music/fetch/musicFetch';
import { callMusic, catalogNetworkTrack, playTracks } from '../music/musicPlayer';
import { goToMusicView } from '../music/musicView';
import useMusicData from '../music/useMusicData';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from '../music/MusicCover';
import MusicSendDialog from '../music/MusicSendDialog';
import PvSheet from '../notes/PvSheet';
import PvSkeleton from '../notes/PvSkeleton';

import styles from './MusicShareSheet.module.scss';

type OwnProps = {
  shared: SharedPayload;
  link: SharedMusicLink;
  currentUserId?: string;
  onClose: NoneToVoidFunction;
};

const SERVICE_NAMES = {
  spotify: 'Spotify', yandex: 'Яндекс Музыка', youtube: 'YouTube', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp',
} as const;

// Parvane (макет «Музыки» 23 ноя, доска `MusicChat-04`): «Поделиться в Parvane» ссылкой на музыку. Ссылки Spotify и
// Яндекс Музыки ищутся в каталоге по названию из подписи — карточка «каталог · исполнитель · нашли в каталоге»;
// YouTube, SoundCloud, Bandcamp — скачиваются как есть. Действия: «Добавить на сервер · в «Любимое»», «Слушать из
// сети» (отрывок каталога), «Отправить в чат», «В заметку»
const MusicShareSheet = ({
  shared, link, currentUserId, onClose,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const isDirect = link.kind === 'youtube' || link.kind === 'soundcloud' || link.kind === 'bandcamp';
  const query = buildSharedMusicQuery(shared);
  const { data: found, isFailed } = useMusicData(
    !isDirect && query ? `share-catalog:${query}` : undefined,
    () => callMusic('parvaneMusicCatalogSearch', { query }),
  );
  const [isSending, setIsSending] = useState(false);
  const track: MusicCatalogTrack | undefined = found?.tracks[0];

  const handleAdd = useLastCallback(async () => {
    onClose();
    if (isDirect) {
      const job = await callMusic('parvaneMusicFetchLink', { url: link.url, isStar: true }).catch(() => undefined);
      if (job) putJob(job);
      showNotification({ message: lang(job ? 'MusicFetchStarted' : 'MusicFetchFailedShort') });
      return;
    }
    if (!track) return;
    const result = await startFetch(track, { isStar: true });
    const key = result === 'ok' ? 'MusicFetchStarted'
      : result === 'limit' ? 'MusicFetchLimit' : 'MusicFetchFailedShort';
    showNotification({ message: lang(key) });
  });
  const handleListen = useLastCallback(() => {
    if (!track) return;
    onClose();
    playTracks([catalogNetworkTrack(track)], 0, { source: { kind: 'search', name: track.artist } });
    goToMusicView({ kind: 'search' });
  });
  const handleSend = useLastCallback(() => setIsSending(true));
  const handleSendClose = useLastCallback(() => {
    setIsSending(false);
    onClose();
  });
  const handleNote = useLastCallback(async () => {
    const { saveSharedToNote } = await import('./shareActions');
    const title = await saveSharedToNote(
      shared, buildSharedText(shared), lang('KnowledgeVaultName'), lang('MessageNoteTitle'), currentUserId,
    ).catch(() => undefined);
    onClose();
    if (!title) {
      showNotification({ message: lang('ShareFailed') });
      return;
    }
    openNote(title);
    showNotification({ message: lang('ShareSavedToNote', { title }) });
  });

  function renderAction(icon: 'cloudAdd' | 'play' | 'send' | 'note', title: string, onClick: NoneToVoidFunction,
    sub?: string, isDisabled?: boolean) {
    return (
      <button type="button" className={styles.action} disabled={isDisabled} onClick={onClick}>
        <ParvaneIcon name={icon} className={styles.actionIcon} />
        <span className={styles.actionText}>
          <span>{title}</span>
          {sub && <span className={styles.actionSub}>{sub}</span>}
        </span>
      </button>
    );
  }

  function renderCard() {
    if (isDirect) {
      return (
        <div className={styles.card}>
          <MusicCover toneId={link.url} size={52} className={styles.cover} />
          <span className={styles.cardText}>
            <span className={styles.cardTitle}>{shared.title || query || link.url}</span>
            <span className={styles.cardSub}>{lang('MusicShareAsIs', { service: SERVICE_NAMES[link.kind] })}</span>
          </span>
        </div>
      );
    }
    if (!found) return isFailed ? <p className={styles.hint}>{lang('MusicCatalogDown')}</p> : <PvSkeleton />;
    if (!track) return <p className={styles.hint}>{lang('MusicShareNotFound')}</p>;
    return (
      <div className={styles.card} data-music-share-track={track.ref}>
        <MusicCover coverUrl={track.coverUrl} toneId={track.ref || track.title} size={52} className={styles.cover} />
        <span className={styles.cardText}>
          <span className={styles.cardTitle}>{track.title}</span>
          <span className={styles.cardSub}>
            <span className={styles.tag}>{lang('MusicInCatalogShort')}</span>
            {`${track.artist} · ${lang('MusicShareFoundInCatalog')}`}
          </span>
        </span>
      </div>
    );
  }

  const canAdd = isDirect || Boolean(track);
  return (
    <>
      <PvSheet
        isOpen={!isSending}
        title={lang('ShareTitle')}
        subtitle={lang('MusicShareLinkOf', { service: SERVICE_NAMES[link.kind] })}
        headBefore={<span className={styles.appIcon} aria-hidden>P</span>}
        onClose={onClose}
      >
        <div className={styles.root} data-music-share>
          {renderCard()}
          <div className={styles.actions}>
            {renderAction('cloudAdd', lang('MusicAddToServer'), handleAdd, lang('MusicShareToFavorites'), !canAdd)}
            {!isDirect && renderAction('play', lang('MusicListenFromWeb'), handleListen, undefined, !track)}
            {!isDirect && renderAction('send', lang('MusicSendToChat'), handleSend, undefined, !track)}
            {renderAction('note', lang('MusicShareToNote'), handleNote)}
          </div>
          <p className={styles.hint}>{lang('MusicShareHint')}</p>
        </div>
      </PvSheet>
      {isSending && track && <MusicSendDialog catalog={track} onClose={handleSendClose} />}
    </>
  );
};

export default memo(MusicShareSheet);
