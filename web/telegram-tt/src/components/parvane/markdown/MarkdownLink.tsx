import type { TeactNode } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import { handleMarkdownLinkClick } from './linkConfirm';

import useLastCallback from '../../../hooks/useLastCallback';

type OwnProps = {
  url: string;
  // Видимая подпись — с ней сверяется адрес (C7-4)
  text: string;
  className?: string;
  children?: TeactNode;
};

// Внешняя ссылка заметки и статьи: переход через окно подтверждения, когда подпись не совпадает с адресом (C7-4)
const MarkdownLink = ({
  url, text, className, children,
}: OwnProps) => {
  const handleClick = useLastCallback((e: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
    handleMarkdownLinkClick(e, text, url, getActions().openUrl);
  });

  return (
    <a
      className={className}
      href={url}
      title={url}
      target="_blank"
      rel="noopener noreferrer"
      data-md-link
      onClick={handleClick}
      onAuxClick={handleClick}
    >
      {children || text}
    </a>
  );
};

export default MarkdownLink;
