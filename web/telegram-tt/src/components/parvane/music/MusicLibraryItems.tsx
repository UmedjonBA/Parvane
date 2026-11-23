import { memo, useEffect } from '../../../lib/teact/teact';

import type { MusicInfo } from '../../../api/parvane/musicApi';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { MusicView } from './musicView';

import buildClassName from '../../../util/buildClassName';
import { getSharedPlaylists, watchSharedPlaylists } from './shared/musicShared';
import { getOwnAdded } from './musicAdded';
import { getMusicMix, loadMusicMix } from './musicMix';
import { getOfflineState } from './musicOffline';
import { getPlaylists } from './musicPlaylists';
import { openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import MusicCover from './MusicCover';

import styles from './MusicLibraryItems.module.scss';

type OwnProps = {
  info: MusicInfo;
  // Открытый вид — его строка подсвечена (компьютер)
  view?: MusicView;
  isPhone?: boolean;
};

type Item = {
  key: string;
  view: MusicView;
  title: string;
  sub: string;
  glyph: ParvaneIconName;
  // Цвет заглушки обложки: «Любимое», «Скачано», «Добавлено мной», микс — свои; плейлисты — по id
  toneId: string;
};

// Parvane (макет «Музыки» 23 ноя, доски `DeskMusic`, `MusicLibrary`): медиатека одним списком с обложками —
// «Любимое», «Скачано», «Добавлено мной», микс, свои и общие плейлисты. Компьютер — панель слева от вида, телефон —
// вкладка «Медиатека», раздел «Плейлисты»
const MusicLibraryItems = ({ info, view, isPhone }: OwnProps) => {
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  const shared = useDerivedState(getSharedPlaylists);
  const offline = useDerivedState(getOfflineState);
  const added = useDerivedState(getOwnAdded);
  const mix = useDerivedState(getMusicMix);

  useEffect(() => watchSharedPlaylists(), []);
  useEffect(() => {
    if (!getMusicMix()) void loadMusicMix();
  }, []);

  const offlineCount = offline.entries.length;
  const addedCount = added.size;
  const mixCount = mix?.mix?.tracks.length || 0;
  const items: Item[] = [
    {
      key: 'starred',
      view: { kind: 'starred' },
      title: lang('MusicStarred'),
      sub: lang('MusicLibPlaylistOf', { count: info.starredCount }, { pluralValue: info.starredCount }),
      glyph: 'heart',
      toneId: 'starred',
    },
    {
      key: 'offline',
      view: { kind: 'offline' },
      title: lang('MusicOffline'),
      sub: lang(isPhone ? 'MusicLibOfflinePhone' : 'MusicLibOfflineDesk', { count: offlineCount }),
      glyph: 'offline',
      toneId: 'offline',
    },
  ];
  if (info.isFetchEnabled || info.isUploadEnabled) {
    items.push({
      key: 'added',
      view: { kind: 'added' },
      title: lang('MusicAdded'),
      sub: lang('MusicLibAddedSub', { count: addedCount }, { pluralValue: addedCount }),
      glyph: 'upload',
      toneId: 'added',
    });
  }
  if (mixCount) {
    items.push({
      key: 'mix',
      view: { kind: 'mix' },
      title: lang('MusicMixTitle'),
      sub: lang('MusicLibMixSub'),
      glyph: 'wave',
      toneId: 'mix',
    });
  }
  playlists.forEach((playlist) => items.push({
    key: `playlist:${playlist.id}`,
    view: { kind: 'playlist', id: playlist.id },
    title: playlist.name,
    sub: lang('MusicLibOwnPlaylist', { count: playlist.count }, { pluralValue: playlist.count }),
    glyph: 'list',
    toneId: playlist.id,
  }));
  shared.forEach((playlist) => items.push({
    key: `shared:${playlist.id}`,
    view: { kind: 'shared', id: playlist.id },
    title: playlist.name,
    sub: lang('MusicLibSharedPlaylist', { count: playlist.trackCount }, { pluralValue: playlist.trackCount }),
    glyph: 'users',
    toneId: playlist.id,
  }));

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const item = items.find((one) => one.key === e.currentTarget.dataset.item);
    if (item) openMusicView(item.view, !isPhone);
  });

  const selectedKey = view && keyOfView(view);

  return (
    <div className={buildClassName(styles.root, isPhone && styles.rootPhone)} data-music-library-items>
      {items.map((item) => {
        const isOn = item.key === selectedKey;
        return (
          <button
            key={item.key}
            type="button"
            className={buildClassName(styles.item, isOn && styles.itemOn)}
            aria-current={isOn ? 'page' : undefined}
            data-item={item.key}
            data-view={item.view.kind}
            onClick={handleOpen}
          >
            <MusicCover toneId={item.toneId} size={isPhone ? 48 : 42} glyph={item.glyph} className={styles.cover} />
            <span className={styles.text}>
              <span className={styles.title}>{item.title}</span>
              <span className={styles.sub}>{item.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
};

function keyOfView(view: MusicView) {
  if (view.kind === 'playlist' || view.kind === 'shared') return `${view.kind}:${view.id}`;
  return view.kind;
}

export default memo(MusicLibraryItems);
