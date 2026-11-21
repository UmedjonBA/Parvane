import { memo, useLayoutEffect, useRef } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';
import { PIN_LENGTH } from '../../util/pinAttempts';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import ParvaneIcon from '../main/ParvaneIcon';

import styles from './PinPad.module.scss';

type OwnProps = {
  value: string;
  error?: string;
  isActive?: boolean;
  isDisabled?: boolean;
  onChange: (value: string) => void;
  // Вход по отпечатку включён: кнопка встаёт в левую нижнюю клетку клавиатуры (доска `ZpSystem`)
  onBiometric?: NoneToVoidFunction;
};

const DOTS = Array.from({ length: PIN_LENGTH }, (_, index) => index);
const DIGIT_ROWS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ERASE_GLYPH = '←';

// Ввод PIN по макету (spec 041 E6; доски `ZpSystem`, `RpProfileB`): точки, сообщение и цифровая клавиатура.
// Цифры принимаются и с настоящей клавиатуры, пока экран активен
const PinPad = ({
  value, error, isActive, isDisabled, onChange, onBiometric,
}: OwnProps) => {
  const lang = useLang();

  // Быстрый набор с клавиатуры: несколько цифр приходят до следующего кадра, когда `value` ещё прежний
  const valueRef = useRef(value);
  valueRef.current = value;

  const emitChange = useLastCallback((next: string) => {
    // Полный PIN владелец экрана забирает и поле очищает: следующая цифра начинает ввод заново
    valueRef.current = next.length < PIN_LENGTH ? next : '';
    onChange(next);
  });

  const addDigit = useLastCallback((digit: string) => {
    if (isDisabled) return;
    emitChange(valueRef.current + digit);
  });

  const eraseDigit = useLastCallback(() => {
    if (isDisabled || !valueRef.current) return;
    emitChange(valueRef.current.slice(0, -1));
  });

  const handleKeyDown = useLastCallback((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Backspace') {
      e.preventDefault();
      eraseDigit();
      return;
    }
    if (e.key.length !== 1 || e.key < '0' || e.key > '9') return;
    e.preventDefault();
    addDigit(e.key);
  });

  useLayoutEffect(() => {
    if (!isActive) return undefined;
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isActive]);

  function renderDigit(digit: string) {
    return (
      <button
        key={digit}
        type="button"
        className={styles.key}
        aria-label={lang('ParvanePinDigit', { digit })}
        data-pin-key={digit}
        disabled={isDisabled}
        onClick={() => addDigit(digit)}
      >
        {digit}
      </button>
    );
  }

  return (
    <div className={styles.root} data-pin-pad>
      <div
        className={styles.dots}
        role="img"
        aria-label={lang('ParvanePinDots', { count: value.length, total: PIN_LENGTH })}
        data-pin-filled={value.length}
      >
        {DOTS.map((index) => (
          <span key={index} className={buildClassName(styles.dot, index < value.length && styles.dotFilled)} />
        ))}
      </div>
      <div className={styles.error} role="alert" data-pin-error>{error}</div>
      <div className={styles.keys}>
        {DIGIT_ROWS.map(renderDigit)}
        {onBiometric ? (
          <button
            type="button"
            className={styles.key}
            aria-label={lang('ParvaneBioLockButton')}
            title={lang('ParvaneBioLockButton')}
            data-pin-biometric
            disabled={isDisabled}
            onClick={onBiometric}
          >
            <ParvaneIcon name="fingerprint" className={styles.keyIcon} />
          </button>
        ) : (
          <span className={styles.gap} aria-hidden="true" />
        )}
        {renderDigit('0')}
        <button
          type="button"
          className={styles.key}
          aria-label={lang('ParvanePinErase')}
          data-pin-key="erase"
          disabled={isDisabled}
          onClick={eraseDigit}
        >
          {ERASE_GLYPH}
        </button>
      </div>
    </div>
  );
};

export default memo(PinPad);
