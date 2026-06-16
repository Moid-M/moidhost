package server

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"moidhost/internal/config"
	"moidhost/internal/process"
)

// absDataDir resolves cfg.DataDir to an absolute path.
// This is defense-in-depth: config.go::Load() already resolves relative
// DataDir to absolute, but if config.json was saved with a stale relative
// path by an older build, this ensures the path is absolute at use-time.
func absDataDir(cfg *config.Config) error {
	if filepath.IsAbs(cfg.DataDir) {
		return nil
	}
	abs, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return fmt.Errorf("cannot resolve data directory %q: %w", cfg.DataDir, err)
	}
	cfg.DataDir = abs
	return nil
}

type Status string

const (
	StatusStopped  Status = "stopped"
	StatusStarting Status = "starting"
	StatusRunning  Status = "running"
	StatusStopping Status = "stopping"
	StatusCrashed  Status = "crashed"
)

type Instance struct {
	Config  config.ServerConfig
	Status  Status
	Process *process.ServerProcess
}

type Manager struct {
	mu        sync.RWMutex
	store     *config.Store
	cfg       *config.Config
	instances map[string]*Instance
}

func NewManager(store *config.Store) (*Manager, error) {
	cfg, err := store.Load()
	if err != nil {
		return nil, err
	}
	if err := absDataDir(cfg); err != nil {
		return nil, err
	}
	m := &Manager{
		store:     store,
		cfg:       cfg,
		instances: make(map[string]*Instance),
	}
	for i := range cfg.Servers {
		s := &cfg.Servers[i]
		m.instances[s.ID] = &Instance{
			Config: *s,
			Status: StatusStopped,
		}
	}
	for i := range cfg.Servers {
		if cfg.Servers[i].AutoStart {
			id := cfg.Servers[i].ID
			go func() { m.Start(id) }()
		}
	}
	return m, nil
}

func (m *Manager) List() []*Instance {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Instance, 0, len(m.instances))
	for _, inst := range m.instances {
		out = append(out, inst)
	}
	return out
}

func (m *Manager) Get(id string) *Instance {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.instances[id]
}

func (m *Manager) Create(sc config.ServerConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.instances[sc.ID]; ok {
		return fmt.Errorf("server %s already exists", sc.ID)
	}

	if err := absDataDir(m.cfg); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[moidhost] Create: DataDir=%q ID=%q serverDir=%q\n",
		m.cfg.DataDir, sc.ID, filepath.Join(m.cfg.DataDir, sc.ID))

	if err := os.MkdirAll(m.cfg.DataDir, 0755); err != nil {
		return fmt.Errorf("cannot create servers directory: %w", err)
	}
	serverDir := filepath.Join(m.cfg.DataDir, sc.ID)
	if err := os.MkdirAll(serverDir, 0755); err != nil {
		return err
	}
	for _, dir := range []string{"plugins", "world"} {
		if err := os.MkdirAll(filepath.Join(serverDir, dir), 0755); err != nil {
			return err
		}
	}
	sc.Path = serverDir

	inst := &Instance{
		Config: sc,
		Status: StatusStopped,
	}
	m.instances[sc.ID] = inst

	m.cfg.Servers = append(m.cfg.Servers, sc)
	return m.store.Save(m.cfg)
}

func (m *Manager) Update(id string, sc config.ServerConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	inst, ok := m.instances[id]
	if !ok {
		return fmt.Errorf("server %s not found", id)
	}
	if inst.Status == StatusRunning || inst.Status == StatusStarting {
		return fmt.Errorf("cannot update running server")
	}

	// Preserve existing values for empty/zero fields
	old := inst.Config
	if sc.Name != "" {
		old.Name = sc.Name
	}
	if sc.JarFile != "" {
		old.JarFile = sc.JarFile
	}
	if sc.JavaArgs != "" {
		old.JavaArgs = sc.JavaArgs
	}
	if sc.JavaPath != "" {
		old.JavaPath = sc.JavaPath
	}
	if sc.Port != 0 {
		old.Port = sc.Port
	}
	old.AutoStart = sc.AutoStart
	sc = old
	sc.Path = inst.Config.Path
	inst.Config = sc

	for i := range m.cfg.Servers {
		if m.cfg.Servers[i].ID == id {
			m.cfg.Servers[i] = sc
			break
		}
	}
	return m.store.Save(m.cfg)
}

func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	inst, ok := m.instances[id]
	if !ok {
		return fmt.Errorf("server %s not found", id)
	}
	if inst.Status == StatusRunning || inst.Status == StatusStarting {
		return fmt.Errorf("cannot delete running server")
	}

	delete(m.instances, id)
	for i := range m.cfg.Servers {
		if m.cfg.Servers[i].ID == id {
			m.cfg.Servers = append(m.cfg.Servers[:i], m.cfg.Servers[i+1:]...)
			break
		}
	}
	return nil
}

