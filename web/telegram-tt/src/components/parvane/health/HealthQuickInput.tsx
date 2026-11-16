import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { HealthParseResult } from './healthTypes';

import buildClassName from '../../../util/buildClassName';
import { kindTitleKey, parsedValue } from './healthFormat';
import { addHealthEntries, parseHealthInput } from './healthStore';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  // Заготовка строки и просьба поставить курсор (кнопка «+», команды поиска)
  request?: { text?: string };
  onRequestHandled: NoneToVoidFunction;
};

const PARSE_DELAY_MS = 200;

// Parvane (spec 038, HEALTH-2): запись одной строкой. Под полем — как движок понял ввод, до сохранения:
// что запишется и что не разобрано. Enter сохраняет понятое
const HealthQuickInput = ({ request, onRequestHandled }: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<HealthParseResult>();
  const [isSaving, setIsSaving] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const parseIdRef = useRef(0);

  useEffect(() => {
    if (!request) return;
    if (request.text !== undefined) setText(request.text);
    inputRef.current?.focus();
    onRequestHandled();
  }, [request, onRequestHandled]);

  // Разбор идёт с задержкой после набора; ответ устаревшего запроса отбрасывается
  useEffect(() => {
    const id = ++parseIdRef.current;
    if (!text.trim()) {
      setParsed(undefined);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void parseHealthInput(text).then((result) => {
        if (id === parseIdRef.current) setParsed(result);
      });
    }, PARSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

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
      setParsed(result);
      setHasFailed(true);
      return;
    }
    // Непонятое остаётся в поле — его можно поправить и записать ещё раз
    setText(result!.unparsed.join(' '));
  });

  const entries = parsed?.entries || [];
  const unparsed = parsed?.unparsed || [];

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
          {entries.map((entry, index) => {
            const titleKey = kindTitleKey(entry.kind);
            return (
              <span key={`${entry.kind}${index}`} className={styles.quickChip} data-kind={entry.kind}>
                {titleKey ? lang(titleKey) : entry.kind}
                {' · '}
                <b className={kit.mono}>{parsedValue(entry, lang.code)}</b>
                {' · '}
                {entry.kind === 'sleep' && entry.endMs ? entry.endDay : `${entry.day}, ${entry.time}`}
              </span>
            );
          })}
          {unparsed.map((piece) => (
            <span key={piece} className={buildClassName(styles.quickChip, styles.quickChipUnparsed)} data-unparsed>
              {lang('HealthQuickUnparsed', { text: piece })}
            </span>
          ))}
          {Boolean(entries.length) && !isSaving && <span className={kit.muted}>{lang('HealthQuickEnter')}</span>}
          {parsed && !entries.length && !unparsed.length && (
            <span className={kit.muted}>{lang('HealthQuickNothing')}</span>
          )}
          {hasFailed && <span className={styles.quickError}>{lang('HealthQuickFailed')}</span>}
        </div>
      )}
    </form>
  );
};

export default memo(HealthQuickInput);
