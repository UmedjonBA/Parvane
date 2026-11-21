import { memo, useRef } from '../../../lib/teact/teact';
import { withGlobal } from '../../../global';

import type { ApiUser } from '../../../api/types';
import type { PaneState } from '../hooks/useHeaderPane';

import { selectUser } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { getBlockedDomains } from '../../../util/parvaneFederationBlock';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useHeaderPane from '../hooks/useHeaderPane';

import styles from './KeyChangePane.module.scss';

type OwnProps = {
  chatId: string;
  onPaneStateChange?: (state: PaneState) => void;
};

type StateProps = {
  user?: ApiUser;
};

// Плашка «Переписка с этим сервером выключена администратором вашего сервера» над лентой чата с собеседником
// заблокированного либо выключенного сервера (доска `ZpChat`); снимается удачной отправкой на этот сервер
const FederationBlockPane = ({ user, onPaneStateChange }: OwnProps & StateProps) => {
  const lang = useLang();
  const blocked = useDerivedState(getBlockedDomains);
  const transitionRef = useRef<HTMLDivElement>();
  const domain = user?.serverDomain?.toLowerCase();
  const isOpen = Boolean(domain && blocked[domain]);

  const { ref, shouldRender } = useHeaderPane({
    isOpen,
    ref: transitionRef,
    onStateChange: onPaneStateChange,
  });

  if (!shouldRender) return undefined;

  return (
    <div ref={ref} className={buildClassName(styles.root, styles.service)} role="status" data-federation-blocked>
      <span className={styles.text}>{lang('ParvaneFederationBlockedPane')}</span>
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global, { chatId }): Complete<StateProps> => ({
  user: selectUser(global, chatId),
}))(FederationBlockPane));
