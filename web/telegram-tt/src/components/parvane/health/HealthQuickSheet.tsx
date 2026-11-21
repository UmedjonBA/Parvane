import {
  memo, useEffect, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { HealthEntry, HealthParsedEntry } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { closeHealthQuick, getHealthQuickRequest } from '../../../util/parvaneQuick';
import { addHealthEntries, parseHealthInput } from './healthStore';
import useHealthParse from './useHealthParse';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../notes/PvSheet';
import HealthUnderstood from './HealthUnderstood';

import kit from '../notes/PvKit.module.scss';
import styles from './HealthQuick.module.scss';

type OwnProps = {
  isWide?: boolean;
  // «Изменить»: полная форма записи с полями из разбора (запись ещё не сохранена)
  onEdit: (entry: HealthEntry) => void;
};

// Примеры строк доски `PlusModes`: нажатие подставляет строку в поле
const EXAMPLE_KEYS = [
  'HealthExampleWeight', 'HealthExamplePressure', 'HealthExamplePulse', 'HealthExampleSteps',
] as const;
const FOCUS_DELAY_MS = 100;

// Parvane (доска `PlusModes`): шторка «Запись в здоровье» — «+» модуля и команды общего поиска. Строка, как её
// понял движок («Понято как «Сон»», раскладка и вывод против цели), «Изменить» — полная форма, примеры строк,
// «Отмена / Сохранить»
const HealthQuickSheet = ({ isWide, onEdit }: OwnProps) => {
  const lang = useLang();
  const request = useDerivedState(getHealthQuickRequest);
  const isOpen = Boolean(request);
  const inputRef = useRef<HTMLInputElement>();
  const [text, setText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const { parsed, isCurrent } = useHealthParse(text, !isOpen);
  const shown = isCurrent && text.trim() ? parsed : undefined;

  // Строка и курсор — в кадре появления шторки: набранное сразу после «+» не теряется
  useLayoutEffect(() => {
    if (!request) return;
    setText(request.text || '');
    setHasFailed(false);
    setIsSaving(false);
    inputRef.current?.focus();
  }, [request]);

  // Поле появляется вместе с окном: если в кадре появления его ещё не было, курсор ставится после показа
  useEffect(() => {
    if (!isOpen) return undefined;
    const timeout = window.setTimeout(() => {
      if (document.activeElement !== inputRef.current) inputRef.current?.focus();
    }, FOCUS_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [isOpen]);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.currentTarget.value);
    setHasFailed(false);
  });

  const handleSave = useLastCallback(async () => {
    // Enter может прийти раньше перерисовки: строка берётся из самого поля
    const value = inputRef.current?.value ?? text;
    if (isSaving || !value.trim()) return;
    setIsSaving(true);
    const result = await parseHealthInput(value);
    const isAdded = result?.entries.length ? await addHealthEntries(result.entries) : false;
    setIsSaving(false);
    if (!isAdded) {
      setHasFailed(true);
      return;
    }
    // Непонятое остаётся в поле — его можно поправить и записать ещё раз
    const rest = result!.unparsed.join(' ');
    setText(rest);
    if (!rest) closeHealthQuick();
  });

  const handleEnter = useLastCallback(() => {
    void handleSave();
  });

  const handleExample = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setText(e.currentTarget.dataset.text!);
    setHasFailed(false);
    inputRef.current?.focus();
  });

  const handleEdit = useLastCallback((entry: HealthParsedEntry) => {
    closeHealthQuick();
    onEdit(buildDraftEntry(entry));
  });

  return (
    <PvSheet
      isOpen={isOpen}
      title={lang('PvQuickHealthTitle')}
      isWide={isWide}
      onClose={closeHealthQuick}
      onEnter={handleEnter}
    >
      <div className={styles.sheet} data-health-quick-sheet>
        <input
          ref={inputRef}
          className={kit.input}
          type="text"
          value={text}
          placeholder={lang('HealthQuickPlaceholder')}
          aria-label={lang('HealthQuickLabel')}
          autoComplete="off"
          enterKeyHint="done"
          data-health-quick-input
          onChange={handleChange}
        />
        {shown && <HealthUnderstood parsed={shown} onEdit={handleEdit} />}
        {shown && !shown.entries.length && (
          <div className={buildClassName(kit.muted, kit.small)}>{lang('HealthQuickNothing')}</div>
        )}
        {hasFailed && <div className={styles.error} role="alert">{lang('HealthQuickFailed')}</div>}
        <div className={kit.caps}>{lang('PvQuickExamplesTitle')}</div>
        <div className={styles.examples}>
          {EXAMPLE_KEYS.map((key) => {
            const example = lang(key);
            return (
              <button
                key={key}
                type="button"
                className={kit.chip}
                data-text={example}
                data-health-example
                onClick={handleExample}
              >
                {example}
              </button>
            );
          })}
        </div>
        <div className={kit.sheetButtons}>
          <span className={kit.grow} />
          <button type="button" className={kit.btn} onClick={closeHealthQuick}>{lang('Cancel')}</button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            disabled={!shown?.entries.length || isSaving}
            data-health-quick-save
            onClick={handleEnter}
          >
            {lang('Save')}
          </button>
        </div>
      </div>
    </PvSheet>
  );
};

// Разобранная запись → новая запись формы: id пустой, сохраняется добавлением (`HealthSheetTarget.isNew`)
function buildDraftEntry(entry: HealthParsedEntry): HealthEntry {
  return {
    id: '',
    kind: entry.kind,
    atMs: entry.atMs,
    endMs: entry.endMs,
    tzMin: entry.tzMin,
    day: entry.endDay || entry.day,
    value: entry.value,
    value2: entry.value2,
    unit: entry.unit,
    source: entry.source,
    note: '',
    name: entry.name || '',
    tag: entry.tag || '',
    parts: entry.parts || {},
  };
}

export default memo(HealthQuickSheet);
