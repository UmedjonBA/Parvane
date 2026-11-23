"""Тестовая выгрузка Health Connect (выдуманные данные) для tests/health_import.rs: таблицы и колонки — как у
Health Connect (AOSP HealthFitness), страницы по 1 КБ — чтобы были внутренние страницы B-дерева и переполнение.
Запуск: python3 make_health_connect.py (пишет health_connect_export.db рядом)."""
import os, sqlite3, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "health_connect_export.db")
if os.path.exists(PATH):
    os.remove(PATH)
db = sqlite3.connect(PATH)
db.execute("PRAGMA page_size = 1024")
MSK = 3 * 3600  # пояс записей, секунды
DAY = 86_400_000
T0 = 1_793_000_000_000  # 2026-10-26 около 09:33 UTC
u = lambda n: uuid.UUID(int=n).bytes

db.executescript("""
CREATE TABLE weight_record_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB UNIQUE, app_info_id INTEGER, time INTEGER NOT NULL, zone_offset INTEGER, local_date INTEGER, weight REAL NOT NULL);
CREATE TABLE blood_pressure_record_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB UNIQUE, time INTEGER NOT NULL, zone_offset INTEGER, systolic REAL, diastolic REAL, body_position INTEGER, measurement_location INTEGER);
CREATE TABLE steps_record_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB UNIQUE, app_info_id INTEGER, start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, count INTEGER);
CREATE TABLE sleep_session_record_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB UNIQUE, start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, notes TEXT, title TEXT);
CREATE TABLE sleep_stages_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, parent_key INTEGER NOT NULL, stage_start_time INTEGER, stage_end_time INTEGER, stage_type INTEGER, FOREIGN KEY (parent_key) REFERENCES sleep_session_record_table(row_id));
CREATE TABLE exercise_session_record_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB UNIQUE, start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, notes TEXT, exercise_type INTEGER, title TEXT, has_route INTEGER);
CREATE TABLE hydration_record_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB UNIQUE, start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, volume REAL);
CREATE TABLE heart_rate_record_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB UNIQUE, start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER);
CREATE TABLE heart_rate_record_series_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, parent_key INTEGER NOT NULL, beats_per_minute INTEGER, epoch_millis INTEGER);
""")
# Вес — 30 дней, граммы
for d in range(30):
    db.execute("INSERT INTO weight_record_table (uuid, app_info_id, time, zone_offset, weight) VALUES (?, 1, ?, ?, ?)", (u(1000 + d), T0 + d * DAY, MSK, 72400 - d * 10))
db.execute("INSERT INTO blood_pressure_record_table (uuid, time, zone_offset, systolic, diastolic) VALUES (?, ?, ?, 121, 79)", (u(2000), T0, MSK))
# Шаги: два приложения пишут одни и те же шаги (часами) — у дня больший итог одного приложения
for d in range(30):
    for h in range(10):
        start = T0 + d * DAY + h * 3_600_000
        db.execute("INSERT INTO steps_record_table (uuid, app_info_id, start_time, start_zone_offset, end_time, end_zone_offset, count) VALUES (?, 1, ?, ?, ?, ?, 500)", (u(3000 + d * 100 + h), start, MSK, start + 3_000_000, MSK))
        db.execute("INSERT INTO steps_record_table (uuid, app_info_id, start_time, start_zone_offset, end_time, end_zone_offset, count) VALUES (?, 2, ?, ?, ?, ?, 450)", (u(9000 + d * 100 + h), start, MSK, start + 3_000_000, MSK))
# Сон со стадиями: 23:00 — 07:00 по Москве
night = T0 - (T0 % DAY) + 20 * 3_600_000  # 20:00 UTC = 23:00 МСК
db.execute("INSERT INTO sleep_session_record_table (uuid, start_time, start_zone_offset, end_time, end_zone_offset, title) VALUES (?, ?, ?, ?, ?, ?)", (u(4000), night, MSK, night + 8 * 3_600_000, MSK, "Ночь"))
for i, (minutes, kind) in enumerate([(120, 4), (90, 5), (60, 6), (30, 1), (180, 4)]):
    start = night + sum(m for m, _ in [(120, 4), (90, 5), (60, 6), (30, 1), (180, 4)][:i]) * 60_000
    db.execute("INSERT INTO sleep_stages_table (parent_key, stage_start_time, stage_end_time, stage_type) VALUES (1, ?, ?, ?)", (start, start + minutes * 60_000, kind))
# Тренировка с длинным названием (переполнение записи на страницах по 1 КБ)
db.execute("INSERT INTO exercise_session_record_table (uuid, start_time, start_zone_offset, end_time, end_zone_offset, exercise_type, title) VALUES (?, ?, ?, ?, ?, 33, ?)", (u(5000), T0, MSK, T0 + 45 * 60_000, MSK, "Пробежка " + "по набережной " * 120))
# Вода: три стакана за день
for i in range(3):
    db.execute("INSERT INTO hydration_record_table (uuid, start_time, start_zone_offset, end_time, end_zone_offset, volume) VALUES (?, ?, ?, ?, ?, 0.25)", (u(6000 + i), T0 + i * 3_600_000, MSK, T0 + i * 3_600_000, MSK))
# Пульс: запись на день, отсчёты каждые 10 минут, 60…100
db.execute("INSERT INTO heart_rate_record_table (uuid, start_time, start_zone_offset, end_time, end_zone_offset) VALUES (?, ?, ?, ?, ?)", (u(7000), T0, MSK, T0 + 10 * 3_600_000, MSK))
for i in range(60):
    db.execute("INSERT INTO heart_rate_record_series_table (parent_key, beats_per_minute, epoch_millis) VALUES (1, ?, ?)", (60 + (i % 41), T0 + i * 600_000))
db.commit()
db.execute("VACUUM")
db.close()
print(PATH, os.path.getsize(PATH))

# Архив, как его отдаёт Health Connect («Экспорт данных»): база внутри — сценарию браузера
import zipfile
with zipfile.ZipFile(os.path.join(HERE, "health_connect_export.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.write(PATH, "health_connect_export.db")
