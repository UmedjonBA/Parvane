import { memo, useLayoutEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import buildClassName from '../../../../util/buildClassName';
import { callApi } from '../../../../api/gramjs';

import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import Button from '../../../ui/Button';
import SecretForm from '../../../ui/SecretForm';
import ProfileSwitchRow from '../profile/ProfileSwitchRow';

import kit from '../../../parvane/notes/PvKit.module.scss';
import styles from '../profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
};

type KeyInfo = { id: string; name: string; createdMs: number; lastUsedMs: number };
type KeysState = { keys: KeyInfo[]; isRequired: boolean; isRecoveryReady: boolean; isSupported: boolean };
type Change = 'ok' | 'bad_password' | 'no_recovery' | 'limit' | 'duplicate' | 'not_linked'
  | 'cancelled' | 'unsupported' | 'failed';
type Pending = { kind: 'add' } | { kind: 'remove'; id: string } | { kind: 'required'; isRequired: boolean };

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const MAX_KEYS = 10;

const CHANGE_KEYS = {
  bad_password: 'ParvaneSecKeyBadPassword',
  no_recovery: 'ParvaneSecKeyNoRecovery',
  limit: 'ParvaneSecKeyLimit',
  duplicate: 'ParvaneSecKeyDuplicate',
  not_linked: 'ParvaneSecKeyNotLinked',
  cancelled: 'ParvaneSecKeyCancelled',
  unsupported: 'ParvaneSecKeyUnsupported',
  failed: 'ParvaneSecKeyFailed',
} as const;

const DONE_KEYS = {
  add: 'ParvaneSecKeyAdded',
  remove: 'ParvaneSecKeyRemoved',
  required: 'ParvaneSecKeyRequiredChanged',
} as const;

