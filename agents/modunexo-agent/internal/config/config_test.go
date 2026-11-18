package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	ca := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(token, []byte("service-token\n"), 0600); err != nil { t.Fatal(err) }
	if err := os.WriteFile(ca, []byte("certificate"), 0600); err != nil { t.Fatal(err) }
	path := filepath.Join(dir, "agent.json")
	if err := os.WriteFile(path, []byte(`{"hostName":"pi-01","platformURL":"https://platform.example.test","tokenFile":"`+token+`","caFile":"`+ca+`","heartbeatInterval":"1m"}`), 0600); err != nil { t.Fatal(err) }
	config, err := Load(path)
	if err != nil { t.Fatal(err) }
	if config.Token != "service-token" || config.HeartbeatInterval.String() != "1m0s" { t.Fatalf("unexpected config: %#v", config) }
}
