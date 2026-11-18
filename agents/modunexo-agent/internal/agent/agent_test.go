package agent

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

type plugin struct{ name string; payload any; err error }
func (p plugin) Name() string { return p.name }
func (p plugin) Collect(context.Context) (any, error) { return p.payload, p.err }
type sender struct{ names []string; err error }
func (s *sender) Send(_ context.Context, name string, _ any) error { s.names = append(s.names, name); return s.err }

func TestRun(t *testing.T) {
	t.Run("sends module payloads separately", func(t *testing.T) {
		s := &sender{}
		if err := Run(context.Background(), s, plugin{name: "observability", payload: map[string]string{"temperature": "42"}}, plugin{name: "ai-usage", payload: map[string]string{"tool": "codex"}}); err != nil { t.Fatal(err) }
		if want := []string{"observability", "ai-usage"}; !reflect.DeepEqual(s.names, want) { t.Fatalf("sent %v, want %v", s.names, want) }
	})
	t.Run("stops before sending a failed collection", func(t *testing.T) {
		s := &sender{}
		err := Run(context.Background(), s, plugin{name: "observability", err: errors.New("unavailable")})
		if err == nil || len(s.names) != 0 { t.Fatalf("err %v, sends %v", err, s.names) }
	})
}
