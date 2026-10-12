import { memo } from '../../lib/teact/teact';

import type { ThemeKey } from '../../types';
import type { ColorScheme } from '../../util/colorScheme';

import buildClassName from '../../util/buildClassName';
import { COLOR_SCHEMES, getColorScheme, getSchemeSwatches } from '../../util/colorScheme';
import { applyColorScheme } from '../../util/switchTheme';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import ParvaneIcon from '../main/ParvaneIcon';

import styles from './ColorSchemePicker.module.scss';

type OwnProps = {
  theme: ThemeKey;
};

// Названия схем — имена собственные, не переводятся
export const SCHEME_NAMES: Record<ColorScheme, string> = {
  gruvbox: 'Gruvbox',
  telegram: 'Telegram',
  nord: 'Nord',
  catppuccin: 'Catppuccin',
  solarized: 'Solarized',
};

// Parvane (spec 019): выбор цветовой схемы. Карточка нарисована цветами самой схемы в текущей теме: фон —
// её панель, подпись — её текст, рамка выбранной — её акцент; сверху образцы
const ColorSchemePicker = ({ theme }: OwnProps) => {
  const current = useDerivedState(getColorScheme);

  const lang = useLang();

  const handleSelect = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    applyColorScheme(e.currentTarget.dataset.scheme as ColorScheme);
  });

  return (
    <div className={styles.root} role="radiogroup" aria-label={lang('ParvaneColorScheme')}>
      {COLOR_SCHEMES.map((scheme) => {
        const swatches = getSchemeSwatches(scheme, theme);
        const [, panel, accent, text] = swatches;
        const isSelected = scheme === current;

        return (
          <button
            key={scheme}
            type="button"
            role="radio"
            aria-checked={isSelected}
            data-scheme={scheme}
            className={buildClassName(styles.option, isSelected && styles.selected)}
            style={`--scheme-panel: ${panel}; --scheme-accent: ${accent}; --scheme-text: ${text}`}
            onClick={handleSelect}
          >
            <span className={styles.swatches}>
              {swatches.map((color, i) => (
                <span key={`${i}-${color}`} className={styles.swatch} style={`background-color: ${color}`} />
              ))}
            </span>
            <span className={styles.label}>
              {SCHEME_NAMES[scheme]}
              {isSelected && <ParvaneIcon name="check" isSmall className={styles.check} />}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default memo(ColorSchemePicker);
