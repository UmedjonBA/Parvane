import { useLayoutEffect } from '../../../lib/teact/teact';

import { IS_MAC_OS } from '../../../util/browser/windowEnvironment';
import { requestModuleAdd } from '../../../util/parvaneSection';

import useLastCallback from '../../../hooks/useLastCallback';

// Parvane (доска `ZdNav`): Ctrl+U в «Файлах» — «Загрузить», как «+» навигации (запрос разбирает `Cloud`). F2 и Del
// у строки — в `CloudItem`. Ctrl+U браузера («исходный код страницы») в открытых «Файлах» перехватывается
export default function useCloudHotkeys(isActive: boolean) {
  const handleKeyDown = useLastCallback((e: KeyboardEvent) => {
    const hasModifier = IS_MAC_OS ? e.metaKey : e.ctrlKey;
    if (!hasModifier || e.altKey || e.shiftKey || e.code !== 'KeyU') return;
    e.preventDefault();
    requestModuleAdd('upload');
  });

  useLayoutEffect(() => {
    if (!isActive) return undefined;
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isActive, handleKeyDown]);
}
