package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/modunexo/modunexo-agent/internal/agent"
	"github.com/modunexo/modunexo-agent/internal/config"
	"github.com/modunexo/modunexo-agent/internal/docker"
	"github.com/modunexo/modunexo-agent/internal/journal"
	"github.com/modunexo/modunexo-agent/internal/setup"
	observability "github.com/modunexo/modunexo-agent/plugins/observability"
)

const version = "0.1.4"

func main() {
	showVersion := flag.Bool("version", false, "print the agent version")
	showStatus := flag.Bool("status", false, "show the safe local status view")
	configPath := flag.String("config", "", "path to the agent configuration")
	setupMode := flag.Bool("setup", false, "create the agent configuration interactively")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	if *setupMode {
		path := *configPath
		if path == "" { path = "/etc/modunexo-agent/config.json" }
		if err := setup.Run(os.Stdin, os.Stdout, path); err != nil { fmt.Fprintln(os.Stderr, "setup could not validate the files"); os.Exit(2) }
		return
	}
	if *configPath == "" {
		if *showStatus {
			*configPath = "/etc/modunexo-agent/config.json"
		} else {
		fmt.Fprintln(os.Stderr, "modunexo-agent requires --config; use --version to verify the binary")
		os.Exit(2)
		}
	}
	loaded, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid agent configuration")
		os.Exit(2)
	}
	if *showStatus {
		metrics, metricsErr := observability.LinuxMetrics(context.Background())
		dockerSummary, dockerErr := docker.Inspect(context.Background())
		fmt.Printf("ModuNexo agent %s\nHost: %s\nPlatform: %s\nInterval: %s\n", version, loaded.HostName, loaded.PlatformURL, loaded.HeartbeatInterval)
		if metricsErr != nil { fmt.Println("System metrics: unavailable") } else { fmt.Printf("System metrics: %d values ready\n", len(metrics)) }
		if dockerErr != nil { fmt.Println("Docker: unavailable") } else { fmt.Printf("Docker: %d total · %d running · %d stopped · %d healthy · %d unhealthy\n", dockerSummary.Total, dockerSummary.Running, dockerSummary.Stopped, dockerSummary.Healthy, dockerSummary.Unhealthy); if dockerSummary.Coolify > 0 { fmt.Printf("Platform: Coolify (%d containers)\n", dockerSummary.Coolify) } else if dockerSummary.Dokploy > 0 { fmt.Printf("Platform: Dokploy (%d containers)\n", dockerSummary.Dokploy) } else { fmt.Println("Platform: no Coolify or Dokploy labels detected") } }
		return
	}
	sender, err := agent.NewHTTPSender(loaded.PlatformURL, loaded.Token, loaded.CA)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid agent transport configuration")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	beat := func() error { return sender.SendHeartbeat(ctx, map[string]any{"hostName": loaded.HostName, "version": version, "capabilities": []string{"cpuTemperatureC", "load1", "load5", "load15", "cpuCores", "memoryTotalKiB", "memoryAvailableKiB", "swapTotalKiB", "swapFreeKiB", "rootDiskTotalBytes", "rootDiskFreeBytes", "rootDiskUsedBytes", "uptimeSeconds", "processCount", "thermalZoneCount", "dockerContainersTotal", "dockerContainersRunning", "dockerContainersStopped", "dockerContainersHealthy", "dockerContainersUnhealthy", "coolifyContainers", "dokployContainers", "plainDockerContainers"}, "payloadShape": map[string]string{"cpuTemperatureC": "number", "load1": "number", "load5": "number", "load15": "number", "cpuCores": "number", "memoryTotalKiB": "number", "memoryAvailableKiB": "number", "swapTotalKiB": "number", "swapFreeKiB": "number", "rootDiskTotalBytes": "number", "rootDiskFreeBytes": "number", "rootDiskUsedBytes": "number", "uptimeSeconds": "number", "processCount": "number", "thermalZoneCount": "number", "dockerContainersTotal": "number", "dockerContainersRunning": "number", "dockerContainersStopped": "number", "dockerContainersHealthy": "number", "dockerContainersUnhealthy": "number", "coolifyContainers": "number", "dokployContainers": "number", "plainDockerContainers": "number"}}) }
	collect := func() { metrics, err := observability.LinuxMetrics(ctx); if err != nil { fmt.Fprintln(os.Stderr, "metric collection failed"); return }; if summary, err := docker.Inspect(ctx); err == nil { metrics["dockerContainersTotal"] = float64(summary.Total); metrics["dockerContainersRunning"] = float64(summary.Running); metrics["dockerContainersStopped"] = float64(summary.Stopped); metrics["dockerContainersHealthy"] = float64(summary.Healthy); metrics["dockerContainersUnhealthy"] = float64(summary.Unhealthy); metrics["coolifyContainers"] = float64(summary.Coolify); metrics["dokployContainers"] = float64(summary.Dokploy); metrics["plainDockerContainers"] = float64(summary.PlainDocker) }; if err := sender.Send(ctx, "observability", map[string]any{"hostName": loaded.HostName, "collectedAt": time.Now().UTC().Format(time.RFC3339), "metrics": metrics}); err != nil { fmt.Fprintln(os.Stderr, "metric delivery failed") }; if events, err := journal.Recent(ctx); err == nil && len(events) > 0 { if err := sender.SendEvents(ctx, map[string]any{"hostName": loaded.HostName, "events": events}); err != nil { fmt.Fprintln(os.Stderr, "event delivery failed") } } }
	if err := beat(); err != nil { fmt.Fprintln(os.Stderr, "initial heartbeat failed"); os.Exit(1) }
	collect()
	ticker := time.NewTicker(loaded.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done(): return
		case <-ticker.C:
			if err := beat(); err != nil { fmt.Fprintln(os.Stderr, "heartbeat failed") }
			collect()
		}
	}
}
