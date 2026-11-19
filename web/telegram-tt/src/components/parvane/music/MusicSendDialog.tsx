import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicPlaylist, MusicTrack } from '../../../api/parvane/musicApi';
import type { PlaylistShareTrack } from '../../../api/parvane/musicPlaylistContent';

import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';

type OwnProps = {
  track?: MusicTrack;
  playlist?: MusicPlaylist;
  onClose: NoneToVoidFunction;
};

// Parvane (TRACK-1, PLAYLIST-1): «в чат» — выбор чата; уходит карточка трека либо плейлиста, получатель играет
// треки из библиотеки сервера
type SendMusic = {
  (name: 'parvaneSendMusicTrack', args: {
    chatId: string;
    track: { id: string; title: string; artist: string; durationSecs: number };
  }): Promise<boolean | undefined>;
  (name: 'parvaneSendMusicPlaylist', args: {
    chatId: string;
    playlist: { name: string; tracks: PlaylistShareTrack[] };
  }): Promise<boolean | undefined>;
};
// Метод Parvane: типы `callApi` описывают только методы Telegram
const callSend = callApi as unknown as SendMusic;

const MusicSendDialog = ({ track, playlist, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const handleSelect = useLastCallback((chatId: string) => {
    onClose();
    if (playlist) {
      sendPlaylist(chatId, playlist);
      return;
    }
    const sent = track!;
    void callSend('parvaneSendMusicTrack', {
      chatId,
      track: {
        id: sent.id, title: sent.title, artist: sent.artist, durationSecs: sent.durationSecs,
      },
    }).then((isSent) => {
      showNotification({ message: { key: isSent ? 'MusicTrackSent' : 'MusicTrackNotSent' } });
    }).catch(() => {
      showNotification({ message: { key: 'MusicTrackNotSent' } });
    });
  });

  function sendPlaylist(chatId: string, sent: MusicPlaylist) {
    void callSend('parvaneSendMusicPlaylist', {
      chatId,
      playlist: {
        name: sent.name,
        tracks: sent.items.map((item) => ({
          id: item.trackId, title: item.title, artist: item.artist, durationSecs: item.durationSecs,
        })),
      },
    }).then((isSent) => {
      showNotification({ message: { key: isSent ? 'MusicPlaylistSent' : 'MusicPlaylistNotSent' } });
    }).catch(() => {
      showNotification({ message: { key: 'MusicPlaylistNotSent' } });
    });
  }

  return (
    <RecipientPicker
      isOpen={Boolean(track || playlist)}
      title={lang('MusicSendToChat')}
      searchPlaceholder={lang('Search')}
      onSelectRecipient={handleSelect}
      onClose={onClose}
    />
  );
};

export default memo(MusicSendDialog);
