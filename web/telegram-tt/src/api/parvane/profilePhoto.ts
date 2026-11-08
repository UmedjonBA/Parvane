// «Удалить» своё фото профиля (B8 ревью 7 ноя 2026): фото у аккаунта одно (`avatar_file_id` в identity), поэтому
// удаление текущего фото снимает аватар целиком — `identity.profile.set_avatar` с пустым id

/** Удаляется ли текущее фото профиля: tt передаёт список удаляемых фото. */
export function isCurrentAvatarDeleted(photos: { id: string }[] | undefined, currentFileId: string | undefined) {
  return Boolean(currentFileId) && Boolean(photos?.some((photo) => photo.id === currentFileId));
}
