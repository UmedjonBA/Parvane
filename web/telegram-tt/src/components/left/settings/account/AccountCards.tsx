import { memo } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import { SettingsScreens } from '../../../../types';

import { selectUser } from '../../../../global/selectors';
import buildClassName from '../../../../util/buildClassName';
import { requestPasswordForm } from '../profile/profileRequests';

import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import ProfileSignOutDialog from '../profile/ProfileSignOutDialog';

import kit from '../../../parvane/notes/PvKit.module.scss';
import profile from '../profile/Profile.module.scss';
import styles from './Account.module.scss';

type OwnProps = {
  // Смена ключа подписи устройств возможна только корнем: он на устройстве либо есть его копия (`sskState`)
  canRotateSsk?: boolean;
  onRotateSsk: NoneToVoidFunction;
};

type StateProps = {
  nick?: string;
};

// Parvane (spec 041, доска `DkSettingsA`): «Устройства и аккаунт» — карточка аккаунта (ник, пароль, ключ подписи
// устройств) и «Опасная зона» (выйти на этом устройстве, удалить аккаунт). Строки ведут на прежние действия: ник
// меняется в «Изменить профиль», пароль — формой «Конфиденциальности», ключ подписи — окном ключа восстановления.
// Строки «Ключ восстановления · показать» нет: ключ на устройстве не хранится
const AccountCards = ({ canRotateSsk, nick, onRotateSsk }: OwnProps & StateProps) => {
  const { openSettingsScreen } = getActions();
  const lang = useLang();
  const [isSignOutOpen, openSignOut, closeSignOut] = useFlag();

  const handleNick = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.EditProfile });
  });

  const handlePassword = useLastCallback(() => {
    requestPasswordForm();
    openSettingsScreen({ screen: SettingsScreens.Privacy });
  });

  const handleDelete = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.ParvaneDeleteAccount });
  });

  const rowClass = buildClassName(profile.setRow, profile.setRowAction);

  return (
    <div className={styles.cards}>
      <div className={buildClassName(profile.group, styles.card)} data-account-card>
        <button type="button" className={rowClass} data-account-row="nick" onClick={handleNick}>
          <span className={profile.setTitle}>{lang('ParvaneAccountNick')}</span>
          {nick && <span className={profile.setValue}>{`@${nick}`}</span>}
        </button>
        <button type="button" className={rowClass} data-account-row="password" onClick={handlePassword}>
          <span className={profile.setTitle}>{lang('ParvaneAccountPassword')}</span>
          <span className={profile.setValue}>{lang('ParvaneAccountChange')}</span>
        </button>
        {canRotateSsk && (
          <button type="button" className={rowClass} data-account-row="ssk" onClick={onRotateSsk}>
            <span className={profile.setTitle}>{lang('ParvaneAccountSigningKey')}</span>
            <span className={profile.setValue}>{lang('ParvaneAccountChange')}</span>
          </button>
        )}
      </div>
      <div className={buildClassName(profile.group, styles.card, styles.danger)} data-danger-zone>
        <div className={styles.dangerCaption}>{lang('ParvaneAccountDangerZone')}</div>
        <button type="button" className={buildClassName(kit.btn, kit.btnWide)} onClick={openSignOut}>
          {lang('ParvaneAccountSignOutHere')}
        </button>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnWide, kit.btnDanger)}
          data-delete-account-open
          onClick={handleDelete}
        >
          {lang('ParvaneDeleteAccountTitle')}
        </button>
        <p className={styles.dangerHint}>{lang('ParvaneAccountDeleteHint')}</p>
      </div>
      <ProfileSignOutDialog isOpen={isSignOutOpen} onClose={closeSignOut} />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const user = global.currentUserId ? selectUser(global, global.currentUserId) : undefined;
    return { nick: user?.usernames?.[0]?.username };
  },
)(AccountCards));
