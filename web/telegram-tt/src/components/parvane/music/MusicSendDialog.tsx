import { memo, useMemo } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { MusicCatalogTrack, MusicPlaylist, MusicTrack } from '../../../api/parvane/musicApi';
import type { PlaylistShareTrack } from '../../../api/parvane/musicPlaylistContent';
import type { SendPreview } from '../../main/SendRecipientScreen';

import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import SendRecipientScreen from '../../main/SendRecipientScreen';

type OwnProps = {
  track?: MusicTrack;
  // Трек каталога (доска `MusicChat-01`): уходит карточкой «каталог»
  catalog?: MusicCatalogTrack;
  playlist?: MusicPlaylist;
  onClose: NoneToVoidFunction;
};

// Parvane (TRACK-1, PLAYLIST-1; доска `RpPick`): «в чат» — экран «Кому отправить» с карточкой «название ·
// исполнитель · трек», несколькими чатами и подписью; уходит карточка трека либо плейлиста (подпись — сообщением перед
// ней), получатель играет треки из библиотеки сервера
type SendMusic = {
  (name: 'parvaneSendMusicTrack', args: {
    chatId: string;
    track: {
      id: string; title: string; artist: string; durationSecs: number;
      catalogRef?: string; album?: string; coverUrl?: string; previewUrl?: string;
    };
  }): Promise<boolean | undefined>;
  (name: 'parvaneSendMusicPlaylist', args: {
    chatId: string;
    playlist: { name: string; tracks: PlaylistShareTrack[] };
  }): Promise<boolean | undefined>;
};
// Метод Parvane: типы `callApi` описывают только методы Telegram
const callSend = callApi as unknown as SendMusic;
const callText = callApi as unknown as (name: 'sendMessage', args: { chat: unknown; text: string }) => Promise<unknown>;

const MusicSendDialog = ({
  track, catalog, playlist, onClose,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const preview = useMemo<SendPreview | undefined>(() => {
    if (playlist) {
      return { title: playlist.name, subtitle: lang('MusicSendPlaylistPreview', { count: playlist.items.length }) };
    }
    const shown = track || catalog;
    return shown && { title: shown.title, subtitle: lang('MusicSendTrackPreview', { artist: shown.artist }) };
  }, [track, catalog, playlist, lang]);

  const handleSend = useLastCallback((chatIds: string[], caption: string) => {
    onClose();
    chatIds.forEach((chatId) => {
      const chat = getGlobal().chats.byId[chatId];
      const captionCall = caption && chat ? callText('sendMessage', { chat, text: caption }) : undefined;
      const captionSent = Promise.resolve(captionCall);
      void captionSent.catch(() => undefined).then(() => sendTo(chatId));
    });
  });

  function sendTo(chatId: string) {
    if (playlist) {
      sendPlaylist(chatId, playlist);
      return;
    }
    void callSend('parvaneSendMusicTrack', {
      chatId,
      track: catalog ? {
        id: '',
        title: catalog.title,
        artist: catalog.artist,
        durationSecs: catalog.durationSecs,
        catalogRef: catalog.ref,
        album: catalog.album,
        coverUrl: catalog.coverUrl,
        previewUrl: catalog.previewUrl,
      } : {
        id: track!.id, title: track!.title, artist: track!.artist, durationSecs: track!.durationSecs,
      },
    }).then((isSent) => {
      showNotification({ message: { key: isSent ? 'MusicTrackSent' : 'MusicTrackNotSent' } });
    }).catch(() => {
      showNotification({ message: { key: 'MusicTrackNotSent' } });
    });
  }

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
    <SendRecipientScreen
      isOpen={Boolean(track || catalog || playlist)}
      preview={preview}
      onSend={handleSend}
      onClose={onClose}
    />
  );
};

export default memo(MusicSendDialog);
