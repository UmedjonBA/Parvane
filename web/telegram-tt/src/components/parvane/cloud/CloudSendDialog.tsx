import { memo } from '../../../lib/teact/teact';

import type { CloudResult } from '../../../api/parvane/cloudDrive';
import type { CloudNode } from './cloudModel';

import { callApi } from '../../../api/gramjs';
import { showCloudNotice } from './cloudStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';

type OwnProps = {
  entries?: { container: string; node: CloudNode }[];
  onClose: NoneToVoidFunction;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// «Отправить в чат»: выбор чата; файл уходит копией блоба на сервере, без скачивания
const CloudSendDialog = ({ entries, onClose }: OwnProps) => {
  const lang = useLang();

  const handleSelect = useLastCallback((chatId: string) => {
    const list = entries || [];
    onClose();
    const byContainer = new Map<string, string[]>();
    list.forEach((e) => byContainer.set(e.container, [...(byContainer.get(e.container) || []), e.node.id]));
    byContainer.forEach((nodes, container) => {
      void callParvane('parvaneCloudSendToChat', { container, nodes, chatId }).then((result) => {
        const r = result as CloudResult | undefined;
        showCloudNotice(r?.ok ? 'sent' : r?.error || 'rejected');
      }).catch(() => showCloudNotice('rejected'));
    });
  });

  return (
    <RecipientPicker
      isOpen={Boolean(entries?.length)}
      title={lang('ParvaneCloudSendToChat')}
      searchPlaceholder={lang('Search')}
      onSelectRecipient={handleSelect}
      onClose={onClose}
    />
  );
};

export default memo(CloudSendDialog);
