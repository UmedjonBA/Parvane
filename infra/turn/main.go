// Parvane TURN-сервер (обход NAT для звонков). Аналог coturn на userspace (pion),
// чтобы поднимать без root. Клиент указывает адрес через PARVANE_TURN=
// turn:host:port + PARVANE_TURN_USER/PARVANE_TURN_PASS. Также раздаёт STUN.
//
// Конфиг через окружение:
//   TURN_PUBLIC_IP  — внешний IP сервера (в relay-кандидатах). По умолч. 127.0.0.1
//   TURN_PORT       — UDP-порт (по умолч. 3478)
//   TURN_MIN_PORT/TURN_MAX_PORT — диапазон relay-портов (для проброса через NAT);
//                     без них relay берёт случайные эфемерные порты
//   TURN_REALM      — realm (по умолч. parvane)
//   TURN_USER/TURN_PASS — статические креды (по умолч. parvane/parvane)
//   TURN_SECRET     — включает краткоживущие креды (TURN REST): username
//                     "<expiry>:<user>", password = base64(HMAC-SHA1(secret, username)).
//                     Выдаёт их call-шард по call.ice.request. Статический
//                     пользователь продолжает работать параллельно.
package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pion/turn/v4"
)

// Проверка ephemeral-кредов TURN REST: не истёк ли expiry в username и ключ
// из пароля, восстановимого по секрету.
func restAuthKey(secret, username, realm string) ([]byte, bool) {
	expiryPart, _, found := strings.Cut(username, ":")
	if !found {
		return nil, false
	}
	expiry, err := strconv.ParseInt(expiryPart, 10, 64)
	if err != nil || time.Now().Unix() > expiry {
		return nil, false
	}
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return turn.GenerateAuthKey(username, realm, password), true
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	publicIP := env("TURN_PUBLIC_IP", "127.0.0.1")
	port := env("TURN_PORT", "3478")
	realm := env("TURN_REALM", "parvane")
	// Пустой TURN_USER полностью ОТКЛЮЧАЕТ статичный long-term кред — остаётся
	// только ephemeral REST (TURN_SECRET), который выдаёт call-шард по JWT.
	// Так нет постоянного разделяемого пароля, чья утечка = воровство relay.
	user := os.Getenv("TURN_USER")
	pass := os.Getenv("TURN_PASS")
	secret := os.Getenv("TURN_SECRET")

	udpListener, err := net.ListenPacket("udp4", "0.0.0.0:"+port)
	if err != nil {
		log.Fatalf("не слушается UDP :%s: %v", port, err)
	}

	// Ключ статичного пользователя (long-term); пуст, если TURN_USER не задан.
	key := turn.GenerateAuthKey(user, realm, pass)

	var relayGen turn.RelayAddressGenerator = &turn.RelayAddressGeneratorStatic{
		RelayAddress: net.ParseIP(publicIP),
		Address:      "0.0.0.0",
	}
	minPort, errMin := strconv.Atoi(env("TURN_MIN_PORT", ""))
	maxPort, errMax := strconv.Atoi(env("TURN_MAX_PORT", ""))
	if errMin == nil && errMax == nil {
		if minPort <= 0 || maxPort > 65535 || minPort > maxPort {
			log.Fatalf("некорректный диапазон relay-портов: %d..%d", minPort, maxPort)
		}
		relayGen = &turn.RelayAddressGeneratorPortRange{
			RelayAddress: net.ParseIP(publicIP),
			Address:      "0.0.0.0",
			MinPort:      uint16(minPort),
			MaxPort:      uint16(maxPort),
		}
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			if user != "" && username == user {
				return key, true
			}
			if secret != "" {
				if restKey, ok := restAuthKey(secret, username, realm); ok {
					return restKey, true
				}
			}
			log.Printf("TURN auth отказ: username=%q (%s)", username, srcAddr)
			return nil, false
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            udpListener,
			RelayAddressGenerator: relayGen,
		}},
	})
	if err != nil {
		log.Fatalf("TURN-сервер не поднялся: %v", err)
	}
	staticAuth := "off"
	if user != "" {
		staticAuth = "on (" + user + ")"
	}
	log.Printf("Parvane TURN/STUN на :%s (realm=%s, public=%s, static-user=%s, ephemeral=%t)",
		port, realm, publicIP, staticAuth, secret != "")
	defer func() { _ = server.Close() }()

	select {}
}
