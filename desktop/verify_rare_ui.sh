#!/usr/bin/env bash
# Parvane desktop — «редкое сломанное» (ревью UI 7 ноя 2026, этап 4): штатные пункты tdesktop ведут в Parvane.
# Действия — хуком PARVANE_AUTOUI (тот же вход, что у кнопки). Без правок каждая проверка падает: MTProto-заглушка
# отвечала отказом или тишиной.
#   MEDIA-2: альбом из трёх фото у bob — одна группа (одинаковый grouped_id), подпись над медиа; фото под спойлером;
#   QUOTE-1: ответ с цитатой; п. 14 «Открепить все»; п. 15 очистка группы — по адресу группы; п. 16 вкладки медиа
#   глобального поиска; п. 17 поиск в чате «от пользователя»; п. 19 выход участника и удаление группы владельцем;
#   п. 21 «Настройки архива»; п. 25 поиск по настройкам без мёртвых экранов; п. 30 ссылка профиля; п. 31 упоминание.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-rare-ui}"
A="$SB/alice"; B="$SB/bob"; AL="$A/td/log.txt"; BL="$B/td/log.txt"
S=$(date +%s)
mkdir -p "$SB/media"
python3 - "$SB/media" <<'PY'
import sys, struct, zlib
def png(path, rgb):
    def chunk(t, d):
        b = t + d
        return struct.pack(">I", len(d)) + b + struct.pack(">I", zlib.crc32(b) & 0xffffffff)
    w = h = 64
    raw = (b"\x00" + bytes(rgb) * w) * h
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                          + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
for i, c in enumerate([(200, 40, 40), (40, 200, 40), (40, 40, 200), (200, 200, 40)]):
    png(f"{sys.argv[1]}/p{i + 1}.png", c)
PY
M="$SB/media"
pair_exchange "$A" alice@local "$B" bob@local
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOUI=settingssearch:-@3,profilelink:bob@local@4,resolve:bob@local@5,resolve:nobody-$S@local@6,album:bob@local|$M/p1.png;$M/p2.png;$M/p3.png|invert@8,album:bob@local|$M/p4.png|spoiler@14,replyquote:bob@local|ответ-цитата-$S|обмен@18,chatsearch:bob@local||bob@local@22,chatsearch:bob@local|обмен|alice@local@23,pinlast:bob@local|2@26,pinned:bob@local@28,unpinall:bob@local@29,pinned:bob@local@31,newgroup:Редкая-$S|bob@local@33,archivemode:2@36,clearchat:Редкая-$S@60,leavegroup:Редкая-$S@95" \
  "PARVANE_AUTOSTATE=archive:bob@local@38")
sleep 2
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOUI=globalmedia:0@40,silent:alice@local|после-архива-$S@48,leavegroup:Редкая-$S@75")

# п. 25 — поиск по настройкам
wait_log "$AL" "autoui поиск настроек: всего [1-9][0-9]*, мёртвых 0 " 30 && ok "п. 25: в поиске настроек нет мёртвых экранов" \
  || bad "п. 25: поиск настроек находит скрытые экраны"
# п. 30 — ссылка профиля
wait_log "$AL" "autoui ссылка профиля bob@local → https://local/#@bob" 20 && ok "п. 30: ссылка профиля — свой сервер, не t.me" \
  || bad "п. 30: ссылка профиля не своя"
# п. 31 — упоминание
wait_log "$AL" "autoui resolve bob@local → " 20 && ! grep -aq "autoui resolve bob@local → нет" "$AL" \
  && ok "п. 31: известный адрес открывается по каталогу" || bad "п. 31: адрес не разрешён"
wait_log "$AL" "autoui resolve nobody-$S@local → нет" 20 && ok "п. 31: незнакомый адрес — «не найден»" \
  || bad "п. 31: незнакомый адрес без ответа"
