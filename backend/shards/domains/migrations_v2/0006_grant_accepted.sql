-- Получатель принял приглашение (spec 041 E2, `domain.grant.accept`): отметка у действующего гранта-пользователя.
-- Не подписана — подсказка экрану владельца («Приглашения · ждёт ответа»). Смена роли (`ON CONFLICT … SET level`)
-- её сохраняет; отзыв и выход удаляют строку гранта вместе с отметкой.
ALTER TABLE container_grants ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0;
