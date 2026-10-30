package org.drinkless.tdlib

/**
 * Правки медиа, которые X кодирует только в строке `conversion` InputFileGenerated (обрезка, рисунок,
 * обрезка/звук видео). Шов генерацию файлов не запускает и отправляет исходник, поэтому такая отправка
 * молча выдала бы получателю неотредактированный файл (закрашенное, обрезанное). Лучше отказать.
 * Формат — filegen/PhotoGenerationInfo и VideoGenerationInfo X: "photo<rot>,<фильтры>,<crop>[,p:<рисунок>]…",
 * "video<mute 0|1>[,start…][,end…][,crop…]…". Поворот и фильтры не считаем: исходник с EXIF показывается так же.
 */
object MediaEdits {
    fun needsGeneration(conversion: String?): Boolean {
        if (conversion.isNullOrEmpty()) return false
        val parts = conversion.split(",")
        if (conversion.startsWith("photo")) {
            return parts.getOrNull(2).orEmpty().isNotEmpty() || parts.any { it.startsWith("p:") }
        }
        if (conversion.startsWith("video")) {
            if (parts[0].removePrefix("video").trim() == "1") return true
            return parts.drop(1).any { it.startsWith("start") || it.startsWith("end") || it.startsWith("crop") }
        }
        return false
    }
}
