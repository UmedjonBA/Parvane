import { memo, useRef } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiUser } from '../../../api/types';
import type { PaneState } from '../hooks/useHeaderPane';

import { getUserFirstOrLastName } from '../../../global/helpers';
import { selectUser } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { clearKeyChanged, getKeyChangedChats } from '../../../util/parvaneKeyChange';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useHeaderPane from '../hooks/useHeaderPane';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './KeyChangePane.module.scss';

type OwnProps = {
  chatId: string;
  onPaneStateChange?: (state: PaneState) => void;
};

type StateProps = {
  user?: ApiUser;
};

// Плашка «Ключ безопасности изменился · Сверить» над лентой личного чата (доска `ZpChat`). «Сверить» открывает
// профиль собеседника со сверкой отпечатков; после этого плашка уходит
const KeyChangePane = ({ chatId, user, onPaneStateChange }: OwnProps & StateProps) => {
  const { openChatWithInfo } = getActions();
  const lang = useLang();
  const changed = useDerivedState(getKeyChangedChats);
  const transitionRef = useRef<HTMLDivElement>();
  const isOpen = Boolean(user) && changed.includes(chatId);

  const { ref, shouldRender } = useHeaderPane({
    isOpen,
    ref: transitionRef,
    onStateChange: onPaneStateChange,
  });

  const handleVerify = useLastCallback(() => {
    clearKeyChanged(chatId);
    openChatWithInfo({ id: chatId });
  });

  if (!shouldRender || !user) return undefined;

  return (
    <div ref={ref} className={styles.root} role="status" data-key-change-pane>
      <i className={buildClassName('icon icon-lock', styles.icon)} aria-hidden />
      <span className={styles.text}>
        {lang('KeyChangedPane', { name: getUserFirstOrLastName(user) || '' }, { withNodes: true, withMarkdown: true })}
      </span>
      <button type="button" className={buildClassName(kit.btn, styles.verify)} onClick={handleVerify}>
        {lang('KeyChangedVerify')}
      </button>
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global, { chatId }): Complete<StateProps> => ({
  user: selectUser(global, chatId),
}))(KeyChangePane));
