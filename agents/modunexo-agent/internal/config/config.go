package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

type file struct {
	HostName          string `json:"hostName"`
	PlatformURL       string `json:"platformURL"`
	TokenFile         string `json:"tokenFile"`
	CAFile            string `json:"caFile"`
	HeartbeatInterval string `json:"heartbeatInterval"`
}

type Config struct {
	HostName          string
	PlatformURL       string
	Token             string
	CA                []byte
	HeartbeatInterval time.Duration
}

func Load(path string) (Config, error) {
	contents, err := os.ReadFile(path)
	if err != nil { return Config{}, fmt.Errorf("read configuration: %w", err) }
	var input file
	if err := json.Unmarshal(contents, &input); err != nil { return Config{}, fmt.Errorf("parse configuration: %w", err) }
	endpoint, err := url.Parse(input.PlatformURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" { return Config{}, fmt.Errorf("platformURL must be HTTPS") }
	if strings.TrimSpace(input.HostName) == "" { return Config{}, fmt.Errorf("hostName is required") }
	token, err := os.ReadFile(input.TokenFile)
	if err != nil { return Config{}, fmt.Errorf("read token file: %w", err) }
	if strings.TrimSpace(string(token)) == "" { return Config{}, fmt.Errorf("token file is empty") }
	ca, err := os.ReadFile(input.CAFile)
	if err != nil || len(ca) == 0 { return Config{}, fmt.Errorf("read CA file") }
	interval, err := time.ParseDuration(input.HeartbeatInterval)
	if err != nil || interval <= 0 { return Config{}, fmt.Errorf("heartbeatInterval must be positive") }
	return Config{HostName: strings.TrimSpace(input.HostName), PlatformURL: input.PlatformURL, Token: strings.TrimSpace(string(token)), CA: ca, HeartbeatInterval: interval}, nil
}
