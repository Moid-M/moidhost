package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Permissions map[string][]string // server_id -> perm list

type User struct {
	PasswordHash string      `json:"password_hash"`
	Role         string      `json:"role"` // "admin" or "user"
	Permissions  Permissions `json:"permissions,omitempty"`
}

type UsersFile struct {
	mu      sync.RWMutex
	path    string
	users   map[string]*User
}

func NewUsersFile(path string) *UsersFile {
	uf := &UsersFile{path: path, users: map[string]*User{}}
	uf.Load()
	return uf
}

func (uf *UsersFile) Load() {
	uf.mu.Lock()
	defer uf.mu.Unlock()
	data, err := os.ReadFile(uf.path)
	if err != nil {
		uf.users = map[string]*User{}
		return
	}
	var users map[string]*User
	if json.Unmarshal(data, &users) != nil {
		uf.users = map[string]*User{}
		return
	}
	if users == nil {
		users = map[string]*User{}
	}
	uf.users = users
}

func (uf *UsersFile) Save() error {
	uf.mu.RLock()
	defer uf.mu.RUnlock()
	os.MkdirAll(filepath.Dir(uf.path), 0755)
	data, err := json.MarshalIndent(uf.users, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(uf.path, data, 0600)
}

func (uf *UsersFile) GetUser(username string) *User {
	uf.mu.RLock()
	defer uf.mu.RUnlock()
	return uf.users[username]
}

func (uf *UsersFile) ListUsers() map[string]*User {
	uf.mu.RLock()
	defer uf.mu.RUnlock()
	cp := make(map[string]*User, len(uf.users))
	for k, v := range uf.users {
		cp[k] = v
	}
	return cp
}

func (uf *UsersFile) UpsertUser(username string, user *User) error {
	uf.mu.Lock()
	uf.users[username] = user
	uf.mu.Unlock()
	return uf.Save()
}

func (uf *UsersFile) DeleteUser(username string) error {
	uf.mu.Lock()
	delete(uf.users, username)
	uf.mu.Unlock()
	return uf.Save()
}

func (uf *UsersFile) Count() int {
	uf.mu.RLock()
	defer uf.mu.RUnlock()
	return len(uf.users)
}

func (uf *UsersFile) Path() string {
	return uf.path
}

func (uf *UsersFile) SetupPath() string {
	return filepath.Join(filepath.Dir(uf.path), ".setup_admin")
}
