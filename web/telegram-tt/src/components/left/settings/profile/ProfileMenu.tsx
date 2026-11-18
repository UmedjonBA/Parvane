import { memo } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { ProfileItem, ProfileItemId } from './profileMenu';

import buildClassName from '../../../../util/buildClassName';
import { openBugReport } from '../../../../util/parvaneDiag';
import { PROFILE_GROUPS } from './profileMenu';

import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import DataExportModal from '../../../parvane/export/DataExportModal';
import ProfileIcon from './ProfileIcon';
import ProfileSignOutDialog from './ProfileSignOutDialog';

import styles from './Profile.module.scss';

type OwnProps = {
  // `list` — экран телефона (строки с подписью справа и стрелкой), `nav` — колонка компьютера
  variant: 'list' | 'nav';
  activeId?: ProfileItemId;
  values?: Partial<Record<ProfileItemId, string>>;
};

const ProfileMenu = ({ variant, activeId, values }: OwnProps) => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const [isExportOpen, openExport, closeExport] = useFlag();
  const [isSignOutOpen, openSignOut, closeSignOut] = useFlag();
  const isNav = variant === 'nav';

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const id = e.currentTarget.dataset.profileItem as ProfileItemId;
    const item = PROFILE_GROUPS.flatMap((group) => group.items).find((candidate) => candidate.id === id);
    if (!item) return;
    if (item.screen !== undefined) {
      openSettingsScreen({ screen: item.screen });
    } else if (id === 'export') {
      openExport();
    } else if (id === 'bug') {
      openBugReport();
    } else if (id === 'signOut') {
      openSignOut();
    }
  });

  function renderItem(item: ProfileItem) {
    const isOn = isNav && item.id === activeId;
    const value = values?.[item.id];
    return (
      <button
        key={item.id}
        type="button"
        className={buildClassName(
          isNav ? styles.navItem : styles.menuRow, isOn && styles.navItemOn, item.isDanger && styles.danger,
        )}
        data-profile-item={item.id}
        data-settings-sign-out={item.id === 'signOut' ? '' : undefined}
        data-export-open={item.id === 'export' ? '' : undefined}
        aria-current={isOn ? 'page' : undefined}
        onClick={handleClick}
      >
        <ProfileIcon
          name={item.icon}
          isSmall={isNav}
          className={buildClassName(styles.menuIcon, !isNav && item.isAccent && styles.menuIconAccent)}
        />
        <span className={styles.menuTitle}>{lang(item.titleKey)}</span>
        {!isNav && value && <span className={styles.menuValue}>{value}</span>}
        {!isNav && <ProfileIcon name="right" isSmall className={styles.menuChevron} />}
      </button>
    );
  }

  return (
    <>
      {PROFILE_GROUPS.map((group) => {
        const items = group.items.filter((item) => isNav || !item.isNavOnly);
        if (!items.length) return undefined;
        return (
          <div key={group.id} className={isNav ? styles.navGroup : styles.menuGroup}>
            {group.titleKey && (
              <div className={isNav ? styles.navCaption : styles.caption}>{lang(group.titleKey)}</div>
            )}
            <div className={isNav ? styles.navItems : styles.group}>{items.map(renderItem)}</div>
          </div>
        );
      })}
      <DataExportModal isOpen={isExportOpen} onClose={closeExport} />
      <ProfileSignOutDialog isOpen={isSignOutOpen} onClose={closeSignOut} />
    </>
  );
};

export default memo(ProfileMenu);
