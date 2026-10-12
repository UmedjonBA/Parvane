import Color from 'colorjs.io';
import type { FC } from '../../../lib/teact/teact';
import {
  memo, useCallback, useEffect, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { BackgroundCombination, PatternId } from '../../../api/parvane/wallpaperCombo';
import type { ApiWallpaper } from '../../../api/types';
import type { ThemeKey } from '../../../types';
import { SettingsScreens, UPLOADING_WALLPAPER_SLUG } from '../../../types';

import { DARK_THEME_PATTERN_COLOR, DEFAULT_PATTERN_COLOR } from '../../../config';
import { selectTheme, selectThemeValues } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { getAverageColor, getPatternColor } from '../../../util/colors';
import { validateFiles } from '../../../util/files';
import { isUploadedWallpaper } from '../../../util/parvaneWallpaper';
import { throttle } from '../../../util/schedulers';
import { openSystemFilesDialog } from '../../../util/systemFilesDialog';
import { callApi } from '../../../api/gramjs';
import {
  buildCombinationSlug, findGradient, getDefaultGradient, getGradientAverageColor, getGradientInk, gradientCss,
  GRADIENTS, parseBackgroundSlug, PATTERN_IDS, pickCombination,
} from '../../../api/parvane/wallpaperCombo';
import { PATTERN_URLS } from '../../../api/parvane/wallpapers';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useOldLang from '../../../hooks/useOldLang';

import Island from '../../gili/layout/Island';
import Checkbox from '../../ui/Checkbox';
import ListItem from '../../ui/ListItem';
import WallpaperTile from './WallpaperTile';

import './SettingsGeneralBackground.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  background?: string;
  isBlurred?: boolean;
  loadedWallpapers?: ApiWallpaper[];
  theme: ThemeKey;
};

const SUPPORTED_TYPES = 'image/jpeg';

const runThrottled = throttle((cb) => cb(), 60000, true);

const PATTERN_NAME_KEYS: Record<PatternId, string> = {
  mathematics: 'ParvaneBgPatternMathematics',
  programming: 'ParvaneBgPatternProgramming',
  cosmos: 'ParvaneBgPatternCosmos',
  physics: 'ParvaneBgPatternPhysics',
  chemistry: 'ParvaneBgPatternChemistry',
  biology: 'ParvaneBgPatternBiology',
  electronics: 'ParvaneBgPatternElectronics',
  algorithms: 'ParvaneBgPatternAlgorithms',
  flight: 'ParvaneBgPatternFlight',
  'science-mix': 'ParvaneBgPatternScienceMix',
};

type ApplyResult = { status: 'ok' | 'not-ready' | 'failed' | 'superseded' };

const applyBuiltinBackground = (theme: ThemeKey, slug: string) => (
  (callApi as unknown as (
    name: string, args: { theme: string; slug: string },
  ) => Promise<ApplyResult | undefined>)('applyBuiltinChatBackground', { theme, slug })
);

