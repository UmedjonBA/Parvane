package org.parvane.app

/** Dev-хуки для автоматического дымового теста (extras запуска MainActivity). */
object DevHooks {
    @Volatile var autologin: String? = null   // "user@server:пароль"
    @Volatile var autosend: String? = null    // "peer@server:текст"
}
