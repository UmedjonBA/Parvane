import type { ApiLanguage } from '../../api/types';
import type {
  AnimationLevel, FoldersPosition, InterfaceStyle, PerformanceType, Point, Size, ThemeKey, TimeFormat,
} from '../../types';

export interface SharedState {
  settings: SharedSettings;
  isInitial?: true;
}

export interface SharedSettings {
  shouldUseSystemTheme: boolean;
  theme: ThemeKey;
  // Parvane (spec 008): нет значения — «Панели»
  interfaceStyle?: InterfaceStyle;
  language: string;
  languages?: ApiLanguage[];
  performance: PerformanceType;
  messageTextSize: number;
  instantViewFontSizeAdjust: number;
  animationLevel: AnimationLevel;
  foldersPosition: FoldersPosition;
  // This can be deleted after September 2025, along with the corresponding migration
  wasAnimationLevelSetManually?: boolean;
  messageSendKeyCombo: 'enter' | 'ctrl-enter';
  browserCachedPosition?: Point;
  browserCachedSize?: Size;
  timeFormat: TimeFormat;
  wasTimeFormatSetManually: boolean;
  isConnectionStatusMinimized: boolean;
  canDisplayChatInTitle: boolean;
  shouldForceHttpTransport?: boolean;
  shouldAllowHttpTransport?: boolean;
  shouldCollectDebugLogs?: boolean;
  shouldDebugExportedSenders?: boolean;
  shouldWarnAboutFiles?: boolean;
  shouldSkipBrowserCloseConfirmation: boolean;
}
