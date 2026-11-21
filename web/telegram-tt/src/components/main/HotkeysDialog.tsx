import { memo, useLayoutEffect } from '../../lib/teact/teact';

import type { RegularLangKey } from '../../types/language';
import type { ParvaneModuleId } from '../../util/parvaneModules';

import { IS_MAC_OS } from '../../util/browser/windowEnvironment';
import buildClassName from '../../util/buildClassName';
import captureKeyboardListeners from '../../util/captureKeyboardListeners';
import { formatHotkey } from './globalHotkeys';
import { MODULE_TITLE_KEYS } from './parvaneModuleNav';

import useLang from '../../hooks/useLang';
import useParvaneModules from '../../hooks/useParvaneModules';

import Portal from '../ui/Portal';

import kit from '../parvane/notes/PvKit.module.scss';
import styles from './ParvaneShell.module.scss';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
};

type Hotkey = { titleKey: RegularLangKey; keys: string; spaceKey?: boolean };

// Состав — по доске `ZdNav` («Горячие клавиши»). Группа модуля видна, только пока модуль включён
const EVERYWHERE: Hotkey[] = [
  { titleKey: 'ShellKeyModule', keys: 'Ctrl+1 … 7' },
  { titleKey: 'ShellKeySearch', keys: 'Ctrl+K' },
  { titleKey: 'ShellKeySettings', keys: 'Ctrl+,' },
  { titleKey: 'ShellKeyBack', keys: 'Esc' },
  { titleKey: 'ShellKeyMusic', keys: 'Ctrl+', spaceKey: true },
];
const BY_MODULE: { module: ParvaneModuleId; keys: Hotkey[] }[] = [
  {
    module: 'chats',
    keys: [
      { titleKey: 'ShellKeyNewMessage', keys: 'Ctrl+N' },
      { titleKey: 'ShellKeyEditLast', keys: '↑' },
      { titleKey: 'ShellKeySend', keys: 'Enter' },
      { titleKey: 'ShellKeyNewLine', keys: 'Shift+Enter' },
    ],
  },
  {
    module: 'notes',
    keys: [
      { titleKey: 'ShellKeyNoteMode', keys: 'Ctrl+E' },
      { titleKey: 'ShellKeyNewNote', keys: 'Ctrl+N' },
      { titleKey: 'ShellKeyNoteLink', keys: '[[' },
    ],
  },
  {
    module: 'plan',
    keys: [
      { titleKey: 'ShellKeyNewEntry', keys: 'N' },
      { titleKey: 'ShellKeyToday', keys: 'T' },
      { titleKey: 'ShellKeyWeek', keys: '← →' },
      { titleKey: 'ShellKeyDone', keys: '', spaceKey: true },
    ],
  },
  {
    module: 'files',
    keys: [
      { titleKey: 'ShellKeyUpload', keys: 'Ctrl+U' },
      { titleKey: 'ShellKeyRename', keys: 'F2' },
      { titleKey: 'ShellKeyTrash', keys: 'Del' },
    ],
  },
];

// Parvane (доска `ZdNav`): окно «Горячие клавиши» — Ctrl+/ из любого места; Escape и «Закрыть» закрывают
const HotkeysDialog = ({ isOpen, onClose }: OwnProps) => {
  const lang = useLang();
  const { enabled } = useParvaneModules();

  useLayoutEffect(() => (isOpen ? captureKeyboardListeners({ onEsc: onClose }) : undefined), [isOpen, onClose]);

  if (!isOpen) return undefined;

  function renderGroup(title: string, keys: Hotkey[], id: string) {
    return (
      <div key={id} className={styles.hotkeysGroup} data-hotkeys-group={id}>
        <h2 className={styles.groupTitle}>{title}</h2>
        <div className={styles.card}>
          {keys.map(({ titleKey, keys: combo, spaceKey }) => (
            <div key={titleKey} className={styles.row}>
              <span className={styles.rowText}>{lang(titleKey)}</span>
              <kbd className={styles.kbd}>
                {formatHotkey(combo, IS_MAC_OS)}
                {spaceKey && lang('ShellKeySpace')}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <Portal>
      <div className={buildClassName(styles.overlay, styles.overlayScrim)} data-hotkeys>
        <div
          className={buildClassName(styles.dialog, styles.hotkeys)}
          role="dialog"
          aria-label={lang('ShellHotkeysTitle')}
        >
          <div className={styles.hotkeysHead}>
            <div className={styles.hotkeysTitles}>
              <h1 className={styles.title}>{lang('ShellHotkeysTitle')}</h1>
              <p className={styles.text}>{lang('ShellHotkeysHint', { keys: formatHotkey('Ctrl+/', IS_MAC_OS) })}</p>
            </div>
            <button type="button" className={kit.chip} data-hotkeys-close onClick={onClose}>
              {lang('Close')}
            </button>
          </div>
          <div className={styles.hotkeysColumns}>
            {renderGroup(lang('ShellHotkeysEverywhere'), EVERYWHERE, 'everywhere')}
            {BY_MODULE.filter(({ module }) => enabled.includes(module))
              .map(({ module, keys }) => renderGroup(lang(MODULE_TITLE_KEYS[module]), keys, module))}
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default memo(HotkeysDialog);
