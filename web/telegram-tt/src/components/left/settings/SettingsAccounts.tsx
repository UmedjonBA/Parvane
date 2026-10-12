import { memo, useMemo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiUser } from '../../../api/types';
import type { CustomPeer } from '../../../types';

import { temporarilySuspendCacheUpdate } from '../../../global/cache';
import { getCurrentMaxAccountCount, getCurrentProdAccountCount } from '../../../global/helpers';
import { selectPremiumLimit } from '../../../global/selectors/limits';
import { IS_SAFARI } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import { getAccountSlotUrl } from '../../../util/multiaccount';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMultiaccountInfo from '../../../hooks/useMultiaccountInfo';

import Avatar from '../../common/Avatar';
import ParvaneIcon from '../../main/ParvaneIcon';

import styles from './SettingsMain.module.scss';

type OwnProps = {
  currentUser: ApiUser;
};

type StateProps = {
  totalLimit: number;
};

const NOTIFICATION_DURATION = 7000;

// Parvane: другие аккаунты этого браузера и «Добавить аккаунт» — прежде верх меню «☰» списка чатов.
// Текущий аккаунт — карточка над этим блоком
const SettingsAccounts = ({ currentUser, totalLimit }: OwnProps & StateProps) => {
  const { showNotification } = getActions();

  const lang = useLang();
  const accounts = useMultiaccountInfo(currentUser);

  const currentCount = getCurrentProdAccountCount();
  const isLimitReached = currentCount >= getCurrentMaxAccountCount();

  const otherSlots = useMemo(() => {
    return Object.keys(accounts).filter((slot) => accounts[Number(slot)].userId !== currentUser.id);
  }, [accounts, currentUser.id]);

  const newAccountUrl = useMemo(() => {
    if (!Object.values(accounts).length || currentCount === totalLimit) return undefined;

    let freeIndex = 1;
    while (accounts[freeIndex]) {
      freeIndex += 1;
    }

    return getAccountSlotUrl(freeIndex, true);
  }, [accounts, currentCount, totalLimit]);

  // IDB locks up if we write large payload on navigation
  const handleAccountClick = useLastCallback(() => {
    if (IS_SAFARI) temporarilySuspendCacheUpdate();
  });

  const handleNewAccountClick = useLastCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isLimitReached) {
      handleAccountClick();
      return;
    }

    e.preventDefault();
    showNotification({
      title: lang('PremiumLimitAccountsTitle'),
      message: lang('PremiumLimitAccountsNoPremium'),
      duration: NOTIFICATION_DURATION,
    });
  });

  if (!otherSlots.length && !newAccountUrl) return undefined;

  return (
    <div className={styles.card}>
      {otherSlots.map((slot) => {
        const account = accounts[Number(slot)];
        const peer: CustomPeer = {
          title: [account.firstName, account.lastName].filter(Boolean).join(' '),
          isCustomPeer: true,
          peerColorId: account.color,
        };

        return (
          <a key={slot} className={styles.row} href={getAccountSlotUrl(Number(slot))} onClick={handleAccountClick}>
            <Avatar size="small" className={styles.avatar} peer={peer} previewUrl={account.avatarUri} />
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{peer.title}</span>
            </span>
            <ParvaneIcon name="right" isSmall className={styles.chevron} />
          </a>
        );
      })}
      {newAccountUrl && (
        // Без `noreferrer`: новая вкладка аккаунта узнаёт, откуда пришла
        <a className={styles.row} href={newAccountUrl} rel="noopener" onClick={handleNewAccountClick}>
          <span className={styles.tile}><ParvaneIcon name="plus" isSmall /></span>
          <span className={buildClassName(styles.rowText, styles.rowTitle)}>{lang('MenuAddAccount')}</span>
        </a>
      )}
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => ({
    totalLimit: selectPremiumLimit(global, 'moreAccounts'),
  }),
)(SettingsAccounts));
