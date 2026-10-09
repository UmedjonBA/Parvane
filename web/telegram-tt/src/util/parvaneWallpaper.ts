// Parvane: фон чата — картинка пользователя (её можно размывать) либо встроенный градиент или узор.
// Префикс совпадает с `UPLOADED_SLUG_PREFIX` провайдера (`api/parvane/wallpapers.ts`)
const UPLOADED_SLUG_PREFIX = 'wp';

export function isUploadedWallpaper(background?: string) {
  return Boolean(background?.startsWith(UPLOADED_SLUG_PREFIX));
}
