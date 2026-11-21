import { splitBytes } from './musicFormat';

import useLang from '../../../hooks/useLang';

type OwnProps = {
  bytes: number;
};

// Parvane (spec 041): объём для подписей «Музыки» — «512 МБ», «1,2 ГБ»
const MusicSize = ({ bytes }: OwnProps) => {
  const lang = useLang();
  return <>{formatMusicSize(lang, bytes)}</>;
};

export function formatMusicSize(lang: ReturnType<typeof useLang>, bytes: number) {
  const size = splitBytes(bytes);
  const digits = size.isGigabytes ? 1 : 0;
  const value = new Intl.NumberFormat(lang.code, { maximumFractionDigits: digits }).format(size.value);
  return lang(size.isGigabytes ? 'MusicSizeGb' : 'MusicSizeMb', { value });
}

export default MusicSize;
