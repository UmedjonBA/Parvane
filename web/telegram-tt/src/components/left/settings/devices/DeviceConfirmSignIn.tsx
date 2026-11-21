import { memo, useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { LinkStatus, TelegramRecoveryState } from './useDeviceLink';

import buildClassName from '../../../../util/buildClassName';
import { callApi } from '../../../../api/gramjs';
import { fetchParvaneServerInfo } from '../../../../api/parvane/authApi';

import useAppLayout from '../../../../hooks/useAppLayout';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import styles from './Devices.module.scss';

type OwnProps = {
  linkStatus: LinkStatus;
  onRefresh: NoneToVoidFunction;
  onResetIdentity: NoneToVoidFunction;
};

type RecoverResult = 'ok' | 'bad_key' | 'no_backup' | 'bundle_off' | 'failed';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Бот просит владельца ответить ключом восстановления в Telegram (spec 015)
const TELEGRAM_STATE_KEYS: Partial<Record<TelegramRecoveryState, string>> = {
  waiting: 'ParvaneTgRecoverWaiting',
  joining: 'ParvaneTgRecoverJoining',
  done: 'ParvaneTgRecoverDone',
  failed: 'ParvaneTgRecoverFailed',
  limit: 'ParvaneTgRecoverLimit',
  expired: 'ParvaneTgRecoverExpired',
  intercepted: 'ParvaneTgRecoverIntercepted',
  bundle_off: 'ParvaneRecoverBundleOff',
};

const RECOVER_RESULT_KEYS: Record<RecoverResult, string> = {
  ok: 'ParvaneRecoverDone',
  bad_key: 'ParvaneSskRotationBadKey',
  no_backup: 'ParvaneRecoverNoBackup',
  bundle_off: 'ParvaneRecoverBundleOff',
  failed: 'ParvaneSskRotationFailed',
};

// Parvane (spec 041 E4): «Подтвердите вход» нового устройства по доскам `PhAuth`, `DkAuth`, `ZdAuthX` — три способа
// карточками: код сверки для другого своего устройства (LINK-1), ключ восстановления (RECOVER-1/2, прежние устройства
// остаются), ответ боту в Telegram (RECOVER-2). Внизу — вход без истории (сброс защищённой личности). Логика —
// провайдер; экран показывает его состояние и вызывает прежние действия
const DeviceConfirmSignIn = ({ linkStatus, onRefresh, onResetIdentity }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const { isMobile } = useAppLayout();
  const [recoveryKey, setRecoveryKey] = useState('');
  const [isRecovering, setIsRecovering] = useState(false);
  const [bot, setBot] = useState('');

  useEffect(() => {
    void fetchParvaneServerInfo().then((info) => setBot(info?.telegramBot || ''));
  }, []);

  const handleRecover = useLastCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const key = recoveryKey.trim();
    if (!key || isRecovering) return;
    setIsRecovering(true);
    const result = await callParvane('parvaneRecoverWithKey', { recoveryKey: key }) as RecoverResult | undefined;
    setIsRecovering(false);
    if (result === 'ok') setRecoveryKey('');
    showNotification({ message: oldLang(RECOVER_RESULT_KEYS[result || 'failed']) });
    onRefresh();
  });

  const handleRequestTelegram = useLastCallback(async () => {
    await callParvane('parvaneRequestTelegramKey');
    onRefresh();
  });

  const handleRequestAgain = useLastCallback(async () => {
    await callParvane('parvaneRequestLinkAgain');
    onRefresh();
  });

  const {
    code, telegram, telegramCode, isDeclined,
  } = linkStatus;
  const telegramKey = telegram ? TELEGRAM_STATE_KEYS[telegram] : undefined;
  const canRequestAgain = telegram !== 'joining' && telegram !== 'done';
  // Карточка бота есть всегда (доски `PhAuth`, `DkAuth`); прячется, только когда сервер без бота
  const hasTelegramCard = telegram !== 'unavailable';

  return (
    <section className={styles.confirm} data-confirm-sign-in>
      <div className={styles.confirmHead}>
        {!isMobile && <h2 className={styles.confirmTitle}>{lang('ParvaneConfirmSignInTitle')}</h2>}
        <p className={styles.muted}>{lang('ParvaneConfirmSignInText')}</p>
      </div>
      <div className={styles.confirmCards}>
        <div
          className={buildClassName(styles.card, isDeclined ? styles.declined : styles.cardActive)}
          data-confirm-way="device"
          data-link-declined={isDeclined ? 'true' : undefined}
        >
          <h3 className={styles.cardTitle}>{lang('ParvaneConfirmWayDevice')}</h3>
          {isDeclined ? (
            <>
              <p className={styles.cardText} role="alert">{lang('ParvaneConfirmDeclinedText')}</p>
              <div className={styles.cardSpacer} />
              <button type="button" className={styles.button} data-link-again onClick={handleRequestAgain}>
                {lang('ParvaneConfirmRequestAgain')}
              </button>
            </>
          ) : (
            <>
              <p className={styles.cardText}>{lang('ParvaneConfirmWayDeviceText')}</p>
              <div className={styles.bigCode} data-link-code={code || ''}>{code || '···· ···· ····'}</div>
              <p className={styles.status}>
                <span className={styles.statusDot} />
                {lang('ParvaneConfirmWaiting')}
              </p>
            </>
          )}
        </div>

        <form className={styles.card} action="" data-confirm-way="key" onSubmit={handleRecover}>
          <h3 className={styles.cardTitle}>{lang('ParvaneConfirmWayKey')}</h3>
          {!isMobile && <p className={styles.cardText}>{lang('ParvaneConfirmWayKeyText')}</p>}
          {linkStatus.hasEscrow && <p className={styles.cardText}>{oldLang('ParvaneLostKeyAdmin')}</p>}
          <label className={styles.fieldLabel} htmlFor="parvane-confirm-recovery-key">
            {lang(isMobile ? 'ParvaneConfirmWayKeyTextShort' : 'ParvaneConfirmKeyLabel')}
          </label>
          <input
            id="parvane-confirm-recovery-key"
            className={styles.keyInput}
            type="text"
            value={recoveryKey}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-recover-key-input
            onChange={(e) => setRecoveryKey(e.currentTarget.value)}
          />
          <button
            type="submit"
            className={styles.button}
            disabled={!recoveryKey.trim() || isRecovering}
            data-recover-key-submit
          >
            {lang('ParvaneConfirmKeySubmit')}
          </button>
        </form>

        {hasTelegramCard && (
          <div className={styles.card} data-confirm-way="telegram">
            <h3 className={styles.cardTitle}>{lang('ParvaneConfirmWayTelegram')}</h3>
            <p className={styles.cardText}>{lang('ParvaneConfirmWayTelegramText')}</p>
            {telegramKey && (
              <p className={styles.cardText} data-telegram-recovery={telegram}>{oldLang(telegramKey)}</p>
            )}
            {telegram === 'waiting' && Boolean(telegramCode) && (
              <p className={styles.cardText} data-telegram-code={telegramCode}>
                {oldLang('ParvaneTgRecoverCode', telegramCode)}
              </p>
            )}
            <div className={styles.cardSpacer} />
            {Boolean(bot) && canRequestAgain && (
              <a
                className={styles.button}
                href={`https://t.me/${bot}`}
                target="_blank"
                rel="noopener noreferrer"
                data-telegram-open
              >
                {lang('ParvaneConfirmOpenTelegram')}
              </a>
            )}
            {canRequestAgain && (
              <button type="button" className={styles.link} data-telegram-again onClick={handleRequestTelegram}>
                {oldLang('ParvaneTgRecoverAgain')}
              </button>
            )}
          </div>
        )}
      </div>
      <p className={styles.confirmFoot}>
        {lang('ParvaneConfirmNoWay')}
        {' '}
        <button type="button" className={styles.linkInline} data-reset-identity onClick={onResetIdentity}>
          {lang('ParvaneConfirmWithoutHistory')}
        </button>
      </p>
    </section>
  );
};

export default memo(DeviceConfirmSignIn);
