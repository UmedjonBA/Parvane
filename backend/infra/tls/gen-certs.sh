#!/usr/bin/env bash
# Генерация самоподписанного CA + серверного сертификата для TLS на NATS.
# Результат: ca.pem (доверенный корень для клиентов/шардов), server.pem +
# server-key.pem (для nats-server). SAN: localhost + 127.0.0.1.
# Для прода заменить CN/SAN на реальный хост и хранить ключи безопасно.
set -eu
cd "$(dirname "${BASH_SOURCE[0]}")"
HOST="${1:-localhost}"

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout ca-key.pem -out ca.pem -subj "/CN=Parvane CA" 2>/dev/null

openssl req -newkey rsa:2048 -nodes \
    -keyout server-key.pem -out server.csr -subj "/CN=$HOST" 2>/dev/null

openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
    -out server.pem -days 3650 \
    -extfile <(printf "subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1" "$HOST") \
    2>/dev/null

rm -f server.csr ca.srl
echo "Готово: ca.pem, server.pem, server-key.pem (host=$HOST)"
