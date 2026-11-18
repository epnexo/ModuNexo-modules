package observability

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Plugin struct{ CollectMetrics func(context.Context) (map[string]float64, error) }
func (Plugin) Name() string { return "observability" }
func (p Plugin) Collect(ctx context.Context) (any, error) { return p.CollectMetrics(ctx) }

func LinuxMetrics(context.Context) (map[string]float64, error) {
	metrics := map[string]float64{}
	if raw, err := os.ReadFile("/sys/class/thermal/thermal_zone0/temp"); err == nil {
		if value, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64); err == nil { metrics["cpuTemperatureC"] = value / 1000 }
	}
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		if fields := strings.Fields(string(raw)); len(fields) >= 3 {
			for key, rawValue := range map[string]string{"load1": fields[0], "load5": fields[1], "load15": fields[2]} {
				if value, err := strconv.ParseFloat(rawValue, 64); err == nil {
					metrics[key] = value
				}
			}
		}
	}
	metrics["cpuCores"] = float64(runtime.NumCPU())
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") { fields := strings.Fields(line); if len(fields) < 2 { continue }; if fields[0] == "MemTotal:" || fields[0] == "MemAvailable:" || fields[0] == "SwapTotal:" || fields[0] == "SwapFree:" { if value, err := strconv.ParseFloat(fields[1], 64); err == nil { metrics[map[string]string{"MemTotal:": "memoryTotalKiB", "MemAvailable:": "memoryAvailableKiB", "SwapTotal:": "swapTotalKiB", "SwapFree:": "swapFreeKiB"}[fields[0]]] = value } } }
	}
	var filesystem syscall.Statfs_t
	if err := syscall.Statfs("/", &filesystem); err == nil && filesystem.Blocks > 0 {
		total := float64(filesystem.Blocks * uint64(filesystem.Bsize))
		free := float64(filesystem.Bavail * uint64(filesystem.Bsize))
		metrics["rootDiskTotalBytes"] = total
		metrics["rootDiskFreeBytes"] = free
		metrics["rootDiskUsedBytes"] = total - free
	}
	if raw, err := os.ReadFile("/proc/uptime"); err == nil { if fields := strings.Fields(string(raw)); len(fields) > 0 { if value, err := strconv.ParseFloat(fields[0], 64); err == nil { metrics["uptimeSeconds"] = value } } }
	if entries, err := os.ReadDir("/proc"); err == nil {
		count := 0
		for _, entry := range entries {
			if _, err := strconv.Atoi(entry.Name()); err == nil {
				count++
			}
		}
		metrics["processCount"] = float64(count)
	}
	if matches, err := filepath.Glob("/sys/class/thermal/thermal_zone*/temp"); err == nil {
		metrics["thermalZoneCount"] = float64(len(matches))
	}
	if len(metrics) == 0 { return nil, fmt.Errorf("no supported Linux metrics available") }
	metrics["collectedUnix"] = float64(time.Now().Unix())
	return metrics, nil
}
