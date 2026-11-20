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

const SAMPLE_THEMES: ThemeKey[] = ['light', 'dark'];

// Названия схем — имена собственные, не переводятся
export const SCHEME_NAMES: Record<ColorScheme, string> = {
  gruvbox: 'Gruvbox',
  telegram: 'Telegram',
  nord: 'Nord',
  catppuccin: 'Catppuccin',
  solarized: 'Solarized',
};

// Parvane (spec 019; spec 041, доска `DkSettingsA`): выбор цветовой схемы. Образец — «светлая | тёмная половина»:
// каждая половина — панель схемы в своей теме со строкой текста и строкой акцента; рамка выбранной — акцент схемы в
// текущей теме, под образцом название
const ColorSchemePicker = ({ theme }: OwnProps) => {
  const current = useDerivedState(getColorScheme);

  const lang = useLang();

  const handleSelect = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    applyColorScheme(e.currentTarget.dataset.scheme as ColorScheme);
  });

  return (
    <div className={styles.root} role="radiogroup" aria-label={lang('ParvaneColorScheme')}>
      {COLOR_SCHEMES.map((scheme) => {
        const accent = getSchemeSwatches(scheme, theme)[2];
        const isSelected = scheme === current;

        return (
          <button
            key={scheme}
            type="button"
            role="radio"
            aria-checked={isSelected}
            data-scheme={scheme}
            className={buildClassName(styles.option, isSelected && styles.selected)}
            style={`--scheme-accent: ${accent}`}
            onClick={handleSelect}
          >
            <span className={styles.sample}>
              {SAMPLE_THEMES.map((sampleTheme) => {
                const [, panel, sampleAccent, text] = getSchemeSwatches(scheme, sampleTheme);
                return (
                  <span
                    key={sampleTheme}
                    className={styles.half}
                    style={`--half-panel: ${panel}; --half-accent: ${sampleAccent}; --half-text: ${text}`}
                  >
                    <span className={styles.line} />
                    <span className={buildClassName(styles.line, styles.lineAccent)} />
                  </span>
                );
              })}
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
