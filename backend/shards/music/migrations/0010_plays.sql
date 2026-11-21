-- «Популярное на сервере» (spec 041): прослушивания всех пользователей сервера. Одна строка — человек слушал
-- трек в этот день (сутки UTC от эпохи); загрузка на устройство прослушиванием не считается.
CREATE TABLE plays (
    track_id TEXT NOT NULL,
    artist_id TEXT NOT NULL DEFAULT '',
    user TEXT NOT NULL,
    day INTEGER NOT NULL,
    PRIMARY KEY (track_id, user, day)
);
CREATE INDEX plays_artist ON plays (artist_id, track_id);
