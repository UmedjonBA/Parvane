package org.drinkless.tdlib

/**
 * Поиск людей среди известных шву (A5/A6, ревью 7 ноя 2026). «Контакты» Parvane — все собеседники, с кем есть
 * переписка или общая группа (телефонной книги нет); участники группы — из её журнала. Совпадение — как у TDLib:
 * запрос — начало любого слова имени или ника (без «@» и домена), без учёта регистра; пустой запрос — все.
 */
object PeopleSearch {
    class Person(val id: Long, val firstName: String, val lastName: String, val address: String)

    private fun words(p: Person): List<String> =
        (p.firstName.split(' ', '\t') + p.lastName.split(' ', '\t') + listOf(p.address.substringBefore('@'), p.address))
            .map { it.trim().lowercase() }.filter { it.isNotEmpty() }

    fun matches(query: String?, p: Person): Boolean {
        val q = (query ?: "").trim().removePrefix("@").lowercase()
        if (q.isEmpty()) return true
        val ws = words(p)
        val parts = q.split(' ').filter { it.isNotEmpty() }
        // каждое слово запроса — начало какого-нибудь слова (как поиск TDLib по «Имя Фамилия»)
        return parts.all { part -> ws.any { it.startsWith(part) } }
    }

    /** Отфильтровать и упорядочить по имени; [limit] ≤ 0 — без предела. */
    fun search(query: String?, people: List<Person>, limit: Int): List<Person> {
        val found = people.filter { matches(query, it) }
            .sortedWith(compareBy({ (it.firstName + " " + it.lastName).trim().lowercase().ifEmpty { it.address } }, { it.address }))
        return if (limit > 0) found.take(limit) else found
    }
}
