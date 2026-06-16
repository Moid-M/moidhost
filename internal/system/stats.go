package system

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Stats struct {
	CPU struct {
		Percent float64 `json:"percent"`
	} `json:"cpu"`
	Memory struct {
		Total uint64 `json:"total_bytes"`
		Used  uint64 `json:"used_bytes"`
		Pct   float64 `json:"percent"`
	} `json:"memory"`
	Disk struct {
		Total uint64 `json:"total_bytes"`
		Used  uint64 `json:"used_bytes"`
		Pct   float64 `json:"percent"`
		Path  string `json:"path"`
	} `json:"disk"`
}

func GetStats(dataDir string) (*Stats, error) {
	var s Stats

	mem, err := getMemory()
	if err != nil {
		return nil, err
	}
	s.Memory = *mem

	cpu, err := getCPU()
	if err != nil {
		return nil, err
	}
	s.CPU = *cpu

	disk, err := getDisk(dataDir)
	if err != nil {
		return nil, err
	}
	s.Disk = *disk

	return &s, nil
}

func getMemory() (*struct {
	Total uint64 `json:"total_bytes"`
	Used  uint64 `json:"used_bytes"`
	Pct   float64 `json:"percent"`
}, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var total, avail uint64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			total = parseKB(line)
		case strings.HasPrefix(line, "MemAvailable:"):
			avail = parseKB(line)
		}
	}
	if total == 0 {
		return nil, fmt.Errorf("could not parse /proc/meminfo")
	}
	used := total - avail
	pct := math.Round(float64(used)*100/float64(total)*10) / 10
	return &struct {
		Total uint64  `json:"total_bytes"`
		Used  uint64  `json:"used_bytes"`
		Pct   float64 `json:"percent"`
	}{Total: total * 1024, Used: used * 1024, Pct: pct}, nil
}

func getCPU() (*struct {
	Percent float64 `json:"percent"`
}, error) {
	prev, err := readCPU()
	if err != nil {
		return nil, err
	}
	time.Sleep(500 * time.Millisecond)
	cur, err := readCPU()
	if err != nil {
		return nil, err
	}

	prevTotal := prev.idle + prev.iowait + prev.user + prev.system + prev.nice + prev.irq + prev.softirq + prev.steal
	curTotal := cur.idle + cur.iowait + cur.user + cur.system + cur.nice + cur.irq + cur.softirq + cur.steal
	totalDelta := curTotal - prevTotal
	idleDelta := (cur.idle + cur.iowait) - (prev.idle + prev.iowait)

	var pct float64
	if totalDelta > 0 {
		pct = math.Round(float64(totalDelta-idleDelta)*100/float64(totalDelta)*10) / 10
	}
	return &struct {
		Percent float64 `json:"percent"`
	}{Percent: pct}, nil
}

type cpuTimes struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

func readCPU() (*cpuTimes, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return nil, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 8 {
			continue
		}
		var c cpuTimes
		c.user, _ = strconv.ParseUint(fields[1], 10, 64)
		c.nice, _ = strconv.ParseUint(fields[2], 10, 64)
		c.system, _ = strconv.ParseUint(fields[3], 10, 64)
		c.idle, _ = strconv.ParseUint(fields[4], 10, 64)
		c.iowait, _ = strconv.ParseUint(fields[5], 10, 64)
		c.irq, _ = strconv.ParseUint(fields[6], 10, 64)
		c.softirq, _ = strconv.ParseUint(fields[7], 10, 64)
		if len(fields) > 8 {
			c.steal, _ = strconv.ParseUint(fields[8], 10, 64)
		}
		return &c, nil
	}
	return nil, fmt.Errorf("could not parse /proc/stat")
}

