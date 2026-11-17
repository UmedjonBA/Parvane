import {
  memo, useEffect, useRef, useState,
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
  // Заготовка строки и просьба поставить курсор (кнопка «+», команды поиска)
  request?: { text?: string };
  onRequestHandled: NoneToVoidFunction;
};

// Parvane (spec 038, HEALTH-2): запись одной строкой. Под полем — как движок понял ввод, до сохранения:
// что запишется и что не разобрано. Enter сохраняет понятое
const HealthQuickInput = ({ request, onRequestHandled }: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const [text, setText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const { parsed } = useHealthParse(text);

  useEffect(() => {
    if (!request) return;
    if (request.text !== undefined) setText(request.text);
    inputRef.current?.focus();
    onRequestHandled();
  }, [request, onRequestHandled]);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.currentTarget.value);
    setHasFailed(false);
  });

  const handleSubmit = useLastCallback(async (e: React.FormEvent) => {
    e.preventDefault();
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
  });

  const hasEntries = Boolean(parsed?.entries.length);

  return (
    <form className={styles.quick} data-health-quick onSubmit={handleSubmit}>
      <input
        ref={inputRef}
        className={buildClassName(kit.input, styles.quickInput)}
        type="text"
        value={text}
        placeholder={lang('HealthQuickPlaceholder')}
        aria-label={lang('HealthQuickLabel')}
        autoComplete="off"
        enterKeyHint="done"
        onChange={handleChange}
      />
      {Boolean(text.trim()) && (
        <div className={styles.quickPreview} role="status" data-health-preview>
          {parsed && <HealthParsedChips parsed={parsed} />}
          {hasEntries && !isSaving && <span className={kit.muted}>{lang('HealthQuickEnter')}</span>}
          {parsed && !hasEntries && !parsed.unparsed.length && (
            <span className={kit.muted}>{lang('HealthQuickNothing')}</span>
          )}
          {hasFailed && <span className={styles.quickError}>{lang('HealthQuickFailed')}</span>}
        </div>
      )}
    </form>
  );
};

export default memo(HealthQuickInput);
