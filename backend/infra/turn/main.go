// Parvane TURN-сервер (обход NAT для звонков). Аналог coturn на userspace (pion),
// чтобы поднимать без root. Клиент указывает адрес через PARVANE_TURN=
// turn:host:port + PARVANE_TURN_USER/PARVANE_TURN_PASS. Также раздаёт STUN.
//
// Конфиг через окружение:
//
//	TURN_PUBLIC_IP  — внешний IP сервера (в relay-кандидатах). По умолч. 127.0.0.1
//	TURN_PORT       — UDP-порт (по умолч. 3478)
//	TURN_TCP_PORT   — дополнительно слушать TURN по TCP (мобильные VPN/сети,
//	                  режущие UDP); пусто — только UDP
//	TURN_MIN_PORT/TURN_MAX_PORT — диапазон relay-портов (для проброса через NAT);
//	                  без них relay берёт случайные эфемерные порты
//	TURN_RELAY_PORT_OFFSET — сдвиг между портом, на который relay БИНДИТСЯ, и
//	                  портом, который сообщается клиенту (XOR-RELAYED-ADDRESS).
//	                  Для NAT хостера с range-DNAT «внешний 20160..20200 →
//	                  внутренний 49160..49200» биндимся на 49160+k, а клиенту
//	                  отдаём 20160+k: OFFSET=-29000. 0/пусто — без сдвига.
//	TURN_REALM      — realm (по умолч. parvane)
//	TURN_USER/TURN_PASS — статические креды (по умолч. parvane/parvane)
//	TURN_SECRET     — включает краткоживущие креды (TURN REST): username
//	                  "<expiry>:<user>", password = base64(HMAC-SHA1(secret, username)).
//	                  Выдаёт их call-шард по call.ice.request. Статический
//	                  пользователь продолжает работать параллельно.
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

// P-16: relay только на публичные адреса. Без фильтра любой авторизованный
// пользователь через TURN слал бы UDP/TCP на 127.0.0.1, 10.x, 169.254.169.254
// (метаданные облака) и другие внутренние адреса VPS.
func peerAllowed(peer net.IP) bool {
	if peer == nil || peer.IsUnspecified() || peer.IsLoopback() || peer.IsMulticast() ||
		peer.IsLinkLocalUnicast() || peer.IsLinkLocalMulticast() || peer.IsInterfaceLocalMulticast() ||
		peer.IsPrivate() {
		return false
	}
	if v4 := peer.To4(); v4 != nil {
		switch {
		case v4[0] == 0: // 0.0.0.0/8
			return false
		case v4[0] == 100 && v4[1]&0xc0 == 64: // CGNAT 100.64.0.0/10
			return false
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 0: // 192.0.0.0/24
			return false
		case v4[0] == 198 && v4[1]&0xfe == 18: // benchmarking 198.18.0.0/15
			return false
		case v4[0] >= 224: // multicast + reserved + broadcast
			return false
		}
		return true
	}
	// IPv6: ULA fc00::/7 покрыт IsPrivate; 6to4/Teredo/NAT64 несут v4 внутри
	switch {
	case peer[0] == 0x20 && peer[1] == 0x02: // 6to4 2002::/16
		return peerAllowed(net.IPv4(peer[2], peer[3], peer[4], peer[5]))
	case peer[0] == 0x20 && peer[1] == 0x01 && peer[2] == 0 && peer[3] == 0: // Teredo 2001::/32
		return peerAllowed(net.IPv4(peer[12]^0xff, peer[13]^0xff, peer[14]^0xff, peer[15]^0xff))
	case peer[0] == 0 && peer[1] == 0x64 && peer[2] == 0xff && peer[3] == 0x9b: // NAT64 64:ff9b::/96
		return peerAllowed(net.IPv4(peer[12], peer[13], peer[14], peer[15]))
	case peer[0] == 0xfe && peer[1]&0xc0 == 0xc0: // site-local fec0::/10 (deprecated)
		return false
	case peer[0] == 0x20 && peer[1] == 0x01 && peer[2] == 0x0d && peer[3] == 0xb8: // documentation
		return false
	}
	return true
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

	// P-16: запрет relay на внутренние адреса (peer-фильтр) — на каждом слушателе
	permissionHandler := func(clientAddr net.Addr, peerIP net.IP) bool {
		if !peerAllowed(peerIP) {
			log.Printf("TURN permission отказ: peer=%s client=%s", peerIP, clientAddr)
			return false
		}
		return true
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
			PermissionHandler:     permissionHandler,
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
			PermissionHandler:     permissionHandler,
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
