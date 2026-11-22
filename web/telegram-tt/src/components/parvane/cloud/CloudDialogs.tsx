import {
  memo, useEffect, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { validateName } from './cloudModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../notes/PvSheet';
import PvSwitch from '../notes/PvSwitch';

import kit from '../notes/PvKit.module.scss';
import styles from './CloudSheets.module.scss';

type NameProps = {
  isOpen: boolean;
  title: string;
  label: string;
  confirmLabel: string;
  initialName?: string;
  // Где появится папка: «в «Мой диск / Сервер»»
  note?: string;
  // Новая папка личного диска: выключатель «сразу открыть доступ»
  canShare?: boolean;
  // Имена соседей: совпавшее — ошибка в поле, без номера (доска `ZdFilesX`)
  takenNames?: string[];
  isFolder?: boolean;
  onSubmit: (name: string, isShared?: boolean) => void;
  onClose: NoneToVoidFunction;
};

const FOCUS_DELAY_MS = 150;

// Название новой папки либо новое имя файла/папки: проверка — как в движке
const CloudNameDialogBase = ({
  isOpen, title, label, confirmLabel, initialName, note, canShare, takenNames, isFolder, onSubmit, onClose,
}: NameProps) => {
  const lang = useLang();
  const [typedName, setName] = useState('');
  const [isShared, setIsShared] = useState(false);
  const [hasTried, setHasTried] = useState(false);
  const inputRef = useRef<HTMLInputElement>();

  // Имя — только при открытии окна и в том же кадре, что и само поле (layout-эффект): обычный эффект мог
  // выполниться уже после ввода и вернуть прежнее имя — «Сохранить» тогда молча ничего не менял (cloud_links)
  const wasOpenRef = useRef(false);
  useLayoutEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setName(initialName || '');
      setHasTried(false);
      setIsShared(false);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, initialName]);
  // В самом кадре открытия поле уже несёт прежнее имя: пустое поле на кадр давало склейку прежнего имени с
  // набранным, когда выделение и ввод попадали по разные стороны от перерисовки (cloud_links под нагрузкой)
  const name = isOpen && !wasOpenRef.current ? (initialName || '') : typedName;

  // Поле получает фокус, когда шторка уже на экране
  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = window.setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const isTaken = (value: string) => value !== initialName && Boolean(takenNames?.includes(value));
  const problem = validateName(name.trim());
  const errorText = !hasTried ? undefined
    : problem === 'empty' ? lang('ParvaneCloudErrorNameEmpty')
      : problem === 'too-long' ? lang('ParvaneCloudErrorNameLong')
        : problem ? lang('ParvaneCloudErrorNameChars')
          : isTaken(name.trim())
            ? lang(isFolder ? 'ParvaneCloudNameTakenFolder' : 'ParvaneCloudNameTakenFile', { name: name.trim() })
            : undefined;

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    setHasTried(false);
  });

  const handleSubmit = useLastCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    // Значение берём из самого поля: набранное сразу после открытия могло не успеть попасть в состояние
    const value = (inputRef.current?.value ?? name).trim();
    setName(value);
    setHasTried(true);
    if (validateName(value) || isTaken(value)) return;
    onSubmit(value, canShare && isShared);
  });

  const handleToggleShared = useLastCallback((isOn: boolean) => setIsShared(isOn));

  return (
    <PvSheet
      isOpen={isOpen}
      title={title}
      subtitle={note}
      className={styles.narrow}
      onClose={onClose}
      onEnter={handleSubmit}
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.field}>
          {label}
          <input
            ref={inputRef}
            id="parvane-cloud-name"
            className={kit.input}
            value={name}
            aria-label={label}
            aria-invalid={Boolean(errorText)}
            autoComplete="off"
            enterKeyHint="done"
            onChange={handleChange}
          />
        </label>
        {errorText && (
          <div className={buildClassName(kit.fieldError, styles.fieldErrorTight)} role="alert">{errorText}</div>
        )}
        {canShare && (
          <PvSwitch isOn={isShared} className={styles.switchRow} data-share-switch onChange={handleToggleShared}>
            <span className={styles.switchText}>
              {lang('ParvaneCloudShareAtOnce')}
              <span className={buildClassName(styles.note, styles.switchHint)}>
                {lang('ParvaneCloudShareAtOnceHint')}
              </span>
            </span>
          </PvSwitch>
        )}
        <div className={styles.buttons}>
          <button type="button" className={kit.btn} onClick={onClose}>{lang('Cancel')}</button>
          <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)}>{confirmLabel}</button>
        </div>
      </form>
    </PvSheet>
  );
};

export const CloudNameDialog = memo(CloudNameDialogBase);
