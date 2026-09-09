# Parvane TURN/STUN (обход NAT для звонков)

Звонки Parvane — P2P WebRTC. В одной LAN хватает host-кандидатов, но через
интернет (за NAT) нужен STUN (узнать свой внешний адрес) и TURN (релей, когда
прямое соединение невозможно). ICE-конфиг клиентам отдаёт **шард `call`**, читая
его из своего окружения (клиент сам эти переменные не читает):

```
PARVANE_STUN_URLS=stun:turn.example.com:3478            # список через запятую
PARVANE_TURN_URL=turn:turn.example.com:3478?transport=udp,turn:...?transport=tcp
PARVANE_TURN_SECRET=<hex>                                # ephemeral REST (TURN REST API)
# TTL эфемерных кредов — PARVANE_TURN_TTL_SECS
```

На проде эти переменные задаются в `backend/infra/deploy` (см. docker-compose.yml);
сам TURN-сервер поднят на VPS (`backend/infra/turn/main.go`, systemd `parvane-turn`).

## Вариант 1 — parvane-turn (userspace, без root)

Свой TURN/STUN на pion (Go), запускается без прав root:

```bash
cd backend/infra/turn
go build -o parvane-turn .
TURN_PUBLIC_IP=<внешний_IP> TURN_USER=parvane TURN_PASS=parvane ./parvane-turn
```

Переменные: `TURN_PUBLIC_IP` (обязательно реальный публичный IP для релея),
`TURN_PORT` (3478), `TURN_REALM` (parvane), `TURN_USER`/`TURN_PASS`.

Проверка: `bash backend/infra/turn/verify_turn.sh` → должно быть `RELAY OK` + `STUN mapped`.

## Вариант 2 — coturn (если есть root)

```bash
sudo pacman -S coturn
# отредактировать external-ip в coturn.conf на реальный публичный IP
turnserver -c backend/infra/turn/coturn.conf
```

## Проверка на клиенте

Запустить два экземпляра форка с указанными выше `PARVANE_*` — в логах звонка
появятся `srflx` (через STUN) и `relay` (через TURN) ICE-кандидаты, и звонок
пройдёт даже за симметричным NAT.
