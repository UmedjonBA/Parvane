// Локальный поиск стикеров и GIF. Каталога на сервере нет (E2E: сервер не
// знает, что лежит в паках), поэтому поиск идёт по тому, что есть на
// устройстве: встроенный набор, установленные паки, встроенные и сохранённые
// GIF. Совпадение — по эмодзи (в том числе слово → эмодзи: свой словарь EN+RU и
// английские имена эмодзи из emoji-data), по названию набора и по имени файла.

import type { ApiSticker, ApiStickerSet, ApiVideo } from '../types';

// Слова для частых эмодзи — EN и RU; несколько форм русского слова, потому что
// совпадение — по началу слова. Имена эмодзи из emoji-data дополняют EN
const EMOJI_KEYWORDS: Record<string, string> = {
  '😀': 'smile happy grin joy улыбка улыбаюсь радость рад счастье весело',
  '🙂': 'smile slight ok улыбка нормально',
  '😊': 'smile blush happy улыбка радость мило',
  '😆': 'laugh haha смех смешно ха',
  '😅': 'sweat phew nervous пот фух неловко',
  '😂': 'laugh lol joy tears haha funny смех смешно ржу слезы ха лол',
  '🤣': 'rofl laugh lol funny смех ржу угар',
  '😉': 'wink подмигиваю подмигнуть',
  '😍': 'love heart eyes adore любовь люблю влюблен обожаю',
  '🥰': 'love hearts adore любовь люблю обожаю',
  '😘': 'kiss love поцелуй целую',
  '😎': 'cool sunglasses круто крутой очки',
  '😜': 'tongue joke wink шутка дразнить язык',
  '😏': 'smirk ухмылка хитро',
  '😐': 'neutral meh равнодушно нейтрально',
  '🤔': 'think thinking hmm думаю подумать хм размышляю',
  '🤗': 'hug обнимаю объятия обнять',
  '😇': 'angel innocent ангел невинный',
  '🥳': 'party celebrate birthday праздник вечеринка ура',
  '🤯': 'mind blown shock взрыв мозга шок',
  '😢': 'sad cry tear грусть грустно печаль плачу',
  '😭': 'cry sob sad плачу рыдаю грусть',
  '😡': 'angry rage mad злой злюсь ярость гнев',
  '😱': 'scream fear shock scared ужас страх шок кричу',
  '😴': 'sleep tired sleepy сон сплю спать устал',
  '🙈': 'monkey shy see no evil обезьяна стыдно стесняюсь не вижу',
  '🤦': 'facepalm facepalm фейспалм рукалицо',
  '🤷': 'shrug dunno whatever не знаю пожимаю',
  '👀': 'eyes look see глаза смотрю вижу',
  '👋': 'hello hi wave bye привет пока здравствуй машу',
  '👍': 'like ok yes good thumbs up лайк класс хорошо да согласен отлично',
  '👎': 'dislike no bad thumbs down плохо нет',
  '👌': 'ok okay perfect хорошо окей отлично',
  '👏': 'clap applause bravo аплодисменты браво хлопаю',
  '🙏': 'please thanks pray пожалуйста спасибо благодарю молюсь',
  '💪': 'strong muscle power сила сильный мышцы',
  '✌️': 'peace victory мир победа',
  '🤝': 'handshake deal договорились рукопожатие сделка',
  '❤️': 'love heart red любовь сердце сердечко люблю',
  '💔': 'broken heart разбитое сердце',
  '🔥': 'fire hot lit огонь горячо жара пожар огонек',
  '✨': 'sparkles magic shine блеск искры магия',
  '⭐': 'star звезда звездочка',
  '⚡': 'lightning zap bolt молния энергия',
  '💯': 'hundred perfect сто идеально',
  '✅': 'done check yes готово галочка сделано',
  '❌': 'no cross cancel нет крестик отмена',
  '🎉': 'party tada congrats celebrate праздник поздравляю ура вечеринка',
  '🎊': 'confetti party celebrate конфетти праздник',
  '🎂': 'cake birthday торт день рождения',
  '🎁': 'gift present подарок',
  '🎈': 'balloon party шарик праздник',
  '🕺': 'dance dancing man танец танцую танцы',
  '💃': 'dance dancing woman танец танцую танцы',
  '🚀': 'rocket launch space fast ракета космос запуск быстро',
  '✈️': 'plane flight travel самолет полет путешествие',
  '🚗': 'car drive машина авто',
  '🏠': 'home house дом домой',
  '☕': 'coffee tea кофе чай',
  '🍕': 'pizza пицца еда',
  '🍺': 'beer пиво',
  '🐱': 'cat kitty кот кошка котик',
  '🐶': 'dog puppy собака пес песик',
  '🦋': 'butterfly moth бабочка мотылек',
  '🌙': 'moon night луна ночь',
  '☀️': 'sun sunny солнце солнечно',
  '🌈': 'rainbow радуга',
  '🌸': 'flower blossom цветок цветы',
  '🍀': 'clover luck клевер удача',
  '❄️': 'snow cold winter снег холод зима',
  '💎': 'diamond gem алмаз бриллиант',
  '💰': 'money cash деньги',
  '📚': 'books study книги учеба',
  '🎵': 'music song музыка песня',
  '⚽': 'football soccer футбол мяч',
  '💤': 'sleep zzz сон спать',
};

const VARIATION_SELECTORS = /[︎️]/g;
const EMOJI_CHAR = /\p{Extended_Pictographic}/u;
const MIN_WORD_QUERY = 2;

export function normalizeEmoji(emoji: string) {
  return emoji.replace(VARIATION_SELECTORS, '');
}

