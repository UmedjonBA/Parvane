-- spec 035 (contracts/group-access.md, FR-070): окна членства в группах для матрицы доступа к журналу группы.
-- Окно открывает запись, сделавшая адрес участником (Create, AddMember, JoinByInvite, одобрение заявки), закрывает
-- запись выхода, исключения или бана (exit_v); повторное вступление открывает новое окно. Ведётся при каждой записи
-- журнала (v2_groups::append); журналы, принятые до миграции, пересчитываются из group_state_log при старте шарда
-- (v2_groups::rebuild_windows: записи — protobuf, SQL их не разбирает), посчитанные группы — в group_windows_built.
CREATE TABLE group_membership_windows (
    group_id BLOB    NOT NULL,
    user     TEXT    NOT NULL,
    join_v   INTEGER NOT NULL,
    exit_v   INTEGER,
    PRIMARY KEY (group_id, user, join_v)
);

CREATE TABLE group_windows_built (
    group_id BLOB PRIMARY KEY
);
