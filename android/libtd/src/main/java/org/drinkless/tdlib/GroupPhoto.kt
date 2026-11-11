package org.drinkless.tdlib

/** Фото группы (GPHOTO-1, spec 035 T138 / PV-005): когда скачивать файл фото из сведений группы. */
object GroupPhoto {
    /** Скачать заново: сменился файл фото ЛИБО пришёл (сменился) его секрет — секрет частной группы приходит позже записи
     *  SetInfo теми же сведениями; без него файл не расшифровывается, с ним — должен быть скачан ещё раз. */
    fun needsDownload(avatar: String, avatarKey: String, previousAvatar: String, previousAvatarKey: String): Boolean =
        avatar.isNotEmpty() && (avatar != previousAvatar || avatarKey != previousAvatarKey)
}