const SettingsGeneralBackground: FC<OwnProps & StateProps> = ({
  isActive,
  onReset,
  background,
  isBlurred,
  loadedWallpapers,
  theme,
}) => {
  const {
    loadWallpapers,
    uploadWallpaper,
    setThemeSettings,
    openSettingsScreen,
    showNotification,
  } = getActions();

  const lang = useOldLang();
  const themeRef = useRef<ThemeKey>();
  themeRef.current = theme;

  // Сочетание «цвет + рисунок»: выбранное отмечается сразу, не дожидаясь, пока картинка нарисуется и
  // запишется. Номер запроса отсекает устаревший выбор при быстром переборе образцов
  const [picked, setPicked] = useState<BackgroundCombination | undefined>();
  const requestRef = useRef(0);
  const combination = picked || parseBackgroundSlug(background);
  const combinationRef = useRef<BackgroundCombination>();
  combinationRef.current = combination;

  useEffect(() => {
    requestRef.current += 1;
    setPicked(undefined);
  }, [theme]);
  // Due to the parent Transition, this component never gets unmounted,
  // that's why we use throttled API call on every update.
  useEffect(() => {
    runThrottled(() => {
      loadWallpapers();
    });
  }, [loadWallpapers]);

  const handleFileSelect = useCallback((e: Event) => {
    const { files } = e.target as HTMLInputElement;

    const validatedFiles = validateFiles(files);
    if (validatedFiles?.length) {
      uploadWallpaper(validatedFiles[0]);
    }
  }, [uploadWallpaper]);

  const handleUploadWallpaper = useCallback(() => {
    openSystemFilesDialog(SUPPORTED_TYPES, handleFileSelect, true);
  }, [handleFileSelect]);

  const handleSetColor = useCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.GeneralChatBackgroundColor });
  }, []);

  const handleResetToDefault = useCallback(() => {
    requestRef.current += 1;
    setPicked(undefined);
    setThemeSettings({
      theme,
      background: undefined,
      backgroundColor: undefined,
      isBlurred: true,
      patternColor: theme === 'dark' ? DARK_THEME_PATTERN_COLOR : DEFAULT_PATTERN_COLOR,
    });
  }, [setThemeSettings, theme]);

  const applyCombination = useCallback(async (change: Partial<BackgroundCombination>) => {
    const currentTheme = themeRef.current!;
    const next = pickCombination(combinationRef.current, change, currentTheme);
    const preset = findGradient(next.gradient);
    if (!preset) return;
    const request = ++requestRef.current;
    setPicked(next);
    const slug = buildCombinationSlug(next);
    const result = await applyBuiltinBackground(currentTheme, slug).catch(() => undefined);
    if (requestRef.current !== request) return;
    setPicked(undefined);
    if (result?.status !== 'ok') {
      showNotification({ message: lang('ParvaneBackgroundFailed') });
      return;
    }
    const averageColor = getGradientAverageColor(preset);
    setThemeSettings({
      theme: currentTheme,
      background: slug,
      backgroundColor: averageColor,
      patternColor: getPatternColor(new Color(averageColor)),
    });
  }, [lang, setThemeSettings, showNotification]);

  const handlePatternClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void applyCombination({ pattern: e.currentTarget.dataset.bgPattern as PatternId });
  }, [applyCombination]);

  const handleGradientClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void applyCombination({ gradient: e.currentTarget.dataset.bgGradient });
  }, [applyCombination]);

  const handleWallPaperSelect = useCallback((slug: string) => {
    requestRef.current += 1;
    setPicked(undefined);
    setThemeSettings({ theme: themeRef.current!, background: slug });
    const currentWallpaper = loadedWallpapers && loadedWallpapers.find((wallpaper) => wallpaper.slug === slug);
    if (currentWallpaper?.document.thumbnail) {
      getAverageColor(currentWallpaper.document.thumbnail.dataUri)
        .then((averageColor) => {
          setThemeSettings({
            theme: themeRef.current!,
            backgroundColor: averageColor.toString({ format: 'hex', collapse: false, alpha: false }),
            patternColor: getPatternColor(averageColor),
          });
        });
    }
  }, [loadedWallpapers, setThemeSettings]);

  const handleWallPaperBlurChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setThemeSettings({ theme: themeRef.current!, isBlurred: e.target.checked });
  }, [setThemeSettings]);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  // Parvane: размывать есть смысл только свою картинку — на градиенте и узоре размытие либо не видно,
  // либо портит рисунок
  const canBlur = isUploadedWallpaper(background);
  const isUploading = loadedWallpapers?.[0] && loadedWallpapers[0].slug === UPLOADING_WALLPAPER_SLUG;
  // Рисунки показаны на том градиенте, на который лягут: выбранном либо градиенте темы
  const shownGradient = findGradient(combination?.gradient) || findGradient(getDefaultGradient(theme))!;
  const patternTileStyle = [
    `--bg-gradient: ${gradientCss(shownGradient)}`,
    `--bg-ink: ${getGradientInk(shownGradient).color}`,
  ].join('; ');

  return (
    <div className="SettingsGeneralBackground settings-content custom-scroll">
      <Island>
        <ListItem
          icon="camera-add"
          className="mb-0"
          disabled={isUploading}
          onClick={handleUploadWallpaper}
        >
          {lang('UploadImage')}
        </ListItem>

        <ListItem
          icon="colorize"
          className="mb-0"
          onClick={handleSetColor}
        >
          {lang('SetColor')}
        </ListItem>

        <ListItem icon="favorite" onClick={handleResetToDefault}>
          {lang('ThemeResetToDefaults')}
        </ListItem>

        <Checkbox
          label={lang('BackgroundBlurred')}
          checked={Boolean(isBlurred) && canBlur}
          disabled={!canBlur}
          onChange={handleWallPaperBlurChange}
        />
      </Island>

      <div className="settings-backgrounds">
        <Island className="settings-backgrounds-picker">
          <div className="settings-backgrounds-column">
            <h4 className="settings-backgrounds-title">{lang('ParvaneBgPattern')}</h4>
            <div className="settings-backgrounds-list is-patterns">
              {PATTERN_IDS.map((id) => {
                const isSelected = combination?.pattern === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className={buildClassName('settings-backgrounds-tile', isSelected && 'selected')}
                    style={`${patternTileStyle}; --bg-drawing: url("${PATTERN_URLS[id]}")`}
                    title={lang(PATTERN_NAME_KEYS[id])}
                    aria-label={lang(PATTERN_NAME_KEYS[id])}
                    aria-pressed={isSelected}
                    data-bg-pattern={id}
                    data-bg-selected={isSelected ? 'true' : undefined}
                    onClick={handlePatternClick}
                  >
                    <span className="settings-backgrounds-drawing" />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="settings-backgrounds-column">
            <h4 className="settings-backgrounds-title">{lang('ParvaneBgColour')}</h4>
            <div className="settings-backgrounds-list is-gradients">
              {GRADIENTS.map((preset, index) => {
                const isSelected = combination?.gradient === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={buildClassName('settings-backgrounds-tile', isSelected && 'selected')}
                    style={`--bg-gradient: ${gradientCss(preset)}`}
                    aria-label={`${lang('ParvaneBgColour')} ${index + 1}`}
                    aria-pressed={isSelected}
                    data-bg-gradient={preset.id}
                    data-bg-selected={isSelected ? 'true' : undefined}
                    onClick={handleGradientClick}
                  />
                );
              })}
            </div>
          </div>
        </Island>
      </div>

      {loadedWallpapers?.length ? (
        <Island className="settings-backgrounds-own" data-bg-own="true">
          <h4 className="settings-backgrounds-title">{lang('ParvaneBgOwn')}</h4>
          <div className="settings-wallpapers">
            {loadedWallpapers.map((wallpaper) => (
              <WallpaperTile
                key={wallpaper.slug}
                wallpaper={wallpaper}
                theme={theme}
                isSelected={!picked && background === wallpaper.slug}
                onClick={handleWallPaperSelect}
              />
            ))}
          </div>
        </Island>
      ) : undefined}
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const theme = selectTheme(global);
    const { background, isBlurred } = selectThemeValues(global, theme) || {};
    const { loadedWallpapers } = global.settings;

    return {
      background,
      isBlurred,
      loadedWallpapers,
      theme,
    };
  },
)(SettingsGeneralBackground));
