import { memo, useEffect, useState } from '../../lib/teact/teact';

import { callApi } from '../../api/gramjs';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import styles from './Auth.module.scss';

type ResendState = 'idle' | 'sending' | 'sent' | 'failed';

const callParvane = callApi as unknown as (method: string) => Promise<boolean | undefined>;
// Повторить можно через минуту: сервер ограничивает частоту регистрации одного ника
const RESEND_DELAY_S = 60;
const TICK_MS = 1000;
const SECONDS_IN_MINUTE = 60;

// Код из письма не пришёл (доски `XpAuth`, `RdAuth`): «Отправить ещё раз можно через 0:42», затем ссылка. Провайдер
// повторяет регистрацию тем же паролем — сервер перевыпускает код неподтверждённого аккаунта и шлёт новое письмо
const AuthCodeResend = () => {
  const lang = useLang();
  const [secondsLeft, setSecondsLeft] = useState(RESEND_DELAY_S);
  const [state, setState] = useState<ResendState>('idle');

  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const timer = window.setTimeout(() => setSecondsLeft(secondsLeft - 1), TICK_MS);
    return () => window.clearTimeout(timer);
  }, [secondsLeft]);

  const handleResend = useLastCallback(async () => {
    setState('sending');
    const isSent = await callParvane('parvaneResendEmailCode').catch(() => false);
    setState(isSent ? 'sent' : 'failed');
    setSecondsLeft(RESEND_DELAY_S);
  });

  if (secondsLeft > 0) {
    const time = formatCountdown(secondsLeft);
    return (
      <p className={styles.small} data-auth-resend="wait">
        {state === 'sent' && `${lang('ParvaneAuthCodeResent')} `}
        {lang('ParvaneAuthCodeResendIn', { time: <span className={styles.mono}>{time}</span> }, { withNodes: true })}
      </p>
    );
  }

  return (
    <p className={styles.small}>
      {state === 'failed' && <span className={styles.hintError}>{`${lang('ParvaneAuthCodeResendFailed')} `}</span>}
      {lang('ParvaneAuthCodeNotReceived')}
      {' '}
      <button
        type="button"
        className={styles.linkInline}
        disabled={state === 'sending'}
        data-auth-resend="send"
        onClick={handleResend}
      >
        {lang('ParvaneAuthCodeResend')}
      </button>
    </p>
  );
};

function formatCountdown(seconds: number) {
  return `${Math.floor(seconds / SECONDS_IN_MINUTE)}:${String(seconds % SECONDS_IN_MINUTE).padStart(2, '0')}`;
}

export default memo(AuthCodeResend);
