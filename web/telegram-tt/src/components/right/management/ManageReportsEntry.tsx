import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ParvaneReportInbox } from '../../../api/parvane/modReports';
import { ManagementScreens } from '../../../types';

import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island, { IslandTitle } from '../../gili/layout/Island';
import ListItem from '../../ui/ListItem';

type OwnProps = {
  chatId: string;
  isActive: boolean;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Parvane (доска `XpChat`; REPORT-2): раздел «Жалобы» экрана «Тип группы» — переход к жалобам участников с числом
// открытых. Показывается только админу, который вправе удалять сообщения или блокировать
const ManageReportsEntry = ({ chatId, isActive }: OwnProps) => {
  const { requestNextManagementScreen } = getActions();
  const lang = useLang();
  const [openCount, setOpenCount] = useState<number | undefined>();

  useEffect(() => {
    if (!isActive) return;
    void (callParvane('parvaneReportInbox', { chatId }) as Promise<ParvaneReportInbox | undefined>)
      .then((inbox) => setOpenCount(inbox?.open ?? 0));
  }, [chatId, isActive]);

  const handleClick = useLastCallback(() => {
    requestNextManagementScreen({ screen: ManagementScreens.Reports });
  });

  return (
    <>
      <IslandTitle>{lang('ParvaneReportsTitle')}</IslandTitle>
      <Island>
        {/* `data-*` у `ListItem` до DOM не доходят — метка на обёртке */}
        <div data-reports-entry={openCount ?? ''}>
          <ListItem ripple onClick={handleClick}>
            <span className="title">{lang('ParvaneReportsEntry')}</span>
            {Boolean(openCount) && (
              <span className="subtitle">
                {lang('ParvaneReportsNew', { count: openCount }, { pluralValue: openCount })}
              </span>
            )}
          </ListItem>
        </div>
      </Island>
    </>
  );
};

export default memo(ManageReportsEntry);
