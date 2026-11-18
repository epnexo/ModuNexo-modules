package agent

import (
	"context"
	"fmt"
)

// Plugin produces a module-owned payload. Plugins never share payload data.
type Plugin interface {
	Name() string
	Collect(context.Context) (any, error)
}

// Sender owns authenticated HTTPS transport to one scoped module route.
type Sender interface {
	Send(context.Context, string, any) error
}

// Run collects each plugin independently so one failing module does not block others.
func Run(ctx context.Context, sender Sender, plugins ...Plugin) error {
	for _, plugin := range plugins {
		payload, err := plugin.Collect(ctx)
		if err != nil {
			return fmt.Errorf("collect %s: %w", plugin.Name(), err)
		}
		if err := sender.Send(ctx, plugin.Name(), payload); err != nil {
			return fmt.Errorf("send %s: %w", plugin.Name(), err)
		}
	}
	return nil
}
