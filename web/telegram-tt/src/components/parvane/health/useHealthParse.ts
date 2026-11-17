import { useEffect, useRef, useState } from '../../../lib/teact/teact';

import type { HealthParseResult } from './healthTypes';

import { parseHealthInput } from './healthStore';

const PARSE_DELAY_MS = 200;

type Parsed = { text: string; result?: HealthParseResult };

/**
 * Разбор строки ввода движком «Здоровья» с задержкой после набора; ответ устаревшего запроса отбрасывается.
 * `isCurrent` — разбор относится к строке, которая сейчас в поле (пока идёт набор, показан прежний).
 */
export default function useHealthParse(text: string, isDisabled?: boolean) {
  const [parsed, setParsed] = useState<Parsed>();
  const parseIdRef = useRef(0);

  useEffect(() => {
    const id = ++parseIdRef.current;
    if (isDisabled || !text.trim()) {
      setParsed(undefined);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void parseHealthInput(text).then((result) => {
        if (id === parseIdRef.current) setParsed({ text, result });
      });
    }, PARSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, isDisabled]);

  return { parsed: parsed?.result, isCurrent: parsed?.text === text };
}

/**
 * Строка целиком понята «Здоровьем»: есть что записать, ничего не осталось неразобранным и ни одна запись не
 * догадка (еда без единого числа — «обед с Петей завтра» остаётся делом «Плана»). Так решает чужой ввод; в самом
 * модуле догадки записываются.
 */
export function isWholeHealthLine(parsed: HealthParseResult) {
  return parsed.entries.length > 0 && !parsed.unparsed.length && !parsed.problems.length
    && !parsed.entries.some((entry) => entry.guess);
}
