import { memo } from '../../../lib/teact/teact';

import type { CloudLinkSource } from './cloudStore';

import { getCloudLinks, linkOfSource } from './cloudStore';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';

import PvSheet from '../notes/PvSheet';
import CloudLinkBlock from './CloudLinkBlock';

// Чья шторка открыта: узел дерева (ссылка ищется по источнику либо создаётся) или строка «Моих ссылок»
export type CloudLinkTarget = { source: CloudLinkSource } | { linkId: string };

type OwnProps = {
  target?: CloudLinkTarget;
  onClose: NoneToVoidFunction;
};

// Шторка «Ссылка» файла либо папки (spec 022)
const CloudLinkDialog = ({ target, onClose }: OwnProps) => {
  const lang = useLang();
  const links = useDerivedState(getCloudLinks);
  // Пока шторка закрывается, содержимое остаётся прежним
  const shown = useCurrentOrPrev(target, true);

  const source = shown && 'source' in shown ? shown.source : undefined;
  const link = !shown ? undefined
    : 'linkId' in shown ? links?.find((l) => l.id === shown.linkId) : linkOfSource(links, shown.source);
  const name = source?.name || link?.name;

  return (
    <PvSheet
      isOpen={Boolean(target)}
      title={name ? lang('ParvaneCloudLinkTitle', { name }) : lang('ParvaneCloudLinkHeading')}
      onClose={onClose}
    >
      <div data-cloud-link-sheet>
        <CloudLinkBlock link={link} source={source} onRevoked={source ? undefined : onClose} />
      </div>
    </PvSheet>
  );
};

export default memo(CloudLinkDialog);