# MEDIA-2 — альбом
wait_log "$BL" "элемент альбома [0-9]+" 90 || true
sleep 8
GIDS=$(grep -aoE "элемент альбома [0-9]+" "$BL" | awk '{print $3}' | sort | uniq -c | sort -rn)
[ "$(echo "$GIDS" | head -1 | awk '{print $1}')" = "3" ] && ok "MEDIA-2: три фото альбома у bob — одна группа" \
  || bad "MEDIA-2: альбом не сгруппирован ($GIDS)"
grep -aq "подпись над медиа" "$BL" && ok "MEDIA-2: подпись над медиа дошла" || bad "MEDIA-2: invert_media не дошёл"
wait_log "$BL" "медиа под спойлером" 40 && ok "MEDIA-2: фото под спойлером" || bad "MEDIA-2: спойлер не дошёл"
# QUOTE-1
wait_log "$AL" "исходящий ответ с цитатой \(5 симв.\)" 40 && ok "QUOTE-1: ответ с цитатой ушёл" || bad "QUOTE-1: цитата не ушла"
wait_log "$BL" "ответ с цитатой \(5 симв.\)" 60 && ok "QUOTE-1: bob получил цитату" || bad "QUOTE-1: цитата не дошла"
# п. 17 — поиск в чате
wait_log "$AL" "autoui поиск в чате bob@local «» от bob@local — найдено [1-9]" 40 \
  && ok "п. 17: «От пользователя» без текста — локально" || bad "п. 17: поиск по автору пуст"
wait_log "$AL" "autoui поиск в чате bob@local «обмен» от alice@local — найдено 1" 20 \
  && ok "п. 17: текст + автор — только свои" || bad "п. 17: отбор по автору неверен"
# п. 14 — «Открепить все»
wait_log "$AL" "autoui закреплённых в bob@local: 2" 30 && ok "п. 14: закреплено два" || bad "п. 14: закреп не сработал"
wait_log "$AL" "«Открепить все» — откреплено 2" 20 && ok "п. 14: «Открепить все» открепило оба" || bad "п. 14: не откреплено"
wait_log "$AL" "autoui закреплённых в bob@local: 0" 20 && ok "п. 14: закреплённых не осталось" || bad "п. 14: закреплённые остались"
# п. 16 — вкладка «Фото» глобального поиска у bob (альбом и фото под спойлером)
wait_log "$BL" "autoui глобальные медиа тип 0: [4-9]" 60 && ok "п. 16: вкладка «Фото» глобального поиска — из своих чатов" \
  || bad "п. 16: вкладка «Фото» пуста"
# п. 21 — «Настройки архива»: незаглушённый чат возвращается из архива новым сообщением
wait_log "$AL" "autostate archive → bob@local" 60 && ok "п. 21: чат с bob в архиве" || bad "п. 21: архив не сработал"
wait_log "$AL" "новое сообщение — чат возвращён из архива \(режим 2\)" 60 && ok "п. 21: возвращён из архива по настройке" \
  || bad "п. 21: настройка архива не действует"
[ -e "$A/td/tdata/parvane-archive-settings.json" ] && ok "п. 21: настройка сохранена на устройстве" || bad "п. 21: настройка не сохранена"
# п. 15 — очистка группы по адресу группы
GID=$(group_gid "$AL" "Редкая-$S")
wait_log "$AL" "очистка чата $GID — " 90 && ok "п. 15: очистка группы — по адресу группы" || bad "п. 15: адрес группы при очистке не найден"
# п. 19 — выход участника, удаление владельцем
wait_log "$BL" "группа $GID — выход ok" 90 && ok "п. 19: участник вышел (запись журнала группы)" || bad "п. 19: выход участника не удался"
wait_log "$AL" "группа $GID — удаление ok" 90 && ok "п. 19: владелец удалил группу" || bad "п. 19: удаление владельцем не удалось"
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$BP"; stack_stop
finish "РЕДКОЕ UI (этап 4)"
