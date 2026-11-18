package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type HTTPSender struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewHTTPSender(baseURL, token string, internalCA []byte) (*HTTPSender, error) {
	endpoint, err := url.Parse(baseURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" { return nil, fmt.Errorf("platform URL must be HTTPS") }
	if strings.TrimSpace(token) == "" { return nil, fmt.Errorf("service token is required") }
	roots, err := x509.SystemCertPool(); if err != nil { roots = x509.NewCertPool() }
	if len(internalCA) > 0 && !roots.AppendCertsFromPEM(internalCA) { return nil, fmt.Errorf("internal CA is invalid") }
	return &HTTPSender{baseURL: strings.TrimRight(baseURL, "/"), token: token, client: &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}}}, nil
}

func (s *HTTPSender) Send(ctx context.Context, plugin string, payload any) error {
	return s.post(ctx, "/svc/"+plugin+"/ingest", payload)
}

func (s *HTTPSender) SendHeartbeat(ctx context.Context, payload any) error {
	return s.post(ctx, "/svc/observability/heartbeat", payload)
}

func (s *HTTPSender) SendEvents(ctx context.Context, payload any) error {
	return s.post(ctx, "/svc/observability/events", payload)
}

func (s *HTTPSender) post(ctx context.Context, path string, payload any) error {
	body, err := json.Marshal(payload); if err != nil { return fmt.Errorf("encode payload: %w", err) }
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+path, bytes.NewReader(body)); if err != nil { return err }
	req.Header.Set("Authorization", "Bearer "+s.token); req.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(req); if err != nil { return err }
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 { return fmt.Errorf("platform returned %s", response.Status) }
	return nil
}
