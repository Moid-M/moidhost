package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"moidhost/internal/config"
	"moidhost/internal/process"
)

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

	inst.Status = StatusStarting
	proc := process.NewServerProcess()
	inst.Process = proc
	m.mu.Unlock()

	javaArgs := []string{}
	if inst.Config.JavaArgs != "" {
		javaArgs = append(javaArgs, splitArgs(inst.Config.JavaArgs)...)
	}
	javaArgs = append(javaArgs, inst.Config.JarFile, "nogui")

	if err := proc.Start("java", javaArgs, inst.Config.Path); err != nil {
		m.mu.Lock()
		inst.Status = StatusCrashed
		m.mu.Unlock()
		return err
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
