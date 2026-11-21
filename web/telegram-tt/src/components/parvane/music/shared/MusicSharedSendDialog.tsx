import { memo } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { PlaylistShareTrack } from '../../../../api/parvane/musicPlaylistContent';
import type { MusicSharedDetails } from '../../../../api/parvane/musicSharedApi';

import { callApi } from '../../../../api/gramjs';
import { ensureJoinKey } from './musicShared';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import RecipientPicker from '../../../common/RecipientPicker';

type OwnProps = {
  details?: MusicSharedDetails;
  onClose: NoneToVoidFunction;
};

type SendPlaylist = (name: 'parvaneSendMusicPlaylist', args: {
  chatId: string;
  playlist: { name: string; tracks: PlaylistShareTrack[]; sharedId?: string; joinKey?: string };
}) => Promise<boolean | undefined>;
// Метод Parvane: типы `callApi` описывают только методы Telegram
const callSend = callApi as unknown as SendPlaylist;

// Parvane (spec 041, MUSIC-3): общий плейлист в чат — «плейлист чата». Владелец отправляет ключ вступления: участники
// чата открывают живой плейлист и добавляют треки (роль «добавляет»); снимок треков — для клиентов без общих
// плейлистов. Не владелец отправляет только снимок (ключа у него нет)
const MusicSharedSendDialog = ({ details, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const handleSelect = useLastCallback(async (chatId: string) => {
    onClose();
    const { playlist, items } = details!;
    const joinKey = playlist.myRole === 'owner' ? await ensureJoinKey(playlist.id) : undefined;
    const isSent = await callSend('parvaneSendMusicPlaylist', {
      chatId,
      playlist: {
        name: playlist.name,
        tracks: items.map((item) => ({
          id: item.trackId, title: item.title, artist: item.artist, durationSecs: item.durationSecs,
        })),
        sharedId: joinKey ? playlist.id : undefined,
        joinKey,
      },
    }).catch(() => false);
    showNotification({ message: { key: isSent ? 'MusicPlaylistSent' : 'MusicPlaylistNotSent' } });
  });

  return (
    <RecipientPicker
      isOpen={Boolean(details)}
      title={lang('MusicSendToChat')}
      searchPlaceholder={lang('Search')}
      onSelectRecipient={handleSelect}
      onClose={onClose}
    />
  );
};

export default memo(MusicSharedSendDialog);
