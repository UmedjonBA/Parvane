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
 *
 * spec 036 (T036, T048 spec 035): ядро держит эти файлы записями `host-file` зашифрованного хранилища движка
 * (`HostFiles`: DEK под ключом устройства, пачки с fsync); прежний файл storecrypt переносится один раз при первом
 * обращении и переименовывается в `<имя>.migrated` — поэтому «есть ли файл» спрашивается у кодека ([exists]), а не
 * у файловой системы.
 */
object SeamFiles {
    interface Codec {
        fun read(path: String): String
        fun write(path: String, text: String): Boolean
        /** Файл есть (в хранилище ядра либо прежним файлом, который ещё не перенесён). */
        fun exists(path: String): Boolean
    }

    @Volatile var codec: Codec? = null

    fun exists(file: File): Boolean = codec?.exists(file.path) ?: file.exists()

    fun read(file: File): String = codec?.read(file.path) ?: file.readText()

    fun write(file: File, text: String) {
        val c = codec
        if (c == null) { file.writeText(text); return }
        // Ядро отказалось писать (нет ключа Keystore, storecrypt::setRequired) — открытым текстом не пишем (NAT-13)
        if (!c.write(file.path, text)) android.util.Log.w("SeamFiles", "запись ${file.name} отклонена ядром — на диск не пишется")
    }
}
