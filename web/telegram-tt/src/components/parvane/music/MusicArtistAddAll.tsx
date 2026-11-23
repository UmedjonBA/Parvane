import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicCatalogArtist, MusicReleaseKind } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { addFetchFollowUp, putJob } from './fetch/musicFetch';
import { callMusic } from './musicPlayer';
import useMusicData from './useMusicData';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSegment from '../notes/PvSegment';
import PvSheet from '../notes/PvSheet';
import PvSkeleton from '../notes/PvSkeleton';
import MusicPlaylistPicker from './MusicPlaylistPicker';

import kit from '../notes/PvKit.module.scss';
import styles from './MusicArtistAddAll.module.scss';

type OwnProps = {
  artist: MusicCatalogArtist;
  onClose: NoneToVoidFunction;
};

type Also = 'none' | 'star' | 'playlist';

const KIND_KEYS = {
  album: 'MusicReleaseAlbums', single: 'MusicReleaseSingles', compile: 'MusicReleaseCompiles', live: 'MusicReleaseLive',
} as const;
const ALSO_VALUES: Also[] = ['none', 'star', 'playlist'];
const ALSO_KEYS = { none: 'MusicAlsoNowhere', star: 'MusicStarred', playlist: 'MusicAlsoPlaylist' } as const;
// По умолчанию — альбомы и синглы (доска `XpMusic-02`)
const DEFAULT_KINDS: MusicReleaseKind[] = ['album', 'single'];
// Средний трек — для оценки места «≈ 2,1 ГБ»
const TRACK_BYTES_ESTIMATE = 10 * 1024 * 1024;
const GB_TENTH = 1e8;

// Parvane (макет «Музыки» 23 ноя, доска `XpMusic-02`): «Добавить на сервер всё» — какие выпуски брать (альбомы, синглы
// и EP, сборники, концертные) с числом релизов и треков, «Ещё добавить в: Никуда · Любимое · Плейлист…», итог «N уже на
// сервере. Добавим M треков ≈ размер. Сегодня можно ещё K, остальные — завтра сами» и «Добавить M треков»
const MusicArtistAddAll = ({ artist, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const { data: plan, isFailed } = useMusicData(`artist-plan:${artist.ref}`, () => (
    callMusic('parvaneMusicFetchArtistPlan', { artistRef: artist.ref })
  ));
  const [kinds, setKinds] = useState<MusicReleaseKind[]>(DEFAULT_KINDS);
  const [also, setAlso] = useState<Also>('none');
  const [isPicking, setIsPicking] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const handleToggle = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const kind = e.currentTarget.dataset.kind as MusicReleaseKind;
    setKinds((previous) => (previous.includes(kind) ? previous.filter((item) => item !== kind) : [...previous, kind]));
  });

  const start = useLastCallback(async (playlists?: { id: string; isShared: boolean }[]) => {
    setIsBusy(true);
    const result = await callMusic('parvaneMusicFetchArtist', {
      artistRef: artist.ref, kinds, isStar: also === 'star',
    }).catch(() => undefined);
    setIsBusy(false);
    if (!result) {
      showNotification({ message: lang('MusicFetchFailedShort') });
      return;
    }
    result.jobs.forEach((job) => {
      putJob(job);
      if (playlists) addFetchFollowUp(job.jobId, { playlists });
    });
    showNotification({
      message: lang('MusicAddAllStarted', {
        started: result.jobs.length, deferred: result.deferred,
      }, { pluralValue: result.jobs.length }),
    });
    onClose();
  });
  const handleAdd = useLastCallback(() => {
    if (also === 'playlist') setIsPicking(true);
    else void start();
  });
  const handlePickPlaylists = useLastCallback((playlists: { id: string; isShared: boolean }[]) => {
    void start(playlists);
  });
  const handleClosePicker = useLastCallback(() => setIsPicking(false));

  const chosen = (plan?.groups || []).filter((group) => kinds.includes(group.kind));
  const total = chosen.reduce((sum, group) => sum + group.tracks, 0);
  const toAdd = Math.max(0, total - (plan?.onServer || 0));
  const now = Math.min(toAdd, plan?.todayLeft || 0);
  const later = toAdd - now;
  const sizeGb = Math.round((toAdd * TRACK_BYTES_ESTIMATE) / GB_TENTH) / 10;
  const summary = plan && [
    lang('MusicAddAllOnServer', { count: plan.onServer }, { pluralValue: plan.onServer }),
    lang('MusicAddAllWillAdd', { count: toAdd, size: lang('MusicAddAllSize', { gb: lang.number(sizeGb) }) }, {
      pluralValue: toAdd,
    }),
    later > 0 && lang('MusicAddAllLater', { now, later }),
  ].filter(Boolean).join(' ');

  if (isPicking) {
    return (
      <MusicPlaylistPicker
        tracks={[]}
        subtitle={artist.name}
        onPick={handlePickPlaylists}
        onClose={handleClosePicker}
      />
    );
  }

  return (
    <PvSheet
      isOpen
      title={lang('MusicAddAllToServer')}
      subtitle={lang('MusicAddAllWhat', { name: artist.name })}
      onClose={onClose}
    >
      <div className={styles.root} data-music-add-all>
        {!plan && (isFailed ? <p className={styles.note}>{lang('MusicCatalogDown')}</p> : <PvSkeleton />)}
        {plan && (
          <>
            <div className={styles.kinds} role="group">
              {plan.groups.map((group) => (
                <button
                  key={group.kind}
                  type="button"
                  role="checkbox"
                  aria-checked={kinds.includes(group.kind)}
                  className={styles.kind}
                  data-kind={group.kind}
                  onClick={handleToggle}
                >
                  <span className={buildClassName(styles.box, kinds.includes(group.kind) && styles.boxOn)} />
                  <span className={styles.kindText}>
                    <span className={styles.kindTitle}>{lang(KIND_KEYS[group.kind])}</span>
                    <span className={styles.kindSub}>
                      {[
                        lang('MusicReleasesCount', { count: group.releases }, { pluralValue: group.releases }),
                        lang('MusicTracksCount', { count: group.tracks }, { pluralValue: group.tracks }),
                      ].join(' · ')}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <div className={styles.also}>
              <span className={styles.alsoLabel}>{lang('MusicAlsoAddTo')}</span>
              <PvSegment
                items={ALSO_VALUES.map((value) => ({ value, label: lang(ALSO_KEYS[value]) }))}
                value={also}
                label={lang('MusicAlsoAddTo')}
                onChange={setAlso}
              />
            </div>
            <p className={styles.note} data-music-add-all-summary>{summary}</p>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc, styles.add)}
              disabled={!toAdd || isBusy}
              data-music-add-all-start
              onClick={handleAdd}
            >
              {lang('MusicAddAllButton', { count: toAdd }, { pluralValue: toAdd })}
            </button>
          </>
        )}
      </div>
    </PvSheet>
  );
};

export default memo(MusicArtistAddAll);
