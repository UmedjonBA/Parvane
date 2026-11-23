import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { ApiMusicPlaylistCard } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import { coverTone, formatTrackTime, splitListTime } from '../../parvane/music/musicFormat';
import { getMusicInfo, loadMusicInfo, playTracks } from '../../parvane/music/musicPlayer';
import { loadSharedTracks } from '../../parvane/music/musicSharedPlaylist';
import { goToMusicView } from '../../parvane/music/musicView';
import { joinSharedPlaylist } from '../../parvane/music/shared/musicShared';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useModuleGate from '../../../hooks/useModuleGate';

import Icon from '../../common/icons/Icon';
import ParvaneIcon from '../../main/ParvaneIcon';
import MusicPlaylistSheet from '../../parvane/music/MusicPlaylistSheet';
import PvModuleOff from '../../parvane/notes/PvModuleOff';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './MusicPlaylistCard.module.scss';

type OwnProps = {
  playlist: ApiMusicPlaylistCard;
};

// Первые треки на карточке, остальные — «и ещё N»
const PREVIEW_TRACKS = 3;

// Parvane (PLAYLIST-1, доска `MusicChat`): плейлист «Музыки» в чате — название, число треков и длительность,
// первые треки, «Слушать» и «Открыть». Треки играют из библиотеки своего сервера: байтов в сообщении нет
const MusicPlaylistCard = ({ playlist }: OwnProps) => {
  const lang = useLang();
  const gate = useModuleGate('music');
  const info = useDerivedState(getMusicInfo);
  const [problem, setProblem] = useState<'missing' | 'failed' | 'shared'>();
  const [isOpen, open, close] = useFlag();
  const isMusicOn = gate.isOn;
  // Чей это плейлист, известно после сведений о «Музыке»: до них карточка только показывает
  const isOwnServer = info ? info.server === playlist.server : undefined;
  const canPlay = Boolean(isOwnServer && info?.isEnabled && isMusicOn);
  const durationSecs = playlist.tracks.reduce((sum, track) => sum + track.durationSecs, 0);
  const time = splitListTime(durationSecs);
  const count = playlist.tracks.length;
  const moreCount = count - PREVIEW_TRACKS;

  useEffect(() => {
    if (isMusicOn && !getMusicInfo()) void loadMusicInfo().catch(() => undefined);
  }, [isMusicOn]);

  const handleListen = useLastCallback(async () => {
    try {
      const tracks = await loadSharedTracks(playlist);
      if (!tracks.length) {
        setProblem('missing');
        return;
      }
      setProblem(undefined);
      playTracks(tracks, 0, { source: { kind: 'playlist', name: playlist.name } });
    } catch {
      setProblem('failed');
    }
  });

  // «Музыка» выключена на устройстве: кнопки ведут в лист «Модуль выключен», после включения действие выполняется
  const handleListenClick = useLastCallback(() => {
    gate.run(async () => {
      const known = getMusicInfo() || await loadMusicInfo().catch(() => undefined);
      if (known?.isEnabled && known.server === playlist.server) void handleListen();
    });
  });

  // Общий плейлист сервера (MUSIC-3): вступить ключом из карточки и открыть живой плейлист
  const handleOpenShared = useLastCallback(async () => {
    const joined = await joinSharedPlaylist(playlist.sharedId!, playlist.joinKey || '');
    if (!joined) {
      setProblem('shared');
      return;
    }
    setProblem(undefined);
    goToMusicView({ kind: 'shared', id: joined.id });
  });

  const handleOpenClick = useLastCallback(() => {
    gate.run(() => {
      if (playlist.sharedId && canPlay) void handleOpenShared();
      else open();
    });
  });

  const isActionable = canPlay || gate.canEnable;
  // Общий плейлист (доска `MusicChat-01`): строкой — обложка, название, «общий плейлист · N треков», шеврон
  if (playlist.sharedId) {
    return (
      <div className={styles.root} data-music-playlist-card={playlist.name} data-music-shared-card={playlist.sharedId}>
        <button type="button" className={styles.compact} onClick={handleOpenClick}>
          <span className={styles.cover} style={`--cover-tone: ${coverTone(playlist.name)}`}>
            <ParvaneIcon name="list" />
          </span>
          <span className={styles.titles}>
            <span className={styles.name}>{playlist.name}</span>
            <span className={styles.label}>
              {[
                lang('MusicPlaylistCardShared'),
                lang('MusicTracksCount', { count }, { pluralValue: count }),
              ].join(' · ')}
            </span>
          </span>
          <ParvaneIcon name="right" className={styles.chevron} />
        </button>
        {problem && (
          <p className={styles.note} role="status" data-playlist-problem={problem}>
            {lang(problem === 'shared' ? 'MusicSharedJoinFailed' : 'MusicTrackCardFailed')}
          </p>
        )}
        <PvModuleOff
          isOpen={gate.isAsked}
          module="music"
          hint={lang('ModuleOffHintPlaylist')}
          onEnable={gate.enable}
          onClose={gate.dismiss}
        />
      </div>
    );
  }

  return (
    <div className={styles.root} data-music-playlist-card={playlist.name} data-music-shared-card={playlist.sharedId}>
      <div className={styles.head}>
        <span className={styles.cover} style={`--cover-tone: ${coverTone(playlist.name)}`}>
          <ParvaneIcon name="list" />
        </span>
        <div className={styles.titles}>
          <div className={styles.label}>
            {lang(playlist.sharedId ? 'MusicPlaylistCardShared' : 'MusicPlaylistCardLabel')}
          </div>
          <div className={styles.name}>{playlist.name}</div>
          <div className={buildClassName(styles.label, kit.mono)}>
            {`${lang('MusicTracksCount', { count }, { pluralValue: count })} · `}
            {lang('MusicListTime', { hours: time.hours, minutes: time.minutes })}
          </div>
        </div>
      </div>
      <ol className={styles.tracks}>
        {playlist.tracks.slice(0, PREVIEW_TRACKS).map((track, index) => (
          <li key={track.trackId} className={styles.track}>
            <span className={buildClassName(kit.mono, styles.muted)}>{index + 1}</span>
            <span className={styles.trackTitle}>{[track.title, track.artist].filter(Boolean).join(' · ')}</span>
            <span className={buildClassName(kit.mono, styles.muted)}>{formatTrackTime(track.durationSecs)}</span>
          </li>
        ))}
        {moreCount > 0 && <li className={styles.muted}>{lang('MusicPlaylistCardMore', { count: moreCount })}</li>}
      </ol>
      <div className={styles.actions}>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc, styles.action)}
          disabled={!isActionable}
          onClick={handleListenClick}
        >
          <Icon name="play" />
          {lang('MusicPlaylistCardListen')}
        </button>
        <button
          type="button"
          className={buildClassName(kit.btn, styles.action)}
          onClick={handleOpenClick}
        >
          {lang('MusicPlaylistCardOpen')}
        </button>
      </div>
      {isOwnServer === false && (
        <p className={styles.note}>{lang('MusicTrackCardOtherServer', { server: playlist.server })}</p>
      )}
      {problem && (
        <p className={styles.note} role="status" data-playlist-problem={problem}>
          {lang(problem === 'missing' ? 'MusicPlaylistCardMissing'
            : problem === 'shared' ? 'MusicSharedJoinFailed' : 'MusicTrackCardFailed')}
        </p>
      )}
      <MusicPlaylistSheet
        isOpen={isOpen}
        playlist={playlist}
        canPlay={canPlay}
        onClose={close}
      />
      <PvModuleOff
        isOpen={gate.isAsked}
        module="music"
        hint={lang('ModuleOffHintPlaylist')}
        onEnable={gate.enable}
        onClose={gate.dismiss}
      />
    </div>
  );
};

export default memo(MusicPlaylistCard);
