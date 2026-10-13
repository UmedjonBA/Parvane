// Parvane (B4): заглушка запуска ждёт шрифты оформления — IBM Plex Sans (spec 019), а не Roboto (он теперь
// запасной): иначе интерфейс появлялся в Roboto и через мгновение перескакивал на Plex. Начертания — только
// нужные с первого кадра (400/500); 600 и моно догружаются сами. Текст с латиницей и кириллицей — чтобы
// `fonts.load` поднял оба набора `unicode-range`, а не только латинский (по умолчанию проверяется пробел)
const SITE_FONTS = ['400 1em "IBM Plex Sans"', '500 1em "IBM Plex Sans"'];
const SAMPLE_TEXT = 'Aa Яя';

export default function preloadFonts() {
  if ('fonts' in document) {
    return Promise.all(SITE_FONTS.map((font) => document.fonts.load(font, SAMPLE_TEXT)));
  }

  return undefined;
}
