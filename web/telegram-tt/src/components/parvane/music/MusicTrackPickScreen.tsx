import { memo, useEffect, useLayoutEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { formatTrackTime } from './musicFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ChatScreen from '../chatScreen/ChatScreen';

import screen from '../chatScreen/ChatScreen.module.scss';

type OwnProps = {
  isOpen: boolean;
  chatId: string;
  onClose: NoneToVoidFunction;
};

type SearchReply = { tracks: MusicTrack[] };
type CallMusic = {
  (name: 'parvaneMusicSearch', args: { query: string }): Promise<SearchReply | undefined>;
  (name: 'parvaneMusicStarred', args: object): Promise<SearchReply | undefined>;
  (name: 'parvaneSendMusicTrack', args: {
    chatId: string;
    track: { id: string; title: string; artist: string; durationSecs: number };
  }): Promise<boolean | undefined>;
};
// Методы Parvane: типы `callApi` описывают только методы Telegram
const callMusic = callApi as unknown as CallMusic;

const SEARCH_DELAY_MS = 300;

// Плитка «Трек» шторки вложений (доска `PhCalls`): поиск по библиотеке «Музыки» своего сервера, без запроса —
// любимые; выбранный трек уходит карточкой (TRACK-1), получатель слушает его из библиотеки сервера
const MusicTrackPickScreen = ({ isOpen, chatId, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState<MusicTrack[] | undefined>();

  useLayoutEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setTracks(undefined);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    let isActual = true;
    const timer = window.setTimeout(() => {
      const request = query.trim()
        ? Promise.resolve(callMusic('parvaneMusicSearch', { query: query.trim() })).then((reply) => reply?.tracks)
        : Promise.resolve(callMusic('parvaneMusicStarred', {})).then((reply) => reply?.tracks);
      void request.then((found) => {
        if (isActual) setTracks(found || []);
      }).catch(() => {
        if (isActual) setTracks([]);
      });
    }, query ? SEARCH_DELAY_MS : 0);
    return () => {
      isActual = false;
      window.clearTimeout(timer);
    };
  }, [isOpen, query]);

  const handleQueryChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handlePick = useLastCallback((track: MusicTrack) => {
    onClose();
    void Promise.resolve(callMusic('parvaneSendMusicTrack', {
      chatId,
      track: {
        id: track.id, title: track.title, artist: track.artist, durationSecs: track.durationSecs,
      },
    })).then((isSent) => {
      showNotification({ message: { key: isSent ? 'MusicTrackSent' : 'MusicTrackNotSent' } });
    }).catch(() => showNotification({ message: { key: 'MusicTrackNotSent' } }));
  });

  return (
    <ChatScreen isOpen={isOpen} title={lang('AttachMenuTrackTitle')} onClose={onClose}>
      <div className={screen.pad}>
        <input
          className={screen.inp}
          type="search"
          value={query}
          placeholder={lang('AttachMenuTrackSearch')}
          aria-label={lang('AttachMenuTrackSearch')}
          onChange={handleQueryChange}
          data-track-pick-search
        />
      </div>
      {!query.trim() && <div className={screen.cap}>{lang('AttachMenuTrackStarred')}</div>}
      <div className={screen.grp} data-track-pick-list>
        {tracks?.map((track) => (
          <button
            key={track.id}
            type="button"
            className={buildClassName(screen.sr, screen.srButton)}
            onClick={() => handlePick(track)}
            data-track-pick={track.id}
          >
            <span className={screen.srMain}>{track.title}</span>
            <span className={buildClassName(screen.srValue, screen.mono)}>
              {`${track.artist} · ${formatTrackTime(track.durationSecs)}`}
            </span>
          </button>
        ))}
        {tracks && !tracks.length && <div className={screen.hint}>{lang('AttachMenuTrackEmpty')}</div>}
      </div>
    </ChatScreen>
  );
};

export default memo(MusicTrackPickScreen);
