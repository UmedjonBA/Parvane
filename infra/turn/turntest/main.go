// Тест-клиент: запрашивает TURN-allocation у сервера. Печатает RELAY OK + адрес
// relay, если сервер выдал релей (значит TURN работает). Иначе — FAIL.
// Параметры через env: TURNTEST_ADDR (host:port), TURNTEST_USER, TURNTEST_PASS.
package main

import (
	"log"
	"net"
	"os"

	"github.com/pion/turn/v4"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	conn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		log.Fatalf("FAIL listen: %v", err)
	}
	defer func() { _ = conn.Close() }()

	addr := env("TURNTEST_ADDR", "127.0.0.1:3478")
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: addr,
		TURNServerAddr: addr,
		Conn:           conn,
		Username:       env("TURNTEST_USER", "parvane"),
		Password:       env("TURNTEST_PASS", "parvane"),
		Realm:          env("TURNTEST_REALM", "parvane"),
	})
	if err != nil {
		log.Fatalf("FAIL client: %v", err)
	}
	defer client.Close()
	if err = client.Listen(); err != nil {
		log.Fatalf("FAIL listen client: %v", err)
	}

	relayConn, err := client.Allocate()
	if err != nil {
		log.Fatalf("FAIL allocate: %v", err)
	}
	defer func() { _ = relayConn.Close() }()

	// Проверяем и рефлексивный адрес (STUN) тоже.
	mapped, err := client.SendBindingRequest()
	if err != nil {
		log.Printf("WARN stun binding: %v", err)
	} else {
		log.Printf("STUN mapped addr: %v", mapped)
	}
	log.Printf("RELAY OK: %v", relayConn.LocalAddr())
}
