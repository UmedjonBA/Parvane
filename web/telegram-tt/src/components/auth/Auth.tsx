import '../../global/actions/initial';

import { memo } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_MAC_OS, PLATFORM_ENV } from '../../util/browser/windowEnvironment';

import useCurrentOrPrev from '../../hooks/useCurrentOrPrev';
import useHistoryBack from '../../hooks/useHistoryBack';

import Transition from '../ui/Transition';
import AuthCode from './AuthCode.async';
import AuthLogin from './AuthLogin';
import AuthRegister from './AuthRegister';
import AuthTelegram from './AuthTelegram';

import './Auth.scss';

type StateProps = {
  authState: GlobalState['auth']['state'];
};

const Auth = ({
  authState,
}: StateProps) => {
  const {
    returnToAuthPhoneNumber, goToAuthQrCode,
  } = getActions();

  const isMobile = PLATFORM_ENV === 'iOS' || PLATFORM_ENV === 'Android';

  const handleChangeAuthorizationMethod = () => {
    if (!isMobile) {
      goToAuthQrCode();
    } else {
      returnToAuthPhoneNumber();
    }
  };

  useHistoryBack({
    isActive: (!isMobile && authState === 'authorizationStateWaitPhoneNumber')
      || (isMobile && authState === 'authorizationStateWaitQrCode'),
    onBack: handleChangeAuthorizationMethod,
  });

  // For animation purposes
  const renderingAuthState = useCurrentOrPrev(
    authState !== 'authorizationStateReady' ? authState : undefined,
    true,
  );

  // Ник и пароль — одна форма входа: шаг пароля тот же экран, без смены слайда
  function getScreen() {
    switch (renderingAuthState) {
      case 'authorizationStateWaitCode':
        return <AuthCode />;
      case 'authorizationStateWaitRegistration':
        return <AuthRegister />;
      // Parvane: `WaitQrCode` — подтверждение в Telegram-боте сервера
      case 'authorizationStateWaitQrCode':
        return <AuthTelegram />;
      default:
        return <AuthLogin isPasswordStep={renderingAuthState === 'authorizationStateWaitPassword'} />;
    }
  }

  function getActiveKey() {
    switch (renderingAuthState) {
      case 'authorizationStateWaitCode':
        return 0;
      case 'authorizationStateWaitRegistration':
        return 2;
      case 'authorizationStateWaitQrCode':
        return 4;
      default:
        return 3;
    }
  }

  return (
    <Transition
      activeKey={getActiveKey()}
      name="fade"
      className="Auth"
      data-tauri-drag-region={IS_TAURI && IS_MAC_OS ? true : undefined}
    >
      {getScreen()}
    </Transition>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    return {
      authState: global.auth.state,
    };
  },
)(Auth));
