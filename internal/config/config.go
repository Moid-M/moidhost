package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type ServerConfig struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	JarFile   string `json:"jar_file"`
	JavaPath  string `json:"java_path"`
	JavaArgs  string `json:"java_args"`
	Port      int    `json:"port"`
	AutoStart bool   `json:"auto_start"`
}

type Config struct {
	Servers []ServerConfig `json:"servers"`
	DataDir string         `json:"data_dir"`
	Port    int            `json:"port"`
}

type Store struct {
	path string
}

func NewStore(path string) *Store {
	return &Store{path: path}
}

func (s *Store) Load() (*Config, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{Servers: []ServerConfig{}, Port: 8080}, nil
		}
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.Servers == nil {
		cfg.Servers = []ServerConfig{}
	}
	if cfg.DataDir == "" {
		cfg.DataDir = filepath.Join(filepath.Dir(s.path), "servers")
	} else if !filepath.IsAbs(cfg.DataDir) {
		cfg.DataDir = filepath.Join(filepath.Dir(s.path), cfg.DataDir)
	}
	cfg.DataDir = filepath.Clean(cfg.DataDir)
	for i := range cfg.Servers {
		cfg.Servers[i].Path = filepath.Join(cfg.DataDir, cfg.Servers[i].ID)
	}
	if cfg.Port == 0 {
		cfg.Port = 8080
	}
	return &cfg, nil
}

func (s *Store) Save(cfg *Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0644)
}
