import { useEffect, useRef } from '../../../lib/teact/teact';

import { Bundles } from '../../../util/moduleLoader';
import { isComposerHasSelection } from '../../middle/composer/helpers/selection';
import { getIsPaletteOpen, openPalette } from './paletteOpen';

import useDerivedState from '../../../hooks/useDerivedState';
import useModuleLoader from '../../../hooks/useModuleLoader';

// Parvane (B2): палитра смонтирована всегда, но её код — в бандле `Parvane`: сочетание клавиш слушает эта
// обёртка, сама палитра грузится при первом открытии (кнопкой боковой панели либо Ctrl+K)
const ParvanePaletteAsync = () => {
  const isOpen = useDerivedState(getIsPaletteOpen);
  const wasOpenedRef = useRef(false);
  if (isOpen) wasOpenedRef.current = true;
  const ParvanePalette = useModuleLoader(Bundles.Parvane, 'ParvanePalette', !wasOpenedRef.current);

  // Ctrl+K (Cmd+K) из любого раздела и любого поля. Исключение — выделенный текст в поле сообщения:
  // там это «вставить ссылку» редактора (`TextFormatter`)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      // `code` — чтобы сочетание работало и в русской раскладке
      if (e.code !== 'KeyK' && e.key.toLowerCase() !== 'k') return;
      if (isComposerHasSelection()) return;
      e.preventDefault();
      openPalette();
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  return ParvanePalette ? <ParvanePalette /> : undefined;
};

export default ParvanePaletteAsync;
