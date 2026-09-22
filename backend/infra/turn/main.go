// Parvane TURN-сервер (обход NAT для звонков). Аналог coturn на userspace (pion),
// чтобы поднимать без root. Клиент указывает адрес через PARVANE_TURN=
// turn:host:port + PARVANE_TURN_USER/PARVANE_TURN_PASS. Также раздаёт STUN.
//
// Конфиг через окружение:
//   TURN_PUBLIC_IP  — внешний IP сервера (в relay-кандидатах). По умолч. 127.0.0.1
//   TURN_PORT       — UDP-порт (по умолч. 3478)
//   TURN_TCP_PORT   — дополнительно слушать TURN по TCP (мобильные VPN/сети,
//                     режущие UDP); пусто — только UDP
//   TURN_MIN_PORT/TURN_MAX_PORT — диапазон relay-портов (для проброса через NAT);
//                     без них relay берёт случайные эфемерные порты
//   TURN_RELAY_PORT_OFFSET — сдвиг между портом, на который relay БИНДИТСЯ, и
//                     портом, который сообщается клиенту (XOR-RELAYED-ADDRESS).
//                     Для NAT хостера с range-DNAT «внешний 20160..20200 →
//                     внутренний 49160..49200» биндимся на 49160+k, а клиенту
//                     отдаём 20160+k: OFFSET=-29000. 0/пусто — без сдвига.
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

	// Сдвиг рекламируемого relay-порта (см. шапку): оборачиваем генератор.
	if off, errOff := strconv.Atoi(env("TURN_RELAY_PORT_OFFSET", "0")); errOff == nil && off != 0 {
		relayGen = &offsetRelayGen{inner: relayGen, offset: off}
	}

	var listenerConfigs []turn.ListenerConfig
	tcpPort := env("TURN_TCP_PORT", "")
	if tcpPort != "" {
		tcpListener, errTCP := net.Listen("tcp4", "0.0.0.0:"+tcpPort)
		if errTCP != nil {
			log.Fatalf("не слушается TCP :%s: %v", tcpPort, errTCP)
		}
		listenerConfigs = []turn.ListenerConfig{{
			Listener:              tcpListener,
			RelayAddressGenerator: relayGen,
		}}
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
		ListenerConfigs: listenerConfigs,
	})
	if err != nil {
		log.Fatalf("TURN-сервер не поднялся: %v", err)
	}
	staticAuth := "off"
	if user != "" {
		staticAuth = "on (" + user + ")"
	}
	log.Printf("Parvane TURN/STUN на udp:%s tcp:%q (realm=%s, public=%s, static-user=%s, ephemeral=%t)",
		port, tcpPort, realm, publicIP, staticAuth, secret != "")
	defer func() { _ = server.Close() }()

	select {}
}

// offsetRelayGen — RelayAddressGenerator, который биндит relay на внутренний порт,
// а наружу (в XOR-RELAYED-ADDRESS) отдаёт порт со сдвигом. Нужен, когда NAT
// пробрасывает внешний диапазон на внутренний с постоянным смещением.
type offsetRelayGen struct {
	inner  turn.RelayAddressGenerator
	offset int
}

func (g *offsetRelayGen) Validate() error { return g.inner.Validate() }

func (g *offsetRelayGen) shift(addr net.Addr) net.Addr {
	switch a := addr.(type) {
	case *net.UDPAddr:
		return &net.UDPAddr{IP: a.IP, Port: a.Port + g.offset, Zone: a.Zone}
	case *net.TCPAddr:
		return &net.TCPAddr{IP: a.IP, Port: a.Port + g.offset, Zone: a.Zone}
	}
	return addr
}

func (g *offsetRelayGen) AllocatePacketConn(network string, requestedPort int) (net.PacketConn, net.Addr, error) {
	conn, addr, err := g.inner.AllocatePacketConn(network, requestedPort)
	if err != nil {
		return conn, addr, err
	}
	return conn, g.shift(addr), nil
}

func (g *offsetRelayGen) AllocateConn(network string, requestedPort int) (net.Conn, net.Addr, error) {
	conn, addr, err := g.inner.AllocateConn(network, requestedPort)
	if err != nil {
		return conn, addr, err
	}
	return conn, g.shift(addr), nil
}
