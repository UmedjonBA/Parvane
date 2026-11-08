/**
 * S7-1 (ревью безопасности сервера 7 ноя 2026): код сверки запроса ключа через Telegram. Опрос `tg_poll` вернул
 * код, отличный от показанного на экране, — запрос перехвачен другим входом с этим устройством (вошедший паролем
 * с тем же `device_id` начал свой запрос). Показанный код опросом не заменяется; код из опроса берётся, только
 * если своего ещё нет (как ядро `parvane::v2::telegramCodeIntercepted`).
 */
export function isTelegramCodeIntercepted(shown: string, polled: string | undefined) {
  return Boolean(shown) && Boolean(polled) && polled !== shown;
}
