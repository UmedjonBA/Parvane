import { memo } from '../../../lib/teact/teact';

import type { CloudLinkSource } from './cloudStore';

import { getCloudLinks, linkOfSource } from './cloudStore';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useWindowSize from '../../../hooks/window/useWindowSize';

import PvSheet from '../notes/PvSheet';
import CloudLinkBlock from './CloudLinkBlock';

import styles from './CloudSheets.module.scss';

// Чья шторка открыта: узел дерева (ссылка ищется по источнику либо создаётся) или строка «Моих ссылок»
export type CloudLinkTarget = { source: CloudLinkSource } | { linkId: string };

type OwnProps = {
  target?: CloudLinkTarget;
  onClose: NoneToVoidFunction;
};

// Как в стилях: уже — раскладка телефона
const NARROW_WIDTH = 760;

// Шторка «Ссылка» файла либо папки (spec 022, доски `PhFilesMore`, `DkFilesDialogs`): под названием — для кого
// ссылка и где ключ; отзыв закрывает окно
const CloudLinkDialog = ({ target, onClose }: OwnProps) => {
  const lang = useLang();
  const links = useDerivedState(getCloudLinks);
  // Пока шторка закрывается, содержимое остаётся прежним
  const shown = useCurrentOrPrev(target, true);

  const source = shown && 'source' in shown ? shown.source : undefined;
  const link = !shown ? undefined
    : 'linkId' in shown ? links?.find((l) => l.id === shown.linkId) : linkOfSource(links, shown.source);
  const name = source?.name || link?.name;
  const { width } = useWindowSize();
  const isWide = width > NARROW_WIDTH;

  return (
    <PvSheet
      isOpen={Boolean(target)}
      className={styles.narrow}
      title={name ? lang('ParvaneCloudLinkTitle', { name }) : lang('ParvaneCloudLinkHeading')}
      subtitle={lang('ParvaneCloudLinkSubtitle')}
      onClose={onClose}
    >
      <div data-cloud-link-sheet>
        <CloudLinkBlock
          link={link}
          source={source}
          isWide={isWide}
          onRevoked={onClose}
          onDone={isWide ? onClose : undefined}
        />
      </div>
    </PvSheet>
  );
};

export default memo(CloudLinkDialog);
