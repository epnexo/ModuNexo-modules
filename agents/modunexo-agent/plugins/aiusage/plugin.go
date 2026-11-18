package aiusage

import "context"

type Plugin struct{ CollectUsage func(context.Context) (map[string]uint64, error) }
func (Plugin) Name() string { return "ai-usage" }
func (p Plugin) Collect(ctx context.Context) (any, error) { return p.CollectUsage(ctx) }
