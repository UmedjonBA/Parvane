import { memo, useMemo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicOfflineGroup } from './musicLibrary';
import { LeftColumnContent, SettingsScreens } from '../../../types';

import buildClassName from '../../../util/buildClassName';
import { setParvaneSection } from '../../../util/parvaneSection';
import { estimateOfflineLeft } from './musicFormat';
import { groupOffline } from './musicLibrary';
import {
  cancelOffline, getOfflineBytes, getOfflineHolds, getOfflineSettings, getOfflineState, pauseOffline,
  removeOffline, removeOfflineGroup, resumeOffline,
} from './musicOffline';
import {
  getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { getPlaylists } from './musicPlaylists';
import { goBackMusic } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../notes/PvEmpty';
import PvSheet from '../notes/PvSheet';
import MusicCover from './MusicCover';
import MusicOfflineSettings from './MusicOfflineSettings';
import MusicSectionHead from './MusicSectionHead';
import { formatMusicSize } from './MusicSize';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  isPhone?: boolean;
};

const GROUP_KIND_KEYS = { playlist: 'MusicKindPlaylistLower', album: 'MusicKindAlbumLower' } as const;
const PERCENT = 100;

// Parvane (spec 041 C3; доски `XpMusic`, `RdMusic`): «Загруженное» — треки на этом устройстве, играют без сети.
// Сколько занято из предела (полоса), группы «плейлист / альбом / отдельные треки» с размером и «Убрать», ход
// загрузки с паузой и отменой (без связи — ждёт и продолжается сама), докачка нового и качество, «Удалить всё»
const MusicOffline = ({ isPhone }: OwnProps) => {
  const { openLeftColumnContent, openSettingsScreen } = getActions();
  const lang = useLang();
  const state = useDerivedState(getOfflineState);
  const settings = useDerivedState(getOfflineSettings);
  const playlists = useDerivedState(getPlaylists);
  const player = useDerivedState(getMusicPlayer);
  const currentId = getCurrentTrack(player)?.id;
  const [isClearAsked, askClear, cancelClear] = useFlag();
  const [isLimitOpen, openLimit, closeLimit] = useFlag();
  // Раскрытая группа: её треки строками
  const [openedGroup, setOpenedGroup] = useState<string>();

  const count = state.entries.length;
  const used = getOfflineBytes(state);
  const groups = useMemo(() => {
    const holds = getOfflineHolds();
    return groupOffline(
      state.entries.map((entry) => ({ id: entry.track.id, bytes: entry.bytes })),
      { playlists: holds.playlists, albums: holds.albums },
      playlists.map((playlist) => playlist.id),
    );
  }, [state.entries, playlists]);
  const tracksById = useMemo(
    () => new Map(state.entries.map((entry) => [entry.track.id, entry.track])), [state.entries],
  );

  const handlePlayGroup = useLastCallback((group: MusicOfflineGroup, index: number) => {
    const tracks = group.trackIds.map((id) => tracksById.get(id)).filter(Boolean);
    playTracks(tracks, index, { source: { kind: 'offline', name: titleOf(group) } });
  });

  const handleStar = useLastCallback((track: MusicTrack) => void setTrackStarred(track, !track.isStarred));

  const handleRelease = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const group = groups[Number(e.currentTarget.dataset.index)];
    void removeOfflineGroup(group.kind === 'tracks' ? undefined : { kind: group.kind, id: group.id }, group.trackIds);
  });

  const handleToggleGroup = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const key = e.currentTarget.dataset.group!;
    setOpenedGroup(openedGroup === key ? undefined : key);
  });

  const handleClear = useLastCallback(() => {
    cancelClear();
    void removeOffline();
  });

  const handleOpenDataSettings = useLastCallback(() => {
    setParvaneSection('messenger');
    openLeftColumnContent({ contentKey: LeftColumnContent.Settings });
    openSettingsScreen({ screen: SettingsScreens.DataStorage });
  });

  function titleOf(group: MusicOfflineGroup) {
    if (group.kind === 'tracks') return lang('MusicOfflineSingleTracks');
    if (group.kind === 'playlist') {
      return playlists.find((item) => item.id === group.id)?.name || lang('MusicPlaylists');
    }
    return tracksById.get(group.trackIds[0])?.album || lang('MusicKindAlbum');
  }

  function renderBatch() {
    if (!state.pending) return undefined;
    const holder = state.batch?.holder;
    const name = !holder ? lang('MusicOfflineSingleTracks')
      : holder.kind === 'playlist' ? playlists.find((item) => item.id === holder.id)?.name : undefined;
    const done = state.total - state.pending;
    const left = estimateOfflineLeft(state.doneBytes, state.busyMs, done, state.pending);
    const leftText = left && !state.isPaused ? lang('MusicOfflineLeft', {
      minutes: left.minutes, size: formatMusicSize(lang, left.bytes),
    }, { pluralValue: left.minutes }) : undefined;
    return (
      <section
        className={styles.card}
        role="status"
        data-offline-progress={state.isWaitingNetwork ? 'waiting' : 'running'}
      >
        {isPhone && <div className={kit.caps}>{lang('MusicOfflineDownloading')}</div>}
        <div className={styles.cardLine}>
          <span className={buildClassName(kit.grow, styles.trackTitle)}>
            {isPhone ? name : lang('MusicOfflineDownloadingName', { name: name || '' })}
          </span>
          <span className={buildClassName(kit.mono, kit.muted, kit.small)}>
            {lang('MusicOfflineProgress', { done, total: state.total })}
          </span>
        </div>
        <div
          className={styles.bar}
          role="progressbar"
          aria-label={lang('MusicOfflineProgressLabel')}
          aria-valuemin={0}
          aria-valuemax={state.total}
          aria-valuenow={done}
          style={`--bar: ${state.total ? (done / state.total) * PERCENT : 0}%`}
        />
        <div className={styles.cardLine}>
          <span className={buildClassName(kit.grow, kit.muted, kit.small)}>
            {state.isWaitingNetwork ? lang('MusicOfflineWaitingNetwork')
              : state.isPaused ? lang('MusicOfflinePaused') : leftText}
          </span>
          {!state.isWaitingNetwork && (
            <button
              type="button"
              className={kit.btn}
              data-offline-pause={state.isPaused ? 'paused' : 'running'}
              onClick={state.isPaused ? resumeOffline : pauseOffline}
            >
              {lang(state.isPaused ? 'MusicOfflineResume' : 'MusicOfflinePause')}
            </button>
          )}
          <button type="button" className={kit.btn} data-offline-cancel onClick={cancelOffline}>
            {lang('Cancel')}
          </button>
        </div>
      </section>
    );
  }

  function renderGroup(group: MusicOfflineGroup, index: number) {
    const key = `${group.kind}:${group.id}`;
    const isOpened = openedGroup === key;
    const facts = [
      group.kind !== 'tracks' && lang(GROUP_KIND_KEYS[group.kind]),
      lang('MusicTracksCount', { count: group.trackIds.length }, { pluralValue: group.trackIds.length }),
      isPhone && formatMusicSize(lang, group.bytes),
    ].filter(Boolean).join(' · ');
    return (
      <li key={key} className={styles.offlineGroup} data-offline-group={key}>
        <div className={styles.track}>
          <button type="button" className={styles.trackMain} data-group={key} onClick={handleToggleGroup}>
            <MusicCover
              toneId={group.id || 'tracks'}
              size={36}
              glyph={group.kind === 'album' ? 'disc' : 'list'}
              className={styles.trackCover}
            />
            <span className={styles.trackText}>
              <span className={styles.trackTitle}>{titleOf(group)}</span>
              <span className={buildClassName(kit.muted, kit.small)}>{facts}</span>
            </span>
            {!isPhone && (
              <span className={buildClassName(kit.mono, kit.muted, kit.small)}>
                {formatMusicSize(lang, group.bytes)}
              </span>
            )}
          </button>
          <button
            type="button"
            className={kit.btn}
            data-index={index}
            data-offline-release={key}
            onClick={handleRelease}
          >
            {lang('MusicOfflineRelease')}
          </button>
          {!isPhone && group.kind === 'tracks' && (
            <button type="button" className={kit.btn} data-group={key} onClick={handleToggleGroup}>
              {lang(isOpened ? 'MusicOfflineHide' : 'MusicOfflineShow')}
            </button>
          )}
        </div>
        {isOpened && (
          <ul className={styles.tracks} data-music-tracks>
            {group.trackIds.map((id, position) => (
              <MusicTrackRow
                key={id}
                track={tracksById.get(id)!}
                index={position}
                isCurrent={id === currentId}
                isPlaying={player.isPlaying}
                canQueue
                onStar={handleStar}
                extra={{
                  removeLabel: lang('MusicOfflineRemoveTrack'),
                  onRemove: () => void removeOffline([id]),
                }}
                onPlay={(at) => handlePlayGroup(group, at)}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const usage = lang('MusicOfflineUsage', {
    count, used: formatMusicSize(lang, used), limit: formatMusicSize(lang, settings.limitBytes),
  }, { pluralValue: count });
  const clearButton = Boolean(count) && (
    <button
      type="button"
      className={buildClassName(kit.btn, kit.btnDanger, isPhone && kit.btnWide)}
      data-offline-clear={isClearAsked ? 'confirm' : 'ask'}
      onClick={isClearAsked ? handleClear : askClear}
    >
      {lang(isClearAsked ? 'MusicOfflineClearConfirm' : isPhone ? 'MusicOfflineClear' : 'MusicOfflineClearShort')}
    </button>
  );

  return (
    <div className={styles.view} data-music-offline={count}>
      <MusicSectionHead
        title={lang('MusicOffline')}
        subtitle={isPhone ? undefined : <span data-offline-usage>{usage}</span>}
        isPhone={isPhone}
        actions={isPhone ? undefined : (
          <>
            <button type="button" className={kit.btn} data-offline-limit onClick={openLimit}>
              {lang('MusicOfflineChangeLimit')}
            </button>
            {clearButton}
          </>
        )}
        onBack={goBackMusic}
      />
      {isPhone && (
        <div className={styles.usageHead} data-offline-usage>
          <span className={buildClassName(kit.caps, kit.grow)}>{lang('MusicOfflineOnDevice')}</span>
          <span className={buildClassName(kit.mono, kit.small)}>
            {[lang('MusicTracksCount', { count }, { pluralValue: count }), formatMusicSize(lang, used)].join(' · ')}
          </span>
        </div>
      )}
      <div
        className={styles.bar}
        role="meter"
        aria-label={usage}
        aria-valuemin={0}
        aria-valuemax={settings.limitBytes}
        aria-valuenow={used}
        style={`--bar: ${Math.min(PERCENT, (used / settings.limitBytes) * PERCENT)}%`}
      />
      {isPhone && (
        <div className={buildClassName(kit.muted, kit.small)}>
          {lang('MusicOfflineLimitHint', { limit: formatMusicSize(lang, settings.limitBytes) })}
          {' '}
          <button type="button" className={styles.inlineLink} onClick={handleOpenDataSettings}>
            {lang('MusicOfflineLimitLink')}
          </button>
        </div>
      )}
      {state.problem && (
        <div className={styles.error} role="alert" data-offline-problem={state.problem}>
          {lang(state.problem === 'limit' ? 'MusicOfflineLimit' : 'MusicOfflineFailed')}
        </div>
      )}
      {!count && !state.pending && <PvEmpty text={lang('MusicOfflineEmpty')} data-music-empty />}
      {Boolean(groups.length) && <ul className={styles.tracks} data-offline-groups>{groups.map(renderGroup)}</ul>}
      {renderBatch()}
      {!isPhone && (
        <section className={styles.card}>
          <MusicOfflineSettings withRules />
        </section>
      )}
      {isPhone && clearButton}
      <PvSheet isOpen={isLimitOpen} title={lang('MusicOfflineChangeLimit')} onClose={closeLimit}>
        <MusicOfflineSettings withLimit />
      </PvSheet>
    </div>
  );
};

export default memo(MusicOffline);
