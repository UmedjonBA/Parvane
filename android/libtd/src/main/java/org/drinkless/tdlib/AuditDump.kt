package org.drinkless.tdlib

import java.io.File

// spec 035, T007: выгрузка «ничего не потеряно» нынешним кодом (до разового переноса). Строки `{kind,key,digest}` собирает
// ядро (`parvane-core` audit_dump, те же правила, что web `auditDump.ts`); здесь — только запись файла в каталог профиля,
// откуда сценарий (`android/tgx_seed_everything_flow.sh`) забирает её `run-as`. Только debug: ядро вне debug отдаёт пусто.
internal object AuditDump {
    const val FILE_NAME = "parvane-audit.jsonl"

    /** Снять выгрузку в `<dir>/parvane-audit.jsonl`; число строк (-1 — выгрузки нет). */
    fun write(dir: File, dump: () -> String = { org.parvane.core.ParvaneCore.auditDump() }): Int {
        val text = dump()
        if (text.isEmpty()) return -1
        val tmp = File(dir, "$FILE_NAME.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(File(dir, FILE_NAME))) return -1
        return text.count { it == '\n' }
    }
}
