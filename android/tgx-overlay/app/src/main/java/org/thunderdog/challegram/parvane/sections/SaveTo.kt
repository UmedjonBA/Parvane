package org.thunderdog.challegram.parvane.sections

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Log
import org.thunderdog.challegram.BaseActivity
import java.io.File

/**
 * Parvane (книга кода, ревью 7 ноя 2026): сохранение файла, который создаёт само приложение (выгрузка данных, копия
 * ключей), — как Telegram: системный выбор места (`ACTION_CREATE_DOCUMENT`), запись через ContentResolver. Ни общего
 * каталога «Загрузки», ни разрешения на хранилище: файл попадает только туда, куда пользователь сам указал.
 *
 * Отладочная сборка: при файле `/data/local/tmp/parvane-save-here` окно выбора не открывается — файл пишется в
 * `files/e2e-saved/<имя>` приложения (сценарий читает его `run-as`); в журнал — `parvane-save: <имя> → N байт`.
 */
object SaveTo {
    private const val TAG = "ParvaneSave"
    private const val REQUEST = 0x5072

    fun interface Picked {
        /** null — пользователь отказался выбирать место. */
        fun onPicked(uri: Uri?)
    }

    /** Спросить место для файла [name] типа [mime]; ответ — на главном потоке. */
    @JvmStatic
    fun pick(context: Context, name: String, mime: String, done: Picked) {
        e2eTarget(context, name)?.let { uri -> Sx.main.post { done.onPicked(uri) }; return }
        val activity = context as? BaseActivity
        if (activity == null) { Sx.main.post { done.onPicked(null) }; return }
        activity.putActivityResultHandler(REQUEST) { _, resultCode, data ->
            done.onPicked(if (resultCode == Activity.RESULT_OK) data?.data else null)
        }
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime).putExtra(Intent.EXTRA_TITLE, name)
        try {
            activity.startActivityForResult(intent, REQUEST)
        } catch (e: Throwable) {
            activity.putActivityResultHandler(REQUEST, null)
            Log.w(TAG, "нет окна выбора места: ${e.message}")
            Sx.main.post { done.onPicked(null) }
        }
    }

    /** Скопировать [from] в выбранное место; false — не записано (место освобождается). */
    @JvmStatic
    fun write(context: Context, uri: Uri, from: File): Boolean = writeWith(context, uri) { out -> from.inputStream().use { it.copyTo(out) } }

    @JvmStatic
    fun write(context: Context, uri: Uri, bytes: ByteArray): Boolean = writeWith(context, uri) { out -> out.write(bytes) }

    private fun writeWith(context: Context, uri: Uri, body: (java.io.OutputStream) -> Unit): Boolean {
        val ok = try {
            // "wt": документ, выбранный поверх существующего, перезаписывается, а не дописывается
            val stream = if (uri.scheme == "file") File(uri.path!!).also { it.parentFile?.mkdirs() }.outputStream()
                else context.contentResolver.openOutputStream(uri, "wt")
            stream?.use { body(it); true } ?: false
        } catch (e: Throwable) {
            Log.w(TAG, "запись не удалась: ${e.message}")
            false
        }
        if (ok) Log.i(TAG, "parvane-save: ${label(context, uri)} → ${size(context, uri)} байт")
        else discard(context, uri)
        return ok
    }

    /** Убрать созданный, но не записанный документ (отмена, сбой выгрузки). */
    @JvmStatic
    fun discard(context: Context, uri: Uri) {
        try {
            if (uri.scheme == "file") File(uri.path!!).delete()
            else DocumentsContract.deleteDocument(context.contentResolver, uri)
        } catch (e: Throwable) { }
    }

    /** Имя, под которым файл сохранён (поставщик мог его поправить: «(1)», другое расширение). */
    @JvmStatic
    fun label(context: Context, uri: Uri): String {
        if (uri.scheme == "file") return File(uri.path!!).name
        return try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            } ?: uri.lastPathSegment.orEmpty()
        } catch (e: Throwable) { uri.lastPathSegment.orEmpty() }
    }

    private fun size(context: Context, uri: Uri): Long = try {
        if (uri.scheme == "file") File(uri.path!!).length()
        else context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c -> if (c.moveToFirst()) c.getLong(0) else -1L } ?: -1L
    } catch (e: Throwable) { -1L }

    private fun e2eTarget(context: Context, name: String): Uri? {
        if (!org.thunderdog.challegram.BuildConfig.DEBUG || !File("/data/local/tmp/parvane-save-here").exists()) return null
        val safe = name.replace('\\', '/').substringAfterLast('/').trimStart('.').ifEmpty { "file" }
        return Uri.fromFile(File(File(context.filesDir, "e2e-saved").apply { mkdirs() }, safe))
    }
}
