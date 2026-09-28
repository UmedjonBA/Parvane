package org.parvane.core

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * P-13: ключ шифрования локального хранилища ядра. 32 случайных байта хранятся
 * в `<storeDir>/store.key` завёрнутыми AES-GCM-ключом из Android Keystore
 * (не экспортируемым, привязанным к приложению). Копия каталога `files/`
 * без Keystore устройства бесполезна. Ключ Keystore не требует Context.
 */
object StoreKey {
    private const val TAG = "ParvaneStoreKey"
    private const val ALIAS = "parvane-store-v1"
    private const val FILE = "store.key"
    private const val KEY_BYTES = 32
    private const val IV_BYTES = 12

    /** Развернуть (или создать) ключ хранилища. Пустой массив — Keystore недоступен. */
    @JvmStatic
    fun load(storeDir: File): ByteArray {
        return try {
            storeDir.mkdirs()
            val wrapper = keystoreKey()
            val file = File(storeDir, FILE)
            if (file.exists()) {
                val blob = file.readBytes()
                if (blob.size > IV_BYTES) {
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.DECRYPT_MODE, wrapper, GCMParameterSpec(128, blob, 0, IV_BYTES))
                    val key = cipher.doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
                    if (key.size == KEY_BYTES) return key
                }
                Log.w(TAG, "store.key повреждён — ключ будет создан заново (старые файлы не прочитаются)")
            }
            val key = ByteArray(KEY_BYTES).also { SecureRandom().nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, wrapper)
            val iv = cipher.iv
            val wrapped = cipher.doFinal(key)
            val tmp = File(storeDir, "$FILE.tmp")
            tmp.writeBytes(iv + wrapped)
            if (!tmp.renameTo(file)) {
                file.writeBytes(iv + wrapped)
                tmp.delete()
            }
            key
        } catch (e: Exception) {
            // Без Keystore (эмулятор без TEE и т.п.) ядро пишет plain и логирует это.
            Log.e(TAG, "Keystore недоступен: ${e.message}")
            ByteArray(0)
        }
    }

    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }
}
