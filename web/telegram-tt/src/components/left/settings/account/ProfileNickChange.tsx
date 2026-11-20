import type { ChangeEvent } from 'react';
import { memo, useEffect, useState } from '../../../../lib/teact/teact';

import buildClassName from '../../../../util/buildClassName';
import { callApi } from '../../../../api/gramjs';

import useDebouncedCallback from '../../../../hooks/useDebouncedCallback';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import SecretForm from '../../../ui/SecretForm';

import kit from '../../../parvane/notes/PvKit.module.scss';
import styles from './Account.module.scss';

type OwnProps = {
  currentNick?: string;
};

type RenameResult = 'ok' | 'bad_password' | 'bad_key' | 'no_backup' | 'taken' | 'invalid' | 'failed';
type NickState = 'free' | 'taken' | 'own' | 'invalid' | 'unknown' | 'checking';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const CHECK_DELAY_MS = 400;

const ERROR_KEYS = {
  bad_password: 'ParvaneRenameErrorPassword',
  bad_key: 'ParvaneRenameErrorKey',
  no_backup: 'ParvaneRenameErrorNoBackup',
  taken: 'ParvaneRenameErrorTaken',
  invalid: 'ParvaneRenameErrorInvalid',
  failed: 'ParvaneRenameErrorFailed',
} as const;

const STATE_KEYS = {
  free: 'ParvaneNickFree',
  taken: 'ParvaneNickTaken',
  invalid: 'ParvaneRenameNickRule',
  checking: 'ParvaneNickChecking',
} as const;

// Parvane (spec 041, доска `XpProfile`): ник в «Изменить профиль» своим блоком — поле ника с «Свободен / Занят»,
// пароль для подтверждения и ключ восстановления. Смена (spec 026) подписывается корнем личности, а корень на
// устройстве не хранится, поэтому ключ восстановления нужен всегда (расхождение с доской: там его спрашивают, «только
// если пароль не подойдёт»). Прежний ник 30 дней ведёт на новый; после смены вкладка перезагружается
const ProfileNickChange = ({ currentNick }: OwnProps) => {
  const lang = useLang();
  const [nick, setNick] = useState(currentNick || '');
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [nickState, setNickState] = useState<NickState>('own');
  const [error, setError] = useState<Exclude<RenameResult, 'ok'> | undefined>();
  const [isBusy, setIsBusy] = useState(false);
  const [isDone, setIsDone] = useState(false);

  useEffect(() => {
    setNick(currentNick || '');
    setNickState('own');
  }, [currentNick]);

  const normalized = nick.trim().replace(/^@/, '').toLowerCase();
  const isChanged = Boolean(normalized) && normalized !== currentNick;
  const canSubmit = isChanged && nickState !== 'taken' && nickState !== 'invalid' && Boolean(password)
    && Boolean(recoveryKey.trim()) && !isBusy && !isDone;

  const getNormalized = useLastCallback(() => normalized);

  const checkNick = useDebouncedCallback(async (value: string) => {
    const state = await callParvane('parvaneCheckNick', { nick: value }).catch(() => 'unknown') as NickState;
    // Ответ на прежний ввод не нужен
    if (value === getNormalized()) setNickState(state);
  }, [], CHECK_DELAY_MS, true);

  const handleNick = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/^@/, '');
    setNick(value);
    setError(undefined);
    const clean = value.trim().toLowerCase();
    if (!clean || clean === currentNick) {
      setNickState('own');
      return;
    }
    setNickState('checking');
    checkNick(clean);
  });

  const handlePassword = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    setError(undefined);
  });

  const handleKey = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setRecoveryKey(e.target.value);
    setError(undefined);
  });

  const handleSubmit = useLastCallback(async () => {
    if (!canSubmit) return;
    setIsBusy(true);
    const out = await callParvane('parvaneRenameAccount', { nick: normalized, password, recoveryKey })
      .catch(() => undefined) as { result?: RenameResult } | undefined;
    setIsBusy(false);
    const result = out?.result || 'failed';
    if (result === 'ok') {
      setIsDone(true);
      return;
    }
    setError(result);
  });

  const stateKey = nickState in STATE_KEYS ? STATE_KEYS[nickState as keyof typeof STATE_KEYS] : undefined;

  return (
    <div className={buildClassName(kit.card, styles.nickBox)} data-rename-dialog>
      <label className={styles.label} htmlFor="parvane-rename-nick">{lang('ParvaneAccountNick')}</label>
      <input
        id="parvane-rename-nick"
        className={kit.input}
        autoComplete="off"
        spellCheck={false}
        value={nick}
        disabled={isDone}
        onChange={handleNick}
      />
      {isChanged && stateKey && (
        <p
          className={buildClassName(
            styles.nickState, nickState === 'free' && styles.nickFree,
            (nickState === 'taken' || nickState === 'invalid') && styles.nickTaken,
          )}
          data-rename-nick-state={nickState}
          data-rename-nick-invalid={nickState === 'invalid' ? '' : undefined}
        >
          {lang(stateKey)}
        </p>
      )}
      {isChanged && (
        <SecretForm className={styles.nickBox}>
          <label className={styles.label} htmlFor="parvane-rename-password">{lang('ParvaneNickPassword')}</label>
          <input
            id="parvane-rename-password"
            type="password"
            className={kit.input}
            autoComplete="current-password"
            placeholder={lang('ParvaneRenamePassword')}
            value={password}
            disabled={isDone}
            onChange={handlePassword}
          />
          <label className={styles.label} htmlFor="parvane-rename-key">{lang('ParvaneRenameRecoveryKey')}</label>
          <input
            id="parvane-rename-key"
            type="password"
            className={kit.input}
            autoComplete="off"
            spellCheck={false}
            value={recoveryKey}
            disabled={isDone}
            onChange={handleKey}
          />
        </SecretForm>
      )}
      {currentNick && <p className={styles.muted}>{lang('ParvaneNickOldHint', { nick: currentNick })}</p>}
      {error && <p className={styles.error} data-rename-error={error}>{lang(ERROR_KEYS[error])}</p>}
      {isDone && <p className={styles.done} data-rename-done>{lang('ParvaneRenameDone')}</p>}
      {isChanged && (
        <span data-rename-submit-wrap>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc, kit.btnWide)}
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {lang('ParvaneRenameSubmit')}
          </button>
        </span>
      )}
    </div>
  );
};

export default memo(ProfileNickChange);
