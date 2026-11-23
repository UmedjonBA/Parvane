import { memo } from '../../../lib/teact/teact';

import type { MusicDislike } from '../../../api/parvane/musicApi';

import { callMusic } from './musicPlayer';
import { goBackMusic } from './musicView';
import useMusicData from './useMusicData';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCover from './MusicCover';
import MusicSectionHead from './MusicSectionHead';

import styles from './MusicLibrary.module.scss';

type OwnProps = {
  isPhone?: boolean;
};

// Parvane (макет «Музыки» 23 ноя, доска `MusicLibrary`, «Не нравится»): треки и исполнители, которые не попадают в
// миксы; «Вернуть» снимает пометку
const MusicDislikesView = ({ isPhone }: OwnProps) => {
  const lang = useLang();
  const { data, isFailed, reload, patch } = useMusicData('dislikes', () => callMusic('parvaneMusicDislikes'));

  const handleUndo = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const index = Number(e.currentTarget.dataset.index);
    const item = data?.[index];
    if (!item) return;
    patch((previous) => previous.filter((one) => one !== item));
    const isDone = await callMusic('parvaneMusicDislike', {
      trackId: item.trackId || undefined,
      ref: item.ref || undefined,
      artist: item.artist,
      title: item.kind === 'track' ? item.title : undefined,
      isUndo: true,
    }).then(() => true, () => false);
    if (!isDone) reload();
  });

  function describe(item: MusicDislike) {
    return item.kind === 'artist'
      ? lang('MusicDislikedArtist')
      : [item.artist, lang('MusicKindTrackLower')].filter(Boolean).join(' · ');
  }

  function renderBody() {
    if (!data) return isFailed ? <div role="alert">{lang('MusicLoadFailed')}</div> : <PvSkeleton onRetry={reload} />;
    if (!data.length) return <PvEmpty text={lang('MusicDislikesEmpty')} data-music-empty="dislikes" />;
    return (
      <div className={styles.list} data-music-dislikes>
        {data.map((item, index) => (
          <div key={`${item.kind}:${item.trackId || item.ref || item.artist}:${item.title}`} className={styles.row}>
            <MusicCover
              toneId={item.trackId || item.ref || item.artist}
              size={46}
              glyph={item.kind === 'artist' ? 'mic' : 'music'}
              isRound={item.kind === 'artist'}
              className={styles.rowCover}
            />
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{item.kind === 'artist' ? item.artist : item.title}</span>
              <span className={styles.rowSub}>{describe(item)}</span>
            </span>
            <button type="button" className={styles.rowAction} data-index={index} onClick={handleUndo}>
              {lang('MusicRestore')}
            </button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.page} data-music-view-dislikes>
      <MusicSectionHead
        title={lang('MusicDislikes')}
        barSubtitle={lang('MusicDislikesHint')}
        isPhone={isPhone}
        onBack={goBackMusic}
      />
      {renderBody()}
    </div>
  );
};

export default memo(MusicDislikesView);
