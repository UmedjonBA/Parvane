import { useEffect, useState } from '../lib/teact/teact';
import { getActions } from '../global';

import type { ThemeKey } from '../types';

import { DARK_THEME_PATTERN_COLOR, DEFAULT_PATTERN_COLOR } from '../config';
import { preloadImage } from '../util/files';
import { callApi } from '../api/gramjs';

// Parvane: фон лежит зашифрованным в SecureE2eStorage (FR-023). Провайдер
// узнаёт пользователя только после WS-коннекта и авторизации, а Main
// монтируется раньше — из кэша auth. Поэтому `not-ready` нужно ПЕРЕЖДАТЬ, а не
// принимать за «обоев нет»: сброс настройки темы необратим и раньше терял фон
// при каждой перезагрузке
const RETRY_DELAY_MS = 500;
const MAX_WAIT_MS = 60000;

type BackgroundResult = { status: 'ok'; blob: Blob } | { status: 'empty' | 'not-ready' };

const loadBackground = (theme: ThemeKey) => (
  (callApi as unknown as (
    name: string, args: { theme: string },
  ) => Promise<BackgroundResult | undefined>)('loadChatBackground', { theme })
);

const useCustomBackground = (theme: ThemeKey, settingValue?: string) => {
  const { setThemeSettings } = getActions();
  const [value, setValue] = useState(settingValue);

  useEffect(() => {
    if (!settingValue) {
      return undefined;
    }

    if (settingValue.startsWith('#')) {
      setValue(settingValue);
      return undefined;
    }

    let isCancelled = false;
    let objectUrl: string | undefined;
    const deadline = Date.now() + MAX_WAIT_MS;

    const attempt = async () => {
      if (isCancelled) return;
      const result = await loadBackground(theme).catch(() => undefined);
      if (isCancelled) return;

      if (result?.status === 'ok') {
        objectUrl = URL.createObjectURL(result.blob);
        await preloadImage(objectUrl).catch(() => undefined);
        if (isCancelled) return;
        setValue(`url(${objectUrl})`);
        return;
      }

      // Провайдер ещё не готов (или запрос не прошёл) — ждём и пробуем снова;
      // настройку НЕ трогаем
      if (result?.status !== 'empty' && Date.now() < deadline) {
        setTimeout(attempt, RETRY_DELAY_MS);
        return;
      }

      // Файла действительно нет — только теперь возвращаем тему к умолчанию
      if (result?.status === 'empty') {
        setThemeSettings({
          theme,
          background: undefined,
          backgroundColor: undefined,
          isBlurred: true,
          patternColor: theme === 'dark' ? DARK_THEME_PATTERN_COLOR : DEFAULT_PATTERN_COLOR,
        });
      }
    };

    void attempt();

    return () => {
      isCancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [settingValue, theme]);

  return settingValue ? value : undefined;
};

export default useCustomBackground;
