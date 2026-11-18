package journal

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Event struct {
	ID         string    `json:"id"`
	OccurredAt time.Time `json:"occurredAt"`
	Level      string    `json:"level"`
	Unit       string    `json:"unit"`
	Message    string    `json:"message"`
}

type entry struct {
	Cursor    string `json:"__CURSOR"`
	Timestamp string `json:"__REALTIME_TIMESTAMP"`
	Priority  string `json:"PRIORITY"`
	Unit      string `json:"_SYSTEMD_UNIT"`
	Message   string `json:"MESSAGE"`
}

var secret = regexp.MustCompile(`(?i)(token|password|secret|authorization|api[_-]?key)\s*[=:]\s*[^\s,;]+`)

func Recent(ctx context.Context) ([]Event, error) {
	command := exec.CommandContext(ctx, "journalctl", "--priority=warning", "--since=-2m", "--output=json", "--no-pager")
	output, err := command.StdoutPipe()
	if err != nil { return nil, err }
	if err := command.Start(); err != nil { return nil, err }
	var events []Event
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 1024), 64*1024)
	for scanner.Scan() {
		var current entry
		if json.Unmarshal(scanner.Bytes(), &current) != nil || current.Cursor == "" || current.Message == "" { continue }
		micros, err := strconv.ParseInt(current.Timestamp, 10, 64)
		if err != nil { continue }
		sum := sha256.Sum256([]byte(current.Cursor))
		events = append(events, Event{ID: hex.EncodeToString(sum[:]), OccurredAt: time.Unix(0, micros*1000).UTC(), Level: level(current.Priority), Unit: trim(current.Unit, 120), Message: trim(secret.ReplaceAllString(current.Message, "$1=[redacted]"), 500)})
	}
	if err := scanner.Err(); err != nil { return nil, err }
	return events, command.Wait()
}

func level(priority string) string { if priority == "0" || priority == "1" || priority == "2" || priority == "3" { return "error" }; return "warning" }
func trim(value string, max int) string {
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:min(len(runes), max)]))
}
