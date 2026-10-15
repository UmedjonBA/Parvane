import type { ApiArticleMedia } from '../../../api/types';

import { embedBaseName } from '../markdown/markdown';

// Файл статьи по имени из текста; путь с папками у отправителя — по последней части
export function findMedia(media: ApiArticleMedia[] | undefined, name: string) {
  return media?.find((item) => item.name === name) || media?.find((item) => item.name === embedBaseName(name));
}
