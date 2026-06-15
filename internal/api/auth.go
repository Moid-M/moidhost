package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"moidhost/internal/config"
)

type contextKey string
const ctxUserKey contextKey = "user"
const ctxRoleKey contextKey = "role"

type Session struct {
	Username string
	Role     string
	Expires  time.Time
}

type AuthHandler struct {
	users    *config.UsersFile
	sessions map[string]*Session
	mu       sync.RWMutex
}

func NewAuthHandler(users *config.UsersFile) *AuthHandler {
	return &AuthHandler{
		users:    users,
		sessions: map[string]*Session{},
	}
}

func randToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (a *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.Username == "" || req.Password == "" {
		http.Error(w, "username and password required", http.StatusBadRequest)
		return
	}

	user := a.users.GetUser(req.Username)
	if user == nil {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	token := randToken()
	a.mu.Lock()
	a.sessions[token] = &Session{
		Username: req.Username,
		Role:     user.Role,
		Expires:  time.Now().Add(24 * time.Hour),
	}
	a.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"token":    token,
		"username": req.Username,
		"role":     user.Role,
	})
}

func (a *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	token := extractToken(r)
	if token != "" {
		a.mu.Lock()
		delete(a.sessions, token)
		a.mu.Unlock()
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *AuthHandler) ValidateToken(w http.ResponseWriter, r *http.Request) {
	user, role := a.Authenticate(r)
	if user == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	resp := map[string]interface{}{
		"username": user,
		"role":     role,
	}
	if role != "admin" {
		u := a.users.GetUser(user)
		if u != nil {
			resp["permissions"] = u.Permissions
		}
	}
	json.NewEncoder(w).Encode(resp)
}

// Authenticate extracts user/role from request, returning ("", "") if invalid
func (a *AuthHandler) Authenticate(r *http.Request) (string, string) {
	token := extractToken(r)
	if token == "" {
		return "", ""
	}
	a.mu.RLock()
	sess, ok := a.sessions[token]
	a.mu.RUnlock()
	if !ok || time.Now().After(sess.Expires) {
		if ok {
			a.mu.Lock()
			delete(a.sessions, token)
			a.mu.Unlock()
		}
		return "", ""
	}
	return sess.Username, sess.Role
}

func extractToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && h[:7] == "Bearer " {
		return h[7:]
	}
	if tok := r.URL.Query().Get("token"); tok != "" {
		return tok
	}
	return ""
}

// Middleware wraps an http.HandlerFunc with auth. skipAuth routes skip the check.
func (a *AuthHandler) Middleware(next http.HandlerFunc, skip ...string) http.HandlerFunc {
	skipSet := map[string]bool{}
	for _, s := range skip {
		skipSet[s] = true
	}

	return func(w http.ResponseWriter, r *http.Request) {
		// Skip static files always
		if skipSet[r.URL.Path] {
			next(w, r)
			return
		}
		user, role := a.Authenticate(r)
		if user == "" {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), ctxUserKey, user)
		ctx = context.WithValue(ctx, ctxRoleKey, role)
		next(w, r.WithContext(ctx))
	}
}

// GetUserFromCtx extracts username from request context
func GetUserFromCtx(r *http.Request) string {
	if v, ok := r.Context().Value(ctxUserKey).(string); ok {
		return v
	}
	return ""
}

// GetRoleFromCtx extracts role from request context
func GetRoleFromCtx(r *http.Request) string {
	if v, ok := r.Context().Value(ctxRoleKey).(string); ok {
		return v
	}
	return ""
}

func (a *AuthHandler) CheckPermission(r *http.Request, serverID, permission string) bool {
	role := GetRoleFromCtx(r)
	if role == "admin" {
		return true
	}
	user := a.users.GetUser(GetUserFromCtx(r))
	if user == nil {
		return false
	}
	perms, ok := user.Permissions[serverID]
	if !ok {
		return false
	}
	for _, p := range perms {
		if p == permission {
			return true
		}
	}
	return false
}

// Get users file reference for user management
func (a *AuthHandler) GetUsersFile() *config.UsersFile {
	return a.users
}

// SetupAdmin creates the initial admin from a setup file written by install.sh
func SetupAdminFromFile(users *config.UsersFile) error {
	setupPath := users.SetupPath()
	data, err := os.ReadFile(setupPath)
	if err != nil {
		return err // file doesn't exist
	}
	var creds struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if json.Unmarshal(data, &creds) != nil || creds.Username == "" || creds.Password == "" {
		return nil // skip invalid file
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(creds.Password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	users.UpsertUser(creds.Username, &config.User{
		PasswordHash: string(hash),
		Role:         "admin",
	})
	os.Remove(setupPath)
	return nil
}
