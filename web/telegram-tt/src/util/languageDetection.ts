import type { FastTextApi } from '../lib/fasttextweb/fasttext.worker';
import type { Connector } from './PostMessageConnector';

import { DEBUG } from '../config';
import { IS_TRANSLATION_DETECTOR_SUPPORTED, IS_TRANSLATION_SUPPORTED } from './browser/windowEnvironment';

import { createConnector } from './PostMessageConnector';

const DEFAULT_THRESHOLD = 0.2;
const DEFAULT_LABELS_COUNT = 5;

const UNDEFINED_LANGUAGE = 'und';

let worker: Connector<FastTextApi> | undefined;
let languageDetector: LanguageDetector | undefined;
let initialization: Promise<void> | undefined;

// Parvane (B2): определитель языка (fasttext-wasm 1,1 МБ там, где нет `LanguageDetector`) поднимается
// только при первом запросе — а он приходит лишь при включённом переводе чатов. Раньше воркер
// запускался через 4 с после старта у всех
function ensureInitialized() {
  if (!initialization) {
    initialization = initLanguageDetection();
  }
  return initialization;
}

async function initLanguageDetection() {
  if (IS_TRANSLATION_DETECTOR_SUPPORTED) {
    try {
      languageDetector = await LanguageDetector.create();
      return;
    } catch (error) {
      // eslint-disable-next-line no-console
      if (DEBUG) console.error('Failed to initialize language detector: ', error);
    }
  }

  worker = createConnector<FastTextApi>(
    new Worker(new URL('../lib/fasttextweb/fasttext.worker.ts', import.meta.url), { type: 'module' }),
  );
}

export async function detectLanguage(text: string, threshold = DEFAULT_THRESHOLD): Promise<string | undefined> {
  if (!IS_TRANSLATION_SUPPORTED) return undefined;
  await ensureInitialized();

  if (languageDetector) {
    try {
      const results = await languageDetector.detect(text);
      const first = results[0];
      if (
        !first
        || first.detectedLanguage === UNDEFINED_LANGUAGE
        || !first.confidence
        || first.confidence < threshold
      ) return undefined;

      return first.detectedLanguage;
    } catch (error) {
      // eslint-disable-next-line no-console
      if (DEBUG) console.error('Failed to detect language: ', error);
      return undefined;
    }
  }

  const result = await worker!.request({ name: 'detectLanguage', args: [text, threshold] });
  return result;
}

export async function detectLanguageProbability(
  text: string, labelsCount = DEFAULT_LABELS_COUNT, threshold = DEFAULT_THRESHOLD,
): Promise<LanguageDetectionResult[] | undefined> {
  if (!IS_TRANSLATION_SUPPORTED) return undefined;
  await ensureInitialized();
  if (languageDetector) {
    try {
      const results = await languageDetector.detect(text);
      return results.filter((result) => result.detectedLanguage !== UNDEFINED_LANGUAGE
        && (result.confidence && result.confidence >= threshold))
        .slice(0, labelsCount);
    } catch (error) {
      // eslint-disable-next-line no-console
      if (DEBUG) console.error('Failed to detect language probability: ', error);
      return undefined;
    }
  }

  const result = await worker!.request({ name: 'detectLanguageProbability', args: [text, labelsCount, threshold] });
  return result;
}
