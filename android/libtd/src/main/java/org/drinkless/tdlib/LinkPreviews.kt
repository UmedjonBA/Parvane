package org.drinkless.tdlib

import org.json.JSONObject

/** spec 005: превью ссылки отправителя (`webpage {url, site_name?, title?, description?}`) → TdApi.LinkPreview. */
object LinkPreviews {
    /** Без картинок; тип Unsupported — X показывает заголовок/описание/сайт. null — нет url. */
    fun linkPreviewOf(wp: JSONObject?): TdApi.LinkPreview? {
        val url = wp?.optString("url")?.takeIf { it.isNotEmpty() } ?: return null
        val host = url.substringAfter("://").substringBefore('/')
        return TdApi.LinkPreview(url, host, wp.optString("site_name", host), wp.optString("title", ""), TdApi.FormattedText(wp.optString("description", ""), arrayOf()),
            "", TdApi.LinkPreviewTypeUnsupported(), false, false, false, false, false, 0)
    }
}
