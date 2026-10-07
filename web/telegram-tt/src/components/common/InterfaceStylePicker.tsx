import { memo } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { InterfaceStyle } from '../../types';

import { selectSharedSettings } from '../../global/selectors/sharedState';
import buildClassName from '../../util/buildClassName';
import { DEFAULT_INTERFACE_STYLE } from '../../util/interfaceStyle';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import styles from './InterfaceStylePicker.module.scss';

type OwnProps = {
  className?: string;
};

type StateProps = {
  interfaceStyle: InterfaceStyle;
};

const STYLES: InterfaceStyle[] = ['classic', 'panels'];

// Parvane (spec 008): выбор оформления — две миниатюры окна приложения.
// Нативного аналога в Web A нет (у Telegram оформление одно)
const InterfaceStylePicker = ({ className, interfaceStyle }: OwnProps & StateProps) => {
  const { setSharedSettingOption } = getActions();

  const lang = useLang();

  const handleSelect = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setSharedSettingOption({ interfaceStyle: e.currentTarget.dataset.style as InterfaceStyle });
  });

  return (
    <div
      className={buildClassName(styles.root, className)}
      role="radiogroup"
      aria-label={lang('ParvaneInterfaceStyle')}
    >
      {STYLES.map((style) => (
        <button
          key={style}
          type="button"
          role="radio"
          aria-checked={style === interfaceStyle}
          data-style={style}
          className={buildClassName(styles.option, style === interfaceStyle && styles.selected)}
          onClick={handleSelect}
        >
          <span className={buildClassName(styles.preview, style === 'classic' ? styles.classic : styles.panels)}>
            <span className={styles.previewList} />
            <span className={styles.previewChat}>
              <span className={styles.previewHeader} />
              <span className={styles.previewComposer} />
            </span>
          </span>
          <span className={styles.label}>
            {lang(style === 'classic' ? 'ParvaneInterfaceStyleClassic' : 'ParvaneInterfaceStylePanels')}
          </span>
        </button>
      ))}
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    return {
      interfaceStyle: selectSharedSettings(global).interfaceStyle || DEFAULT_INTERFACE_STYLE,
    };
  },
)(InterfaceStylePicker));
