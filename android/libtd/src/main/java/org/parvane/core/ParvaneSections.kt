package org.parvane.core

import org.json.JSONObject

/**
 * Parvane: данные разделов «План», «Здоровье», «Знания», «Облако» (spec 031) — логика в ядре (порт web с тестами),
 * один рабочий поток ядра. Экраны: [show] при открытии раздела, снимки — [snapshot] по событию `sections_snapshot`
 * (domain: planner | notes | cloud). Правки «Плана» — новым состоянием целиком (web-JSON), разницу считает ядро.
 * Вызовы с ответом блокирующие — с io-потока.
 */
object ParvaneSections {
    init {
        ParvaneCore
    }

    /** chats | calendar | health | knowledge | files */
    fun show(section: String) = nativeShow(section)
    fun setVisible(visible: Boolean) = nativeVisible(visible)
    fun setPaletteOpen(open: Boolean) = nativePaletteOpen(open)
    fun setLanguage(russian: Boolean) = nativeSetLanguage(russian)
    fun sessionChanged() = nativeSessionChanged()
    fun snapshot(domain: String): JSONObject? = nativeSnapshot(domain).takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
    fun plannerReplace(stateJson: String, notice: String = ""): Boolean = nativePlannerReplace(stateJson, notice)
    fun plannerUndo(notice: String) = nativePlannerUndo(notice)
    /** Метод провайдера облака по имени web (`parvaneCloud*`); null — отказ. */
    fun cloudCall(method: String, argsJson: String): Any? = nativeCloudCall(method, argsJson).let { org.json.JSONTokener(it).nextValue() }
        .takeIf { it != JSONObject.NULL }
    fun cloudApply(container: String, opsJson: String): Boolean = nativeCloudApply(container, opsJson)
    /** Операция заметок: create, save, saveOrRestore, rename, delete, move, freeTitle, createFolder, renameFolder,
     *  deleteFolder, saveCanvas, renameCanvas, deleteCanvas, openDaily, readDaily, restoreGuide, consumeGuideOpen,
     *  applyPlanner, saveChatFiles, refresh. */
    fun notes(op: String, argsJson: String = "{}"): Any? = nativeNotes(op, argsJson).let { org.json.JSONTokener(it).nextValue() }
        .takeIf { it != JSONObject.NULL }

    @JvmStatic private external fun nativeShow(section: String)
    @JvmStatic private external fun nativeVisible(visible: Boolean)
    @JvmStatic private external fun nativePaletteOpen(open: Boolean)
    @JvmStatic private external fun nativeSetLanguage(russian: Boolean)
    @JvmStatic private external fun nativeSessionChanged()
    @JvmStatic private external fun nativeSnapshot(domain: String): String
    @JvmStatic private external fun nativePlannerReplace(stateJson: String, notice: String): Boolean
    @JvmStatic private external fun nativePlannerUndo(notice: String)
    @JvmStatic private external fun nativeCloudCall(method: String, argsJson: String): String
    @JvmStatic private external fun nativeCloudApply(container: String, opsJson: String): Boolean
    @JvmStatic private external fun nativeNotes(op: String, argsJson: String): String
}
