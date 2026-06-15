package system

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
