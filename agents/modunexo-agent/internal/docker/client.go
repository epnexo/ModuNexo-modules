package docker

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"time"
)

type Summary struct {
	Total      int
	Running    int
	Stopped    int
	Healthy    int
	Unhealthy  int
	Coolify    int
	Dokploy    int
	PlainDocker int
}

type container struct {
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

func Inspect(ctx context.Context) (Summary, error) {
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return dialer.DialContext(ctx, "unix", "/var/run/docker.sock") }}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/json?all=1", nil)
	if err != nil { return Summary{}, err }
	response, err := client.Do(req)
	if err != nil { return Summary{}, err }
	defer response.Body.Close()
	var containers []container
	if err := json.NewDecoder(response.Body).Decode(&containers); err != nil { return Summary{}, err }
	summary := Summary{Total: len(containers)}
	for _, current := range containers {
		if current.State == "running" { summary.Running++ } else { summary.Stopped++ }
		if strings.Contains(current.Status, "(healthy)") { summary.Healthy++ }
		if strings.Contains(current.Status, "(unhealthy)") { summary.Unhealthy++ }
		platform := ""
		for key := range current.Labels { if strings.HasPrefix(key, "coolify.") { platform = "coolify" }; if strings.HasPrefix(key, "dokploy.") { platform = "dokploy" } }
		switch platform { case "coolify": summary.Coolify++; case "dokploy": summary.Dokploy++; default: summary.PlainDocker++ }
	}
	return summary, nil
}
