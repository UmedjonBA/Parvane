import type { ChangeEvent } from 'react';
import {
  memo, useEffect, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ParvaneAuthContext } from '../../api/parvane/authApi';
import type { GlobalState } from '../../global/types';

import buildClassName from '../../util/buildClassName';
import {
  checkParvaneTelegramConfirmation, confirmParvaneLoginWithKey, fetchParvaneAuthContext, renewParvaneTelegramLink,
} from '../../api/parvane/authApi';

import useAppLayout from '../../hooks/useAppLayout';
import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import { AuthBar, AuthLogo, AuthNotice } from './AuthParts';
import AuthTelegramQr from './AuthTelegramQr';

import styles from './Auth.module.scss';

type StateProps = Pick<GlobalState, 'auth'>;

const STEP = 2;
const TOTAL_STEPS = 3;
const TELEGRAM_STEP_EVENT = 'parvane-telegram-step';

// Parvane: подтверждение через Telegram-бота сервера (состояние `WaitQrCode`) — аккаунта при регистрации либо
// входа при включённой защите. Кнопка открывает ссылку `t.me/<бот>?start=<токен>`; провайдер опрашивает сервер
// и входит сам, когда бот подтвердит. Доски: регистрация — `ZpAuthX` (телефон: «Подтверждение · шаг 2 из 3 ·
// Telegram», «3. Вернитесь сюда»), `ZdAuthX` (компьютер: «Подтвердите аккаунт», чип «Показать QR» в шаге 1); вход с
// защитой — «Прислать ещё раз», «Войти ключом восстановления» (если у аккаунта есть копия корня на сервере) и
// подсказка «кто-то знает ваш пароль». Истёкший запрос — плашка и «Запросить заново» на этом же экране
const AuthTelegram = ({ auth }: StateProps) => {
  const { returnToAuthPhoneNumber } = getActions();

  const [context, setContext] = useState<ParvaneAuthContext | undefined>();
  const [isChecking, setIsChecking] = useState(false);
  const [isRenewing, setIsRenewing] = useState(false);
  const [isRenewFailed, setIsRenewFailed] = useState(false);
  const [isQrShown, showQr, hideQr] = useFlag();
  const [isKeyFormOpen, openKeyForm] = useFlag();
  const [recoveryKey, setRecoveryKey] = useState('');
  const [isKeyBusy, setIsKeyBusy] = useState(false);
  const [isKeyWrong, setIsKeyWrong] = useState(false);

  const lang = useLang();
  const { isMobile } = useAppLayout();

  const isBusy = isChecking || auth.isLoading;
  const link = context?.telegramLink || '';
  const bot = context?.telegramBot || '';
  const nick = context?.nick || '';
  const isLogin = context?.telegramMode === 'login';
  const isExpired = Boolean(context?.isTelegramExpired);

  useEffect(() => {
    let isCancelled = false;
    const readContext = () => {
      void fetchParvaneAuthContext().then((next) => {
        if (!isCancelled && next) setContext(next);
      });
    };
    readContext();
    window.addEventListener(TELEGRAM_STEP_EVENT, readContext);
    return () => {
      isCancelled = true;
      window.removeEventListener(TELEGRAM_STEP_EVENT, readContext);
    };
  }, []);

  const handleCheck = useLastCallback(() => {
    if (isBusy) return;
    setIsChecking(true);
    void checkParvaneTelegramConfirmation().finally(() => setIsChecking(false));
  });

  const handleRenew = useLastCallback(async () => {
    if (isRenewing) return;
    setIsRenewing(true);
    setIsRenewFailed(false);
    const result = await renewParvaneTelegramLink();
    setIsRenewing(false);
    if (result === 'failed') setIsRenewFailed(true);
  });

  const handleKeyInput = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setRecoveryKey(e.currentTarget.value);
    setIsKeyWrong(false);
  });

  const handleKeySubmit = useLastCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const key = recoveryKey.trim();
    if (!key || isKeyBusy) return;
    setIsKeyBusy(true);
    const result = await confirmParvaneLoginWithKey(key);
    setIsKeyBusy(false);
    if (result === 'bad_key' || result === 'failed') setIsKeyWrong(true);
  });

  const handleBack = useLastCallback(() => {
    returnToAuthPhoneNumber();
  });

  const title = lang(isLogin ? 'ParvaneAuthTelegramLoginTitle' : 'ParvaneAuthTelegramAccountTitle');
  const barTitle = isLogin ? title : lang('ParvaneAuthConfirmTitle');
  const text = isLogin ? lang('ParvaneAuthTelegramLoginText')
    : lang(isMobile ? 'ParvaneAuthTelegramAccountTextPhone' : 'ParvaneAuthTelegramAccountText');
  const step = isLogin ? undefined : lang('ParvaneAuthStep', { step: STEP, total: TOTAL_STEPS });
  const barStep = isLogin ? undefined : lang('ParvaneAuthStepTelegram', { step: STEP, total: TOTAL_STEPS });
  const account = nick ? `@${nick}` : undefined;
  const canUseKey = isLogin && Boolean(context?.canUseRecoveryKey);

  function renderSteps() {
    return (
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
              {link && !isMobile && lang('ParvaneAuthTelegramStepOpenQrHint')}
            </span>
          </span>
          {link && (
            <a className={styles.chip} href={link} target="_blank" rel="noopener noreferrer" data-telegram-open>
              {lang('Open')}
            </a>
          )}
          {link && !isMobile && (
            <button
              type="button"
              className={styles.chip}
              aria-expanded={isQrShown}
              data-telegram-qr
              onClick={isQrShown ? hideQr : showQr}
            >
              {lang(isQrShown ? 'ParvaneAuthTelegramQrChipHide' : 'ParvaneAuthTelegramQrChip')}
            </button>
          )}
        </div>
        <div className={styles.stepRow}>
          <span className={buildClassName(styles.dot, styles.stepDot, styles.dotAccent)} />
          <span className={styles.grow}>
            {lang('ParvaneAuthTelegramStepStart')}
            <span className={styles.stepHint}>
              {lang(isMobile ? 'ParvaneAuthTelegramStepStartHint' : 'ParvaneAuthTelegramStepStartHintDesktop')}
            </span>
          </span>
        </div>
        <div className={styles.stepRow}>
          <span className={buildClassName(styles.dot, styles.stepDot)} />
          <span className={styles.grow}>
            {renderLastStep()}
          </span>
        </div>
      </div>
    );
  }

  function renderLastStep() {
    if (isLogin) {
      return (
        <>
          {lang('ParvaneAuthTelegramStepReturn')}
          <span className={styles.stepHint}>{lang('ParvaneAuthTelegramStepReturnHint')}</span>
        </>
      );
    }
    if (isMobile) {
      return (
        <>
          {lang('ParvaneAuthTelegramStepReturn')}
          <span className={styles.stepHint}>{lang('ParvaneAuthTelegramStepReturnKeyHint')}</span>
        </>
      );
    }
    return (
      <>
        {lang('ParvaneAuthTelegramStepKey')}
        <span className={styles.stepHint}>{lang('ParvaneAuthTelegramStepKeyHint')}</span>
      </>
    );
  }

  function renderLoginExtras() {
    return (
      <div className={styles.telegramExtras}>
        <div className={styles.telegramLinks}>
          <button
            type="button"
            className={styles.linkInline}
            disabled={isRenewing}
            data-telegram-again
            onClick={handleRenew}
          >
            {lang(isMobile ? 'ParvaneAuthTelegramAgain' : 'ParvaneAuthTelegramAgainShort')}
          </button>
          {canUseKey && !isKeyFormOpen && (
            <button type="button" className={styles.linkInline} data-telegram-use-key onClick={openKeyForm}>
              {lang('ParvaneAuthTelegramUseKey')}
            </button>
          )}
        </div>
        {canUseKey && isKeyFormOpen && (
          <form className={styles.form} action="" noValidate data-telegram-key-form onSubmit={handleKeySubmit}>
            <label className={styles.fieldLabel} htmlFor="auth-telegram-recovery-key">
              {lang('ParvaneConfirmKeyLabel')}
            </label>
            <input
              id="auth-telegram-recovery-key"
              className={buildClassName(styles.input, styles.inputMono, isKeyWrong && styles.inputError)}
              type="text"
              value={recoveryKey}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={isKeyWrong}
              data-telegram-key-input
              onChange={handleKeyInput}
            />
            {isKeyWrong && (
              <span className={buildClassName(styles.hint, styles.hintError)} role="alert" data-telegram-key-error>
                {lang('ParvaneAuthTelegramKeyWrong')}
              </span>
            )}
            <button
              type="submit"
              className={buildClassName(styles.button, isKeyBusy && styles.buttonBusy)}
              disabled={!recoveryKey.trim() || isKeyBusy}
              aria-busy={isKeyBusy}
              data-telegram-key-submit
            >
              {isKeyBusy && <span className={styles.spinner} />}
              {lang('ParvaneAuthLogIn')}
            </button>
          </form>
        )}
        <p className={styles.note}>{lang('ParvaneAuthTelegramNotYou')}</p>
      </div>
    );
  }

  return (
    <div
      id="auth-telegram-form"
      className={styles.root}
      data-telegram-mode={isLogin ? 'login' : 'register'}
      data-telegram-expired={isExpired ? 'true' : undefined}
    >
      <AuthBar title={barTitle} subtitle={isLogin ? account : barStep} isLined onBack={handleBack} />
      <div className={styles.page}>
        <div className={buildClassName(styles.dialog, styles.dialogWide)}>
          <div className={styles.onlyDesk}><AuthLogo isSmall /></div>
          <div className={styles.head}>
            <h1 className={buildClassName(styles.headTitle, styles.grow)}>{title}</h1>
            {step && <span className={styles.step}>{step}</span>}
          </div>
          <p className={styles.text}>{text}</p>
          {account && <p className={buildClassName(styles.small, styles.onlyDesk)}>{account}</p>}
          {isExpired && (
            <AuthNotice
              tone="orange"
              title={lang('ParvaneAuthTelegramExpired')}
              text={isRenewFailed ? lang('ParvaneAuthTelegramRenewFailed') : undefined}
            >
              <button
                type="button"
                className={styles.chip}
                disabled={isRenewing}
                data-telegram-renew
                onClick={handleRenew}
              >
                {lang('ParvaneAuthTelegramRenew')}
              </button>
            </AuthNotice>
          )}
          {renderSteps()}
          {link && isQrShown && !isMobile && <AuthTelegramQr link={link} />}
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
              disabled={isExpired}
              data-telegram-check
              onClick={handleCheck}
            >
              {isBusy && <span className={styles.spinner} />}
              {lang('ParvaneTelegramCheck')}
            </button>
          </div>
          {link && isMobile && (
            <button
              type="button"
              className={styles.linkInline}
              aria-expanded={isQrShown}
              data-telegram-qr
              onClick={isQrShown ? hideQr : showQr}
            >
              {lang(isQrShown ? 'ParvaneAuthTelegramQrHide' : 'ParvaneAuthTelegramQrShow')}
            </button>
          )}
          {link && isQrShown && isMobile && <AuthTelegramQr link={link} />}
          {isLogin && renderLoginExtras()}
          <p className={styles.note}>
            {lang('ParvaneAuthTelegramExpiryLogin')}
          </p>
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
