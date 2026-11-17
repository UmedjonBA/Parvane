import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';

type OwnProps = {
  track?: MusicTrack;
  onClose: NoneToVoidFunction;
};

// Parvane (TRACK-1): «в чат» — выбор чата; уходит карточка трека, получатель играет его из библиотеки сервера
type SendTrack = (name: 'parvaneSendMusicTrack', args: {
  chatId: string;
  track: { id: string; title: string; artist: string; durationSecs: number };
}) => Promise<boolean | undefined>;
// Метод Parvane: типы `callApi` описывают только методы Telegram
const callSend = callApi as unknown as SendTrack;

const MusicSendDialog = ({ track, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();

  const handleSelect = useLastCallback((chatId: string) => {
    const sent = track!;
    onClose();
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

  return (
    <RecipientPicker
      isOpen={Boolean(track)}
      title={lang('MusicSendToChat')}
      searchPlaceholder={lang('Search')}
      onSelectRecipient={handleSelect}
      onClose={onClose}
    />
  );
};

export default memo(MusicSendDialog);
