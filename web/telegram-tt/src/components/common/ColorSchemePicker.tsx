import { memo } from '../../lib/teact/teact';

import type { ThemeKey } from '../../types';
import type { ColorScheme } from '../../util/colorScheme';

import buildClassName from '../../util/buildClassName';
import { COLOR_SCHEMES, getColorScheme, getSchemeSwatches } from '../../util/colorScheme';
import { applyColorScheme } from '../../util/switchTheme';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import styles from './ColorSchemePicker.module.scss';

type OwnProps = {
  theme: ThemeKey;
};

// Названия схем — имена собственные, не переводятся
const SCHEME_NAMES: Record<ColorScheme, string> = {
  gruvbox: 'Gruvbox',
  telegram: 'Telegram',
  nord: 'Nord',
  catppuccin: 'Catppuccin',
  solarized: 'Solarized',
};

// Parvane (spec 019): выбор цветовой схемы — карточки с образцами цветов текущей темы
const ColorSchemePicker = ({ theme }: OwnProps) => {
  const current = useDerivedState(getColorScheme);

  const lang = useLang();

  const handleSelect = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    applyColorScheme(e.currentTarget.dataset.scheme as ColorScheme);
  });

  return (
    <div className={styles.root} role="radiogroup" aria-label={lang('ParvaneColorScheme')}>
      {COLOR_SCHEMES.map((scheme) => (
        <button
          key={scheme}
          type="button"
          role="radio"
          aria-checked={scheme === current}
          data-scheme={scheme}
          className={buildClassName(styles.option, scheme === current && styles.selected)}
          onClick={handleSelect}
        >
          <span className={styles.swatches}>
            {getSchemeSwatches(scheme, theme).map((color) => (
              <span key={color} className={styles.swatch} style={`background-color: ${color}`} />
            ))}
          </span>
          <span className={styles.label}>{SCHEME_NAMES[scheme]}</span>
        </button>
      ))}
    </div>
  );
};

export default memo(ColorSchemePicker);
