import {
  memo, useEffect, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { checkParvaneTelegramConfirmation, fetchParvaneAuthContext } from '../../api/parvane/authApi';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import Loading from '../ui/Loading';

type StateProps = Pick<GlobalState, 'auth'>;

// Parvane: подтверждение регистрации через Telegram-бота (состояние
// WaitQrCode). Кнопка открывает deep link t.me/<bot>?start=<token>; провайдер
// опрашивает статус и логинит сам, когда бот подтвердит аккаунт
const AuthParvaneTelegram = ({ auth }: StateProps) => {
  const { returnToAuthPhoneNumber } = getActions();

  const [link, setLink] = useState('');
  const [nick, setNick] = useState('');
  const [isChecking, setIsChecking] = useState(false);

  const lang = useLang();

  const { isLoading: authIsLoading } = auth;

  useEffect(() => {
    let isCancelled = false;
    void fetchParvaneAuthContext().then((context) => {
      if (isCancelled || !context) return;
      setLink(context.telegramLink);
      setNick(context.nick);
    });
    return () => {
      isCancelled = true;
    };
  }, []);

  const handleOpen = useLastCallback(() => {
    if (!link) return;
    window.open(link, '_blank', 'noopener');
  });

  const handleCheck = useLastCallback(() => {
    if (isChecking) return;
    setIsChecking(true);
    void checkParvaneTelegramConfirmation().finally(() => setIsChecking(false));
  });

  const handleCancel = useLastCallback(() => {
    returnToAuthPhoneNumber();
  });

  return (
    <div id="auth-telegram-form" className="custom-scroll">
      <div className="auth-form">
        <div id="logo" />
        <h1>{lang('ParvaneTelegramTitle')}</h1>
        {nick && (
          <p className="note">
            @
            {nick}
          </p>
        )}
        <p className="note">{lang('ParvaneTelegramText')}</p>
        <Button
          className="auth-button"
          ripple
          disabled={!link}
          onClick={handleOpen}
        >
          {lang('ParvaneTelegramOpen')}
        </Button>
        {link && (
          <p className="note">
            <a id="auth-telegram-link" href={link} target="_blank" rel="noopener noreferrer">{link}</a>
          </p>
        )}
        <Loading />
        <p className="note">{lang('ParvaneTelegramWaiting')}</p>
        <Button
          className="auth-button"
          isText
          isLoading={isChecking || authIsLoading}
          onClick={handleCheck}
        >
          {lang('ParvaneTelegramCheck')}
        </Button>
        <Button className="auth-button" isText onClick={handleCancel}>
          {lang('Cancel')}
        </Button>
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    return {
      auth: global.auth,
    };
  },
)(AuthParvaneTelegram));
