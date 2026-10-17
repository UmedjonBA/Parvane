// Перевод сообщений на устройстве (spec 024 И4, решение пользователя 17 окт 2026):
// только встроенный переводчик браузера (Translator / LanguageDetector API) —
// текст сообщения не уходит ни на наш, ни на чужой сервер. Где API нет, пункт
// «Перевести» не показывается (`IS_TRANSLATION_SUPPORTED`).

import type { ApiChat, ApiFormattedText } from '../types';

type TranslatorLike = { translate(text: string): Promise<string> };
type TranslatorApi = {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorLike>;
};
type DetectorLike = { detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]> };
type DetectorApi = { create(): Promise<DetectorLike> };

type Deps = {
  getText: (chatId: string, messageId: number) => string | undefined;
  sendUpdate: (update: Record<string, unknown>) => void;
  log: (message: string) => void;
};

function translatorApi() {
  return (globalThis as { Translator?: TranslatorApi }).Translator;
}

function detectorApi() {
  return (globalThis as { LanguageDetector?: DetectorApi }).LanguageDetector;
}

/** Короткий код языка (`en-US` → `en`): переводчик браузера работает с ними. */
export function baseLanguage(code: string) {
  return code.split(/[-_]/)[0].toLowerCase();
}

export function createTranslation(deps: Deps) {
  const translators = new Map<string, Promise<TranslatorLike>>();
  let detector: Promise<DetectorLike> | undefined;

  async function detect(text: string) {
    const api = detectorApi();
    if (!api) return undefined;
    detector ||= api.create();
    const [best] = await (await detector).detect(text);
    return best && best.confidence >= 0.5 ? baseLanguage(best.detectedLanguage) : undefined;
  }

  async function translator(source: string, target: string) {
    const key = `${source}>${target}`;
    let pending = translators.get(key);
    if (!pending) {
      const api = translatorApi();
      if (!api) throw new Error('переводчик браузера недоступен');
      const availability = await api.availability({ sourceLanguage: source, targetLanguage: target });
      if (availability === 'unavailable') throw new Error(`пара языков ${key} недоступна`);
      pending = api.create({ sourceLanguage: source, targetLanguage: target });
      // Неудачное создание не кэшируем — следующий запрос попробует снова
      pending.catch(() => translators.delete(key));
      translators.set(key, pending);
    }
    return pending;
  }

  async function translateOne(text: string, target: string): Promise<ApiFormattedText> {
    const source = await detect(text);
    // Язык не распознан или совпадает с целевым — показываем текст как есть
    if (!source || source === target) return { text };
    return { text: await (await translator(source, target)).translate(text) };
  }

  async function translateText(params: {
    chat?: ApiChat; messageIds?: number[]; text?: ApiFormattedText[]; toLanguageCode: string; tone?: string;
  }) {
    const target = baseLanguage(params.toLanguageCode);
    if (params.chat && params.messageIds) {
      const { chat, messageIds } = params;
      try {
        const translations = await Promise.all(
          messageIds.map((id) => translateOne(deps.getText(chat.id, id) || '', target)),
        );
        deps.sendUpdate({
          '@type': 'updateMessageTranslations',
          chatId: chat.id,
          messageIds,
          translations,
          toLanguageCode: params.toLanguageCode,
          tone: params.tone,
        });
        return translations;
      } catch (error) {
        deps.log(`перевод не удался: ${String(error)}`);
        deps.sendUpdate({
          '@type': 'failedMessageTranslations',
          chatId: chat.id,
          messageIds,
          toLanguageCode: params.toLanguageCode,
          tone: params.tone,
        });
        return undefined;
      }
    }
    try {
      return await Promise.all((params.text || []).map((t) => translateOne(t.text, target)));
    } catch (error) {
      deps.log(`перевод не удался: ${String(error)}`);
      return undefined;
    }
  }

  return { translateText };
}
