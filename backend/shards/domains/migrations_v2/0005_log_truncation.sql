-- spec 035 (S7-22, FR-077): журнал операций контейнера обрезан до этого seq принятым снимком с `complete`
-- (store.rs `truncate_log`). Синк с курсором меньше отдаёт пустую страницу и `truncated_upto` — клиент берёт снимок;
-- потолок операций контейнера считает живые операции (head_seq - truncated_upto).
ALTER TABLE containers ADD COLUMN truncated_upto INTEGER NOT NULL DEFAULT 0;
