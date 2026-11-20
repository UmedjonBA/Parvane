import { memo, useMemo } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import type { ThemeKey } from '../../../../types';
import type { PvSegmentItem } from '../../../parvane/notes/PvSegment';
import { SettingsScreens } from '../../../../types';

import { DARK_THEME_PATTERN_COLOR, DEFAULT_PATTERN_COLOR } from '../../../../config';
import { selectTheme, selectThemeValues } from '../../../../global/selectors';
import buildClassName from '../../../../util/buildClassName';
import { validateFiles } from '../../../../util/files';
import { isUploadedWallpaper } from '../../../../util/parvaneWallpaper';
import { openSystemFilesDialog } from '../../../../util/systemFilesDialog';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import PvSegment from '../../../parvane/notes/PvSegment';

import styles from './Profile.module.scss';

type BackgroundMode = 'default' | 'pattern' | 'own';

type StateProps = {
  theme: ThemeKey;
  background?: string;
};

const SUPPORTED_TYPES = 'image/jpeg';

// Parvane (spec 041, доска `DkSettingsA`): «Фон чатов» переключателем «По умолчанию / Рисунок / Своя картинка».
// «По умолчанию» снимает фон сразу, «Рисунок» открывает выбор цвета и рисунка (прежний экран фона), «Своя картинка» —
// выбор файла; загруженная картинка появляется первой на экране фона
const AppearanceBackgroundRow = ({ theme, background }: StateProps) => {
  const { setThemeSettings, openSettingsScreen, uploadWallpaper } = getActions();
  const lang = useLang();
  const mode: BackgroundMode = !background ? 'default' : isUploadedWallpaper(background) ? 'own' : 'pattern';

  const items = useMemo<PvSegmentItem<BackgroundMode>[]>(() => [
    { value: 'default', label: lang('ParvaneBackgroundDefault') },
    { value: 'pattern', label: lang('ParvaneBackgroundPattern') },
    { value: 'own', label: lang('ParvaneBackgroundOwn') },
  ], [lang]);

  const handleFileSelect = useLastCallback((e: Event) => {
    const validatedFiles = validateFiles((e.target as HTMLInputElement).files);
    if (!validatedFiles?.length) return;
    uploadWallpaper(validatedFiles[0]);
    openSettingsScreen({ screen: SettingsScreens.GeneralChatBackground });
  });

  const handleChange = useLastCallback((value: BackgroundMode) => {
    if (value === 'default') {
      setThemeSettings({
        theme,
        background: undefined,
        backgroundColor: undefined,
        isBlurred: true,
        patternColor: theme === 'dark' ? DARK_THEME_PATTERN_COLOR : DEFAULT_PATTERN_COLOR,
      });
    } else if (value === 'pattern') {
      openSettingsScreen({ screen: SettingsScreens.GeneralChatBackground });
    } else {
      openSystemFilesDialog(SUPPORTED_TYPES, handleFileSelect, true);
    }
  });

  return (
    <div className={buildClassName(styles.setRow, styles.setRowWrap)} data-appearance-row="background">
      <span className={styles.setTitle}>{lang('ParvaneAppearanceChatBackground')}</span>
      <PvSegment
        items={items}
        value={mode}
        label={lang('ParvaneAppearanceChatBackground')}
        className={styles.setSegment}
        onChange={handleChange}
      />
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    const theme = selectTheme(global);
    return { theme, background: selectThemeValues(global, theme)?.background };
  },
)(AppearanceBackgroundRow));
