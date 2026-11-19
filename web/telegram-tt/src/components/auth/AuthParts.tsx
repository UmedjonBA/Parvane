import type { ChangeEvent } from 'react';
import type { ElementRef, TeactNode } from '../../lib/teact/teact';
import { memo, useState } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import PvIcon from '../parvane/notes/PvIcon';

import segment from '../parvane/notes/PvSegment.module.scss';
import styles from './Auth.module.scss';

const LOGO_LETTER = 'P';

type LogoProps = {
  isSmall?: boolean;
};

// Знак приложения с досок входа: плитка цвета акцента с буквой
export const AuthLogo = memo(({ isSmall }: LogoProps) => (
  <div className={buildClassName(styles.logo, isSmall && styles.logoSmall)} aria-hidden="true">{LOGO_LETTER}</div>
));

type BarProps = {
  title: string;
  subtitle?: string;
  step?: string;
  isLined?: boolean;
  onBack?: NoneToVoidFunction;
};

// Шапка экрана на телефоне: «Назад», название, справа номер шага
export const AuthBar = memo(({
  title, subtitle, step, isLined, onBack,
}: BarProps) => {
  const lang = useLang();

  return (
    <header className={buildClassName(styles.bar, isLined && styles.barLined)}>
      {onBack && (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={lang('Back')}
          data-auth-back="bar"
          onClick={onBack}
        >
          <PvIcon name="left" />
        </button>
      )}
      <h1 className={buildClassName(styles.barTitle, styles.grow)}>
        {title}
        {subtitle && <span className={styles.barSub}>{subtitle}</span>}
      </h1>
      {step && <span className={styles.step}>{step}</span>}
    </header>
  );
});

type FieldProps = {
  id: string;
  label: string;
  value: string;
  inputRef?: ElementRef<HTMLInputElement>;
  type?: 'text' | 'password' | 'email';
  placeholder?: string;
  hint?: string;
  error?: string;
  autoComplete?: string;
  inputMode?: 'text' | 'email';
  maxLength?: number;
  isMono?: boolean;
  isReadOnly?: boolean;
  shouldAutoFocus?: boolean;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
};

// Поле формы: подпись сверху, поле, под ним подсказка либо ошибка; у пароля — кнопка показа
export const AuthField = memo(({
  id, label, value, inputRef, type = 'text', placeholder, hint, error, autoComplete, inputMode, maxLength,
  isMono, isReadOnly, shouldAutoFocus, onChange,
}: FieldProps) => {
  const lang = useLang();
  const [isRevealed, setIsRevealed] = useState(false);
  const isPassword = type === 'password';

  const toggleRevealed = useLastCallback(() => {
    setIsRevealed(!isRevealed);
  });

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>{label}</label>
      <span className={styles.control}>
        <input
          ref={inputRef}
          id={id}
          className={buildClassName(
            styles.input, isMono && styles.inputMono, error && styles.inputError, isPassword && styles.inputWithToggle,
          )}
          type={isPassword && isRevealed ? 'text' : type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          inputMode={inputMode}
          maxLength={maxLength}
          readOnly={isReadOnly}
          tabIndex={isReadOnly ? -1 : undefined}
          autoFocus={shouldAutoFocus}
          aria-invalid={Boolean(error)}
          dir="auto"
          onChange={onChange}
        />
        {isPassword && (
          <button
            type="button"
            className={styles.toggle}
            title={lang('AriaPasswordToggle')}
            aria-label={lang('AriaPasswordToggle')}
            aria-pressed={isRevealed}
            onClick={toggleRevealed}
          >
            <Icon name={isRevealed ? 'eye' : 'eye-crossed'} />
          </button>
        )}
      </span>
      {(error || hint) && (
        <span className={buildClassName(styles.hint, error && styles.hintError)} role={error ? 'alert' : undefined}>
          {error || hint}
        </span>
      )}
    </div>
  );
});

type NoticeProps = {
  tone: 'orange' | 'red';
  title: string;
  text?: string;
  children?: TeactNode;
};

const TONE_CLASS = { orange: styles.dotOrange, red: styles.dotRed };

// Плашка состояния: что случилось и одна кнопка, если что-то можно сделать
export const AuthNotice = ({
  tone, title, text, children,
}: NoticeProps) => (
  <div className={styles.notice} role="alert">
    <span className={buildClassName(styles.dot, TONE_CLASS[tone])} />
    <div className={styles.grow}>
      <p className={styles.noticeTitle}>{title}</p>
      {text && <p className={styles.small}>{text}</p>}
    </div>
    {children}
  </div>
);

type SubmitProps = {
  label: string;
  isLoading?: boolean;
  isDisabled?: boolean;
  className?: string;
};

// Главная кнопка формы; пока запрос идёт, повторно не нажимается
export const AuthSubmit = memo(({
  label, isLoading, isDisabled, className,
}: SubmitProps) => (
  <button
    type="submit"
    className={buildClassName(styles.button, isLoading && styles.buttonBusy, className)}
    disabled={isDisabled}
    aria-busy={isLoading}
    data-auth-submit
  >
    {isLoading && <span className={styles.spinner} />}
    {label}
  </button>
));

type ModeProps = {
  isRegistration?: boolean;
  onLogin?: NoneToVoidFunction;
  onRegister?: NoneToVoidFunction;
};

// Переключатель «Вход / Новый аккаунт» в окне компьютера
export const AuthModeSwitch = memo(({ isRegistration, onLogin, onRegister }: ModeProps) => {
  const lang = useLang();

  return (
    <div className={segment.root} role="group" aria-label={lang('ParvaneAuthModeLabel')}>
      <button
        type="button"
        className={buildClassName(segment.item, !isRegistration && segment.itemOn)}
        aria-pressed={!isRegistration}
        data-auth-login
        onClick={onLogin}
      >
        {lang('ParvaneAuthTabLogIn')}
      </button>
      <button
        type="button"
        className={buildClassName(segment.item, isRegistration && segment.itemOn)}
        aria-pressed={Boolean(isRegistration)}
        data-auth-register
        onClick={onRegister}
      >
        {lang('ParvaneRegisterTitle')}
      </button>
    </div>
  );
});