func splitArgs(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Fields(s)
}

func (m *Manager) Start(id string) error {
	m.mu.Lock()
	inst, ok := m.instances[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("server %s not found", id)
	}
	if inst.Status == StatusRunning || inst.Status == StatusStarting {
		m.mu.Unlock()
		return fmt.Errorf("server %s is already running", id)
	}

	// Check Java is available
	javaBin := inst.Config.JavaPath
	if javaBin == "" {
		javaBin = "java"
	}
	if _, err := exec.LookPath(javaBin); err != nil {
		m.mu.Unlock()
		return fmt.Errorf("java not found at %q. Set a custom path in server settings or install Java (e.g. openjdk-21-jre-headless)", javaBin)
	}

	// Check jar file exists
	jarPath := filepath.Join(inst.Config.Path, inst.Config.JarFile)
	if _, err := os.Stat(jarPath); os.IsNotExist(err) {
		m.mu.Unlock()
		return fmt.Errorf("server jar not found: %s — upload it via the Files tab first", inst.Config.JarFile)
	}

	inst.Status = StatusStarting
	proc := process.NewServerProcess()
	inst.Process = proc
	m.mu.Unlock()

	javaArgs := []string{}
	if inst.Config.JavaArgs != "" {
		javaArgs = append(javaArgs, splitArgs(inst.Config.JavaArgs)...)
	}
	javaArgs = append(javaArgs, inst.Config.JarFile, "nogui")

	if inst.Config.CPUCores > 0 {
		cpuList := fmt.Sprintf("0-%d", inst.Config.CPUCores-1)
		javaArgs = append([]string{"-c", cpuList, javaBin}, javaArgs...)
		javaBin = "taskset"
	}

	if err := proc.Start(javaBin, javaArgs, inst.Config.Path); err != nil {
		m.mu.Lock()
		inst.Status = StatusCrashed
		m.mu.Unlock()
		return err
	}

	// Wait briefly to catch immediate crashes (bad jar, Java error, etc.)
	time.Sleep(500 * time.Millisecond)
	if !proc.Running() {
		m.mu.Lock()
		inst.Status = StatusCrashed
		inst.Process = nil
		m.mu.Unlock()
		return fmt.Errorf("server process exited immediately — check the console logs for details")
	}

	m.mu.Lock()
	inst.Status = StatusRunning
	m.mu.Unlock()

	go func() {
		<-proc.Done()
		m.mu.Lock()
		inst.Status = StatusStopped
		inst.Process = nil
		m.mu.Unlock()
	}()
	return nil
}

func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	inst, ok := m.instances[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("server %s not found", id)
	}
	if inst.Status != StatusRunning {
		m.mu.Unlock()
		return nil
	}

	inst.Status = StatusStopping
	proc := inst.Process
	m.mu.Unlock()

	if proc != nil {
		proc.SendCommand("say Server shutting down...")
		proc.Stop(30 * time.Second)
	}
	return nil
}

func (m *Manager) Kill(id string) error {
	m.mu.Lock()
	inst, ok := m.instances[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("server %s not found", id)
	}
	if inst.Status != StatusRunning {
		m.mu.Unlock()
		return nil
	}

	inst.Status = StatusStopping
	proc := inst.Process
	m.mu.Unlock()

	if proc != nil {
		proc.Stop(5 * time.Second)
	}
	return nil
}

func (m *Manager) Restart(id string) error {
	if err := m.Stop(id); err != nil {
		return err
	}
	return m.Start(id)
}

func (m *Manager) SendCommand(id, cmd string) error {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("server %s not found", id)
	}
	if inst.Process == nil {
		return fmt.Errorf("server %s is not running", id)
	}
	return inst.Process.SendCommand(cmd)
}

func (m *Manager) Subscribe(id string) (chan string, error) {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("server %s not found", id)
	}
	if inst.Process == nil {
		return nil, fmt.Errorf("server %s is not running", id)
	}
	return inst.Process.Subscribe(), nil
}

func (m *Manager) Unsubscribe(id string, ch chan string) {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()
	if !ok || inst.Process == nil {
		return
	}
	inst.Process.Unsubscribe(ch)
}

func (m *Manager) GetProcessPid(id string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	inst, ok := m.instances[id]
	if !ok || inst.Process == nil {
		return 0
	}
	return inst.Process.Pid()
}

func (m *Manager) GetLogs(id string) ([]string, error) {
	m.mu.RLock()
	inst, ok := m.instances[id]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("server %s not found", id)
	}
	if inst.Process == nil {
		return nil, nil
	}
	return inst.Process.Lines(), nil
}
