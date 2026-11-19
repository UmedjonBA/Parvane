import {
  memo, useEffect, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import buildClassName from '../../util/buildClassName';
import { checkParvaneTelegramConfirmation, fetchParvaneAuthContext } from '../../api/parvane/authApi';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import { AuthBar, AuthLogo } from './AuthParts';
import AuthTelegramQr from './AuthTelegramQr';

import styles from './Auth.module.scss';

type StateProps = Pick<GlobalState, 'auth'>;

const STEP = 2;
const TOTAL_STEPS = 3;

// Parvane: подтверждение через Telegram-бота сервера (состояние `WaitQrCode`) — аккаунта при регистрации либо
// входа при включённой защите. Кнопка открывает ссылку `t.me/<бот>?start=<токен>`; провайдер опрашивает сервер
// и входит сам, когда бот подтвердит
const AuthTelegram = ({ auth }: StateProps) => {
  const { returnToAuthPhoneNumber } = getActions();

  const [link, setLink] = useState('');
  const [nick, setNick] = useState('');
  const [bot, setBot] = useState('');
  const [isLogin, setIsLogin] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  const lang = useLang();

  const isBusy = isChecking || auth.isLoading;

  useEffect(() => {
    let isCancelled = false;
    void fetchParvaneAuthContext().then((context) => {
      if (isCancelled || !context) return;
      setLink(context.telegramLink);
      setNick(context.nick);
      setBot(context.telegramBot);
      setIsLogin(context.telegramMode === 'login');
    });
    return () => {
      isCancelled = true;
    };
  }, []);

  const handleCheck = useLastCallback(() => {
    if (isBusy) return;
    setIsChecking(true);
    void checkParvaneTelegramConfirmation().finally(() => setIsChecking(false));
  });

  const handleBack = useLastCallback(() => {
    returnToAuthPhoneNumber();
  });

  const title = lang(isLogin ? 'ParvaneAuthTelegramLoginTitle' : 'ParvaneAuthTelegramAccountTitle');
  const text = lang(isLogin ? 'ParvaneAuthTelegramLoginText' : 'ParvaneAuthTelegramAccountText');
  const step = isLogin ? undefined : lang('ParvaneAuthStep', { step: STEP, total: TOTAL_STEPS });
  const account = nick ? `@${nick}` : undefined;

  return (
    <div id="auth-telegram-form" className={styles.root} data-telegram-mode={isLogin ? 'login' : 'register'}>
      <AuthBar title={title} subtitle={account} step={step} isLined onBack={handleBack} />
      <div className={styles.page}>
        <div className={buildClassName(styles.dialog, styles.dialogWide)}>
          <div className={styles.onlyDesk}><AuthLogo isSmall /></div>
          <div className={styles.head}>
            <h1 className={buildClassName(styles.headTitle, styles.grow)}>{title}</h1>
            {step && <span className={styles.step}>{step}</span>}
          </div>
          <p className={styles.text}>{text}</p>
          {account && <p className={buildClassName(styles.small, styles.onlyDesk)}>{account}</p>}
          <div className={styles.steps}>
            <div className={styles.stepRow}>
              <span className={buildClassName(styles.dot, styles.stepDot, styles.dotAqua)} />
              <span className={styles.grow}>
                {lang('ParvaneAuthTelegramStepOpen')}
                <span className={styles.stepHint}>
                  {link ? (
                    <a
                      id="auth-telegram-link"
                      className={styles.stepLink}
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {bot ? `@${bot}` : link}
                    </a>
                  ) : lang('Loading')}
                </span>
              </span>
              {link && (
                <a className={styles.chip} href={link} target="_blank" rel="noopener noreferrer" data-telegram-open>
                  {lang('Open')}
                </a>
              )}
            </div>
            <div className={styles.stepRow}>
              <span className={buildClassName(styles.dot, styles.stepDot, styles.dotAccent)} />
              <span className={styles.grow}>
                {lang('ParvaneAuthTelegramStepStart')}
                <span className={styles.stepHint}>{lang('ParvaneAuthTelegramStepStartHint')}</span>
              </span>
            </div>
            <div className={styles.stepRow}>
              <span className={buildClassName(styles.dot, styles.stepDot)} />
              <span className={styles.grow}>
                {lang(isLogin ? 'ParvaneAuthTelegramStepReturn' : 'ParvaneAuthTelegramStepKey')}
                <span className={styles.stepHint}>
                  {lang(isLogin ? 'ParvaneAuthTelegramStepReturnHint' : 'ParvaneAuthTelegramStepKeyHint')}
                </span>
              </span>
            </div>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={buildClassName(
                styles.button, styles.buttonQuiet, styles.actionsButton, styles.actionsStart, styles.onlyDesk,
              )}
              data-auth-back="dialog"
              onClick={handleBack}
            >
              {lang('Back')}
            </button>
            <button
              type="button"
              className={buildClassName(styles.button, styles.actionsButton, isBusy && styles.buttonBusy)}
              aria-busy={isBusy}
              data-telegram-check
              onClick={handleCheck}
            >
              {isBusy && <span className={styles.spinner} />}
              {lang('ParvaneTelegramCheck')}
            </button>
          </div>
          {link && <AuthTelegramQr link={link} />}
          <p className={styles.note}>{lang('ParvaneAuthTelegramExpiry')}</p>
        </div>
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
)(AuthTelegram));
