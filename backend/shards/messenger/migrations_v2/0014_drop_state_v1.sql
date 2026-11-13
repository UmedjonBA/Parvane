-- spec 035 T149 (12 ноя 2026, решение пользователя после переноса): разовый перенос завершён — прежний журнал
-- личного состояния `state.v1` (заморожен с 0007) и учёт минора устройств для статистики «перенесли» (0011) больше
-- не нужны. Записи `Migrated` в `user_state_log_v2` остаются (их понимает движок).
DROP TABLE IF EXISTS user_state_log;
DROP TABLE IF EXISTS user_state_head;
DROP TABLE IF EXISTS device_minor_seen;
