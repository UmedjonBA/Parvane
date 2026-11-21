import {
  memo, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { addHealthEntries, parseHealthInput } from './healthStore';
import useHealthParse from './useHealthParse';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import HealthParsedChips from './HealthParsedChips';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  // Заготовка строки и просьба поставить курсор (кнопка «+», команды поиска, примеры)
  request?: { text?: string };
  placeholder?: string;
  // Поле в карточке подробного экрана: разбор под полем мелкими плашками
  isCompact?: boolean;
  // Первое открытие: «Как понято» строками с «Сохранить» и «Исправить» (доска `ZdHealthX`)
  isFirst?: boolean;
  onRequestHandled?: NoneToVoidFunction;
  onSaved?: NoneToVoidFunction;
};

// Parvane (spec 038, 041, HEALTH-2): запись одной строкой. Как движок понял ввод — до сохранения: одна запись —
// плашкой с галочкой и «Enter» в поле справа (доска `DeskHealth`), несколько — плашками под полем. Enter сохраняет
// понятое
const HealthQuickInput = ({
  request, placeholder, isCompact, isFirst, onRequestHandled, onSaved,
}: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const [text, setText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const { parsed } = useHealthParse(text);

  // Заготовка ставится в кадре появления — иначе ввод в этот кадр терялся
  useLayoutEffect(() => {
    if (!request) return;
    if (request.text !== undefined) setText(request.text);
    inputRef.current?.focus();
    onRequestHandled?.();
  }, [request, onRequestHandled]);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.currentTarget.value);
    setHasFailed(false);
  });

  const handleSubmit = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isSaving || !text.trim()) return;
    setIsSaving(true);
    // Сохраняется разбор именно этой строки, а не тот, что успел показаться
    const result = await parseHealthInput(text);
    const isAdded = result ? await addHealthEntries(result.entries) : false;
    setIsSaving(false);
    if (!isAdded) {
      setHasFailed(true);
      return;
    }
    // Непонятое остаётся в поле — его можно поправить и записать ещё раз
    setText(result!.unparsed.join(' '));
    onSaved?.();
  });

  const handleSave = useLastCallback(() => {
    void handleSubmit();
  });

  const handleFix = useLastCallback(() => {
    inputRef.current?.focus();
  });

  const entriesCount = parsed?.entries.length || 0;
  const isInline = !isCompact && !isFirst && entriesCount === 1 && !parsed?.unparsed.length && !hasFailed;
  const isShown = Boolean(text.trim());

  function renderPreview() {
    if (isFirst) {
      return (
        <div className={styles.firstParsed} data-health-preview>
          <div className={kit.caps}>{lang('HealthFirstParsed')}</div>
          {parsed && <HealthParsedChips parsed={parsed} isRows />}
          {hasFailed && <span className={styles.quickError}>{lang('HealthQuickFailed')}</span>}
          <div className={styles.cardButtons}>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc)}
              disabled={!entriesCount || isSaving}
              data-health-quick-save
              onClick={handleSave}
            >
              {lang('Save')}
            </button>
            <button type="button" className={kit.btn} onClick={handleFix}>{lang('HealthFirstFix')}</button>
          </div>
        </div>
      );
    }
    return (
      <div
        className={buildClassName(styles.quickPreview, isInline && styles.quickPreviewInline)}
        role="status"
        data-health-preview
      >
        {parsed && <HealthParsedChips parsed={parsed} withEnter={isInline} />}
        {Boolean(entriesCount) && !isSaving && !isInline && (
          <span className={kit.muted}>{lang('HealthQuickEnter')}</span>
        )}
        {parsed && !entriesCount && !parsed.unparsed.length && (
          <span className={kit.muted}>{lang('HealthQuickNothing')}</span>
        )}
        {hasFailed && <span className={styles.quickError}>{lang('HealthQuickFailed')}</span>}
      </div>
    );
  }

  return (
    <form
      className={buildClassName(styles.quick, isInline && styles.quickWithInline)}
      data-health-quick
      onSubmit={handleSubmit}
    >
      <input
        ref={inputRef}
        className={buildClassName(kit.input, styles.quickInput)}
        type="text"
        value={text}
        placeholder={placeholder || lang('HealthQuickPlaceholder')}
        aria-label={lang('HealthQuickLabel')}
        autoComplete="off"
        enterKeyHint="done"
        onChange={handleChange}
      />
      {isShown && renderPreview()}
    </form>
  );
};

export default memo(HealthQuickInput);
