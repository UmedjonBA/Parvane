import { memo, useMemo } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { MusicPlaylist, MusicTrack } from '../../../api/parvane/musicApi';
import type { PlaylistShareTrack } from '../../../api/parvane/musicPlaylistContent';
import type { SendPreview } from '../../main/SendRecipientScreen';

import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import SendRecipientScreen from '../../main/SendRecipientScreen';

type OwnProps = {
  track?: MusicTrack;
  playlist?: MusicPlaylist;
  onClose: NoneToVoidFunction;
};

// Parvane (TRACK-1, PLAYLIST-1; доска `RpPick`): «в чат» — экран «Кому отправить» с карточкой «название ·
// исполнитель · трек», несколькими чатами и подписью; уходит карточка трека либо плейлиста (подпись — сообщением перед
// ней), получатель играет треки из библиотеки сервера
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
const callText = callApi as unknown as (name: 'sendMessage', args: { chat: unknown; text: string }) => Promise<unknown>;

const MusicSendDialog = ({ track, playlist, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const preview = useMemo<SendPreview | undefined>(() => {
    if (playlist) {
      return { title: playlist.name, subtitle: lang('MusicSendPlaylistPreview', { count: playlist.items.length }) };
    }
    return track && { title: track.title, subtitle: lang('MusicSendTrackPreview', { artist: track.artist }) };
  }, [track, playlist, lang]);

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
      isOpen={Boolean(track || playlist)}
      preview={preview}
      onSend={handleSend}
      onClose={onClose}
    />
  );
};

export default memo(MusicSendDialog);
