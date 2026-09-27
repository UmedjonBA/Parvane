package main

import (
	"net"
	"testing"
)

// P-16: relay через TURN только на публичные адреса
func TestPeerAllowed(t *testing.T) {
	denied := []string{
		"127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.5.5", "192.168.0.1", "169.254.169.254",
		"100.64.0.1", "192.0.0.9", "198.18.0.1", "224.0.0.1", "255.255.255.255",
		"::1", "::", "fe80::1", "fd00::1", "ff02::1",
		"2002:0a00:0001::1",        // 6to4 → 10.0.0.1
		"2001:0:0:0:0:0:f5ff:fffe", // Teredo → 10.0.0.1 (инвертированный)
		"64:ff9b::a00:1",           // NAT64 → 10.0.0.1
		"::ffff:192.168.1.1",       // v4-mapped
	}
	for _, s := range denied {
		if peerAllowed(net.ParseIP(s)) {
			t.Errorf("%s должен быть запрещён", s)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2002:0808:0808::1", "64:ff9b::808:808"}
	for _, s := range allowed {
		if !peerAllowed(net.ParseIP(s)) {
			t.Errorf("%s должен быть разрешён", s)
		}
	}
	if peerAllowed(nil) {
		t.Errorf("nil запрещён")
	}
}
