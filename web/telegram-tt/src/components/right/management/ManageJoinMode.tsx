import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiExportedInvite } from '../../../api/types';

import { callApi } from '../../../api/gramjs';

import useFlag from '../../../hooks/useFlag';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import { IslandDescription } from '../../gili/layout/Island';
import Switch from '../../gili/primitives/Switch';
import ConfirmDialog from '../../ui/ConfirmDialog';
import ListItem from '../../ui/ListItem';

type OwnProps = {
  chatId: string;
  exportedInvites?: ApiExportedInvite[];
};

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;

// Parvane: режим вступления после создания — «по ссылке» либо «по заявке». Режим задаёт вид основной
// ссылки, поэтому смена режима заменяет её (прежняя перестаёт работать) — отсюда подтверждение
const ManageJoinMode = ({ chatId, exportedInvites }: OwnProps) => {
  const { loadExportedChatInvites, showNotification } = getActions();

  const lang = useOldLang();
  const [isConfirmOpen, openConfirm, closeConfirm] = useFlag();
  const [pendingValue, setPendingValue] = useState<boolean | undefined>();

  const primary = exportedInvites?.find(({ isPermanent }) => isPermanent);
  const isByRequest = pendingValue ?? Boolean(primary?.isRequestNeeded);

  // Список ссылок перечитан — показываем то, что получилось на деле
  useEffect(() => {
    setPendingValue(undefined);
  }, [exportedInvites]);

  const handleConfirm = useLastCallback(() => {
    const isEnabled = !isByRequest;
    closeConfirm();
    setPendingValue(isEnabled);
    void callParvane('parvaneSetJoinByRequest', { chatId, isEnabled })
      .catch(() => false)
      .then((isDone) => {
        if (!isDone) {
          setPendingValue(undefined);
          showNotification({ message: lang('ParvaneJoinModeFailed') });
        }
        loadExportedChatInvites({ chatId });
        loadExportedChatInvites({ chatId, isRevoked: true });
      });
  });

  return (
    <>
      <ListItem
        icon="add-user"
        ripple
        disabled={!primary || pendingValue !== undefined}
        onClick={openConfirm}
      >
        <span>{lang('ParvaneJoinByRequest')}</span>
        <Switch id="parvane-join-by-request" checked={isByRequest} />
      </ListItem>
      <IslandDescription>{lang('ParvaneJoinByRequestInfo')}</IslandDescription>
      <ConfirmDialog
        isOpen={isConfirmOpen}
        onClose={closeConfirm}
        text={lang('ParvaneJoinModeConfirm')}
        confirmHandler={handleConfirm}
      />
    </>
  );
};

export default memo(ManageJoinMode);
