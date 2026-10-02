package org.drinkless.tdlib

import java.io.File

/**
 * Файлы локального состояния шва (`drafts.json`, `scheduled.json`, `folders.json`,
 * `chatlists.json`, `ttl.json`, `privacy.json`, индекс паков, состояние стикеров).
 *
 * Они лежат в каталоге хранилища ядра, а ядро шифрует в нём всё (P-13, `storecrypt`).
 * Пока шов писал их открытым текстом, `migrateDir` при следующем старте запечатывал
 * файл, а шов читал шифртекст как JSON — черновики, отложенные, папки и архив терялись
 * после каждого перезапуска (найдено `tgx_ttl_scheduled_flow.sh`, 2 окт 2026).
 * Теперь чтение и запись идут через кодек ядра ([codec] ставит `Client` после
 * `ParvaneCore.init`); в JVM-тестах кодека нет — обычные файлы.
 */
object SeamFiles {
    interface Codec {
        fun read(path: String): String
        fun write(path: String, text: String): Boolean
    }

    @Volatile var codec: Codec? = null

    fun read(file: File): String = codec?.read(file.path) ?: file.readText()

    fun write(file: File, text: String) {
        if (codec?.write(file.path, text) != true) file.writeText(text)
    }
}
