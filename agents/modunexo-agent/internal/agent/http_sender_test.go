package agent

import "testing"

func TestNewHTTPSender(t *testing.T) {
	for _, tc := range []struct{ name, url, token string; wantErr bool }{{"accepts HTTPS", "https://platform.example.test", "token", false}, {"rejects HTTP", "http://platform.example.test", "token", true}, {"requires token", "https://platform.example.test", "", true}} {
		t.Run(tc.name, func(t *testing.T) { _, err := NewHTTPSender(tc.url, tc.token, nil); if (err != nil) != tc.wantErr { t.Fatalf("error %v", err) } })
	}
}