function splitWords(text: string) {
  return text.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

type EmojiNames = Map<string, string[]>;

let emojiNames: EmojiNames = new Map();

type EmojiRawData = ReadonlyArray<unknown>;

/**
 * Английские имена эмодзи из `emoji-data-ios/emoji-data.json` (формат Web A:
 * [категория, [[unified, [имена…]], …], …]); без них работает только словарь.
 */
export function setEmojiNameData(data: EmojiRawData) {
  const names: EmojiNames = new Map();
  for (let i = 1; i < data.length; i += 2) {
    const list = data[i] as Array<[string, string[]]>;
    if (!Array.isArray(list)) continue;
    list.forEach(([unified, aliases]) => {
      if (typeof unified !== 'string' || !Array.isArray(aliases)) return;
      const native = normalizeEmoji(String.fromCodePoint(...unified.split('-').map((code) => parseInt(code, 16))));
      names.set(native, aliases.flatMap((alias) => splitWords(alias)));
    });
  }
  emojiNames = names;
}

export function hasEmojiNameData() {
  return emojiNames.size > 0;
}

function keywordsOf(emoji: string) {
  const own = EMOJI_KEYWORDS[emoji] ?? EMOJI_KEYWORDS[normalizeEmoji(emoji)];
  return [...(own ? splitWords(own) : []), ...(emojiNames.get(normalizeEmoji(emoji)) || [])];
}

/** Слово запроса совпадает со словом: 2 — целиком, 1 — по началу, 0 — нет. */
function matchWord(queryWord: string, word: string) {
  if (word === queryWord) return 2;
  return queryWord.length >= MIN_WORD_QUERY && word.startsWith(queryWord) ? 1 : 0;
}

/** Совпадение всех слов запроса со списком слов: сумма очков либо 0. */
export function matchWords(queryWords: string[], words: string[]) {
  if (!queryWords.length || !words.length) return 0;
  let score = 0;
  for (const queryWord of queryWords) {
    const best = Math.max(0, ...words.map((word) => matchWord(queryWord, word)));
    if (!best) return 0;
    score += best;
  }
  return score;
}

/** Эмодзи из самого запроса (пользователь вставил 😂). */
function emojisInQuery(query: string) {
  const found = new Set<string>();
  const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;
  const parts = segmenter ? Array.from(segmenter.segment(query), (s) => s.segment) : Array.from(query);
  parts.forEach((part) => {
    if (EMOJI_CHAR.test(part)) found.add(normalizeEmoji(part));
  });
  return found;
}

/** Очки эмодзи по запросу: эмодзи из запроса — 3, по словам — 1–2 на слово. */
export function scoreEmoji(emoji: string, query: string) {
  const normalized = normalizeEmoji(emoji);
  if (emojisInQuery(query).has(normalized)) return 3;
  return matchWords(splitWords(query), keywordsOf(emoji));
}

function scoreStickerEmoji(sticker: ApiSticker, query: string) {
  if (!sticker.emoji) return 0;
  // У стикера может быть несколько эмодзи подряд — берём лучшее
  const parts = Array.from(sticker.emoji.matchAll(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu))
    .map((match) => match[0]);
  return Math.max(0, ...(parts.length ? parts : [sticker.emoji]).map((part) => scoreEmoji(part, query)));
}

export type StickerSearchSource = {
  set: ApiStickerSet;
  /** Слова имени файла стикера (паки из файлов): id стикера → слова. */
  fileWords?: Map<string, string[]>;
};

const COVERS_LIMIT = 5;

/**
 * Наборы, подходящие под запрос: по названию набора и по стикерам (эмодзи,
 * имя файла). У каждого набора в ответе `covers` — найденные стикеры (в
 * карточке результата они идут первыми); у найденного только по названию —
 * пустой список, чтобы не оставались обложки прошлого поиска.
 */
export function searchStickerSets(query: string, sources: StickerSearchSource[]): ApiStickerSet[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const queryWords = splitWords(trimmed);
  const scored = sources.map(({ set, fileWords }) => {
    const matches = (set.stickers || [])
      .map((sticker) => ({
        sticker,
        score: Math.max(scoreStickerEmoji(sticker, trimmed), matchWords(queryWords, fileWords?.get(sticker.id) || [])),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);
    const titleScore = matchWords(queryWords, splitWords(`${set.title} ${set.shortName}`));
    const best = Math.max(titleScore, matches[0]?.score || 0);
    return {
      set, matches, best, titleScore,
    };
  }).filter(({ best }) => best > 0);

  return scored
    .sort((a, b) => b.best - a.best || b.matches.length - a.matches.length)
    .map(({ set, matches }) => ({
      ...set,
      covers: matches.slice(0, COVERS_LIMIT).map(({ sticker }) => sticker),
    }));
}

export type GifSearchSource = {
  gif: ApiVideo;
  emoji?: string;
  words?: string[];
};

/** Слова имени файла: `happy-cat_01.webm` → happy, cat, 01; служебные имена — без слов. */
export function wordsOfFileName(fileName?: string) {
  if (!fileName) return [];
  const base = fileName.replace(/\.[^.]+$/, '');
  if (/^(animation|video|gif)(-[0-9a-f]+)?$/i.test(base)) return [];
  return splitWords(base.replace(/[_-]+/g, ' '));
}

/** GIF по запросу; пустой запрос — все (как «популярные» в Telegram). */
export function searchGifSources(query: string, sources: GifSearchSource[]): ApiVideo[] {
  const trimmed = query.trim();
  if (!trimmed) return sources.map(({ gif }) => gif);
  const queryWords = splitWords(trimmed);
  return sources
    .map((source) => ({
      gif: source.gif,
      score: Math.max(
        source.emoji ? scoreEmoji(source.emoji, trimmed) : 0,
        matchWords(queryWords, [...(source.words || []), ...wordsOfFileName(source.gif.fileName)]),
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ gif }) => gif);
}