func getDisk(path string) (*struct {
	Total uint64 `json:"total_bytes"`
	Used  uint64 `json:"used_bytes"`
	Pct   float64 `json:"percent"`
	Path  string `json:"path"`
}, error) {
	abs, _ := filepath.Abs(path)
	var stat syscall.Statfs_t
	if err := syscall.Statfs(abs, &stat); err != nil {
		return nil, err
	}
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	used := total - free
	pct := math.Round(float64(used)*100/float64(total)*10) / 10
	return &struct {
		Total uint64  `json:"total_bytes"`
		Used  uint64  `json:"used_bytes"`
		Pct   float64 `json:"percent"`
		Path  string  `json:"path"`
	}{Total: total, Used: used, Pct: pct, Path: abs}, nil
}

func parseKB(line string) uint64 {
	fields := strings.Fields(line)
	if len(fields) >= 2 {
		v, err := strconv.ParseUint(fields[1], 10, 64)
		if err == nil {
			return v
		}
	}
	return 0
}

type ProcessStats struct {
	CPUPercent float64 `json:"cpu_percent"`
	MemoryRSS  uint64  `json:"memory_rss_bytes"`
}

// GetProcessStats reads /proc/<pid>/stat and /proc/<pid>/status
// to return per-process CPU% (delta-based via internal cache) and RSS.
func GetProcessStats(pid int) (*ProcessStats, error) {
	utime, stime, err := readProcessJiffies(pid)
	if err != nil {
		return nil, err
	}

	rss, err := readProcessRSS(pid)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	total := utime + stime

	cpuPct := getProcessDelta(pid, total, now)

	return &ProcessStats{
		CPUPercent: cpuPct,
		MemoryRSS:  rss,
	}, nil
}

// readProcessJiffies reads utime (field 14) and stime (field 15) from /proc/<pid>/stat.
func readProcessJiffies(pid int) (uint64, uint64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, fmt.Errorf("cannot read /proc/%d/stat: %w", pid, err)
	}
	// /proc/<pid>/stat is space-separated; values are after the closing paren of comm.
	// Comm can contain spaces and parens, so we skip past the last ')' .
	content := string(data)
	idx := strings.LastIndex(content, ") ")
	if idx < 0 {
		return 0, 0, fmt.Errorf("malformed /proc/%d/stat", pid)
	}
	fields := strings.Fields(content[idx+2:])
	if len(fields) < 15 {
		return 0, 0, fmt.Errorf("too few fields in /proc/%d/stat", pid)
	}
	utime, _ := strconv.ParseUint(fields[11], 10, 64)
	stime, _ := strconv.ParseUint(fields[12], 10, 64)
	return utime, stime, nil
}

// readProcessRSS reads VmRSS from /proc/<pid>/status (in bytes).
func readProcessRSS(pid int) (uint64, error) {
	f, err := os.Open(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, fmt.Errorf("cannot read /proc/%d/status: %w", pid, err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, err := strconv.ParseUint(fields[1], 10, 64)
				if err == nil {
					return kb * 1024, nil
				}
			}
		}
	}
	return 0, nil // process may have exited
}

var (
	deltaMu    sync.Mutex
	prevJiffies = make(map[int]processSample)
)

type processSample struct {
	total uint64
	time  time.Time
}

func getProcessDelta(pid int, total uint64, now time.Time) float64 {
	deltaMu.Lock()
	defer deltaMu.Unlock()

	prev, hasPrev := prevJiffies[pid]
	prevJiffies[pid] = processSample{total: total, time: now}

	if !hasPrev || prev.time.IsZero() {
		return 0
	}
	dt := now.Sub(prev.time).Seconds()
	if dt <= 0 {
		return 0
	}
	dj := float64(total - prev.total)
	// CLK_TCK is typically 100 on Linux
	cpuPct := dj / (100.0 * dt) * 100.0
	if cpuPct < 0 {
		cpuPct = 0
	}
	pct := math.Round(cpuPct*10) / 10
	if pct > 100 {
		pct = 100
	}
	return pct
}

// GetDirSize recursively walks dir and sums all file sizes.
func GetDirSize(path string) (uint64, error) {
	var size uint64
	err := filepath.Walk(path, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return filepath.SkipDir
		}
		if !fi.IsDir() {
			size += uint64(fi.Size())
		}
		return nil
	})
	return size, err
}
