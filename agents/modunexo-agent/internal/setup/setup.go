package setup

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

type config struct {
	HostName string `json:"hostName"`
	PlatformURL string `json:"platformURL"`
	TokenFile string `json:"tokenFile"`
	CAFile string `json:"caFile"`
	HeartbeatInterval string `json:"heartbeatInterval"`
}

func Run(in io.Reader, out io.Writer, path string) error {
	reader := bufio.NewReader(in)
	ask := func(label, fallback string) (string, error) { fmt.Fprintf(out, "%s [%s]: ", label, fallback); value, err := reader.ReadString('\n'); if err != nil && value == "" { return "", err }; value = strings.TrimSpace(value); if value == "" { value = fallback }; return value, nil }
	host, err := ask("Host name", "pi-01"); if err != nil { return err }
	url, err := ask("ModuNexo HTTPS URL", "https://modunexo.example.com"); if err != nil { return err }
	tokenFile, err := ask("Token file", "/etc/modunexo-agent/token"); if err != nil { return err }
	caFile, err := ask("CA file", "/etc/modunexo-agent/ca.pem"); if err != nil { return err }
	interval, err := ask("Heartbeat interval", "1m"); if err != nil { return err }
	if _, err := os.ReadFile(tokenFile); err != nil { return fmt.Errorf("token file is not readable") }
	if _, err := os.ReadFile(caFile); err != nil { return fmt.Errorf("CA file is not readable") }
	encoded, err := json.MarshalIndent(config{host, url, tokenFile, caFile, interval}, "", "  "); if err != nil { return err }
	if err := os.WriteFile(path, append(encoded, '\n'), 0640); err != nil { return err }
	fmt.Fprintln(out, "Configuration saved. Start modunexo-agent after confirming file ownership.")
	return nil
}