// Карточка «Ключ безопасности» (доска `ZdProfileX`, «Блокировка и ключ безопасности»): ключи USB/NFC аккаунта —
// второй фактор входа нового устройства на сервере (SECKEY-1). «Убрать», «Добавить» и выключатель
// «Требовать ключ при входе» спрашивают пароль аккаунта
const SettingsSecurityKeys = ({ isActive }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [state, setState] = useState<KeysState | undefined>();
  const [pending, setPending] = useState<Pending | undefined>();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [isBusy, markBusy, unmarkBusy] = useFlag();

  const loadState = useLastCallback(async () => {
    setState(await callParvane('parvaneGetSecurityKeys') as KeysState | undefined);
  });

  useLayoutEffect(() => {
    if (isActive) {
      void loadState();
      return;
    }
    setPending(undefined);
    setPassword('');
  }, [isActive]);

  const askPassword = useLastCallback((next: Pending) => {
    if (isBusy) return;
    setPending(next);
    setPassword('');
    setError(undefined);
  });

  const handleAdd = useLastCallback(() => {
    if (!state?.isRecoveryReady) {
      setError(lang(CHANGE_KEYS.no_recovery));
      return;
    }
    askPassword({ kind: 'add' });
  });

  const handleRequiredChange = useLastCallback(() => {
    askPassword({ kind: 'required', isRequired: !state?.isRequired });
  });

  const handleCancel = useLastCallback(() => {
    setPending(undefined);
    setPassword('');
    setError(undefined);
  });

  const handleConfirm = useLastCallback(async () => {
    if (!pending || !password || isBusy) return;
    markBusy();
    setError(undefined);
    let result: Change;
    if (pending.kind === 'add') {
      const name = lang('ParvaneSecKeyDefaultName', { count: (state?.keys.length || 0) + 1 });
      result = await callParvane('parvaneAddSecurityKey', { password, name }) as Change;
    } else if (pending.kind === 'remove') {
      result = await callParvane('parvaneRemoveSecurityKey', { password, id: pending.id }) as Change;
    } else {
      result = await callParvane('parvaneSetSecurityKeyRequired', {
        password, isRequired: pending.isRequired,
      }) as Change;
    }
    unmarkBusy();
    if (result !== 'ok') {
      setError(lang(CHANGE_KEYS[result || 'failed']));
      if (result === 'bad_password') setPassword('');
      return;
    }
    showNotification({ message: lang(DONE_KEYS[pending.kind]) });
    handleCancel();
    await loadState();
  });

  if (!state) return undefined;

  const dateFormat = new Intl.DateTimeFormat(lang.code, { day: 'numeric', month: 'long', year: 'numeric' });
  const hasKeys = state.keys.length > 0;
  const canAdd = state.isSupported && state.keys.length < MAX_KEYS;
  const confirmLabel = pending?.kind === 'add' ? 'ParvaneSecKeyConfirmAdd'
    : pending?.kind === 'remove' ? 'ParvaneSecKeyConfirmRemove' : 'ParvaneSecKeyConfirmRequired';

  function renderKeyHint(key: KeyInfo) {
    const added = dateFormat.format(key.createdMs);
    return key.lastUsedMs
      ? lang('ParvaneSecKeyAddedUsed', { added, used: dateFormat.format(key.lastUsedMs) })
      : lang('ParvaneSecKeyAddedNotUsed', { added });
  }

  return (
    <>
      <div className={styles.caption}>{lang('ParvaneSecKeyTitle')}</div>
      <div className={styles.group} data-security-keys={state.keys.length}>
        {state.keys.map((key) => (
          <div key={key.id} className={styles.setRow} data-security-key={key.id}>
            <span className={styles.setText}>
              <span className={styles.setTitle}>{key.name || lang('ParvaneSecKeyDefaultName', { count: 1 })}</span>
              <span className={styles.setHint}>{renderKeyHint(key)}</span>
            </span>
            <button
              type="button"
              className={kit.chip}
              disabled={isBusy}
              data-security-key-remove
              onClick={() => askPassword({ kind: 'remove', id: key.id })}
            >
              {lang('ParvaneSecKeyRemove')}
            </button>
          </div>
        ))}
        {canAdd && (
          <div className={styles.setRow}>
            <span className={styles.setText}>
              <span className={styles.setTitle}>
                {lang(hasKeys ? 'ParvaneSecKeyAddMore' : 'ParvaneSecKeyAddFirst')}
              </span>
              <span className={styles.setHint}>{lang('ParvaneSecKeyAddHint')}</span>
            </span>
            <button
              type="button"
              className={kit.chip}
              disabled={isBusy}
              data-security-key-add
              onClick={handleAdd}
            >
              {lang('ParvaneSecKeyAdd')}
            </button>
          </div>
        )}
        {hasKeys && (
          <ProfileSwitchRow
            title={lang('ParvaneSecKeyRequire')}
            hint={lang('ParvaneSecKeyRequireHint')}
            isOn={pending?.kind === 'required' ? pending.isRequired : state.isRequired}
            isDisabled={isBusy}
            data-security-key-required={state.isRequired ? 'on' : 'off'}
            onChange={handleRequiredChange}
          />
        )}
        {pending && (
          <div className={styles.formRow} data-security-key-confirm={pending.kind}>
            <SecretForm className={styles.form}>
              <input
                type="password"
                className="form-control"
                autoComplete="current-password"
                placeholder={lang('ParvaneSecKeyPassword')}
                aria-label={lang('ParvaneSecKeyPassword')}
                value={password}
                disabled={isBusy}
                onChange={(e) => setPassword(e.currentTarget.value)}
              />
              <Button size="smaller" disabled={!password || isBusy} onClick={handleConfirm}>
                {lang(confirmLabel)}
              </Button>
              <Button size="smaller" color="translucent" disabled={isBusy} onClick={handleCancel}>
                {lang('Cancel')}
              </Button>
            </SecretForm>
          </div>
        )}
      </div>
      {error && (
        <div className={buildClassName(styles.hint, styles.danger)} role="alert" data-security-key-error>{error}</div>
      )}
      {!state.isSupported && <div className={styles.hint}>{lang('ParvaneSecKeyUnsupported')}</div>}
      <div className={styles.hint}>{lang('ParvaneSecKeyNote')}</div>
    </>
  );
};

export default memo(SettingsSecurityKeys);
