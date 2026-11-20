import { memo, useMemo } from '../../../lib/teact/teact';

import type { CloudResult } from '../../../api/parvane/cloudDrive';
import type { SendPreview } from '../../main/SendRecipientScreen';
import type { CloudNode } from './cloudModel';

import { formatFileSize } from '../../../util/textFormat';
import { callApi } from '../../../api/gramjs';
import { showCloudNotice } from './cloudStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import SendRecipientScreen from '../../main/SendRecipientScreen';

type OwnProps = {
  entries?: { container: string; node: CloudNode }[];
  onClose: NoneToVoidFunction;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// «Отправить в чат»: выбор чатов с подписью (доска `RpPick`); файл уходит копией блоба на сервере, без скачивания
const CloudSendDialog = ({ entries, onClose }: OwnProps) => {
  const lang = useLang();

  const preview = useMemo((): SendPreview | undefined => {
    if (!entries?.length) return undefined;
    const size = entries.reduce((sum, e) => sum + (e.node.size || 0), 0);
    return {
      title: entries.length === 1
        ? entries[0].node.name
        : lang('SendPickerFiles', { count: entries.length }, { pluralValue: entries.length }),
      subtitle: lang('SendPickerFromFiles', { size: formatFileSize(lang, size) }),
    };
  }, [entries, lang]);

  const handleSend = useLastCallback((chatIds: string[], caption: string) => {
    const list = entries || [];
    onClose();
    const byContainer = new Map<string, string[]>();
    list.forEach((e) => byContainer.set(e.container, [...(byContainer.get(e.container) || []), e.node.id]));
    chatIds.forEach((chatId) => byContainer.forEach((nodes, container) => {
      void callParvane('parvaneCloudSendToChat', {
        container, nodes, chatId, caption: caption || undefined,
      }).then((result) => {
        const r = result as CloudResult | undefined;
        showCloudNotice(r?.ok ? 'sent' : r?.error || 'rejected');
      }).catch(() => showCloudNotice('rejected'));
    }));
  });

  return (
    <SendRecipientScreen
      isOpen={Boolean(entries?.length)}
      preview={preview}
      onSend={handleSend}
      onClose={onClose}
    />
  );
};

export default memo(CloudSendDialog);
