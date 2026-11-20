import { engineStatic } from '../../../api/parvane/v2/engine';

/** Слова сверки ключей звонка (CALL-3): считает движок по отпечаткам обеих сторон; список слов один для всех
 * языков интерфейса — собеседники с разными языками сверяют одни и те же слова. */
export function getCallSasWords(fingerprints: [string, string] | undefined) {
  if (!fingerprints) return undefined;
  try {
    const words = engineStatic<string[] | undefined>('callSasWords', {
      local: fingerprints[0], remote: fingerprints[1],
    });
    return words?.length ? words : undefined;
  } catch {
    return undefined;
  }
}
