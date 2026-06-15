package api

import (
	"encoding/json"
	"net/http"

	"golang.org/x/crypto/bcrypt"

	"moidhost/internal/config"
)

func (h *Handler) ListUsers(w http.ResponseWriter, r *http.Request) {
	if GetRoleFromCtx(r) != "admin" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	users := h.auth.GetUsersFile().ListUsers()
	type userResp struct {
		Username    string              `json:"username"`
		Role        string              `json:"role"`
		Permissions config.Permissions  `json:"permissions,omitempty"`
		HasPassword bool                `json:"has_password"`
	}
	var resp []userResp
	for name, u := range users {
		resp = append(resp, userResp{
			Username:    name,
			Role:        u.Role,
			Permissions: u.Permissions,
			HasPassword: u.PasswordHash != "",
		})
	}
	if resp == nil {
		resp = []userResp{}
	}
	json.NewEncoder(w).Encode(resp)
}

func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
	if GetRoleFromCtx(r) != "admin" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req struct {
		Username    string              `json:"username"`
		Password    string              `json:"password"`
		Role        string              `json:"role"`
		Permissions config.Permissions  `json:"permissions,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.Username == "" || req.Password == "" {
		http.Error(w, "username and password required", http.StatusBadRequest)
		return
	}
	if req.Role == "" {
		req.Role = "user"
	}
	if req.Role != "admin" && req.Role != "user" {
		http.Error(w, "role must be admin or user", http.StatusBadRequest)
		return
	}
	uf := h.auth.GetUsersFile()
	if uf.GetUser(req.Username) != nil {
		http.Error(w, "user already exists", http.StatusConflict)
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	uf.UpsertUser(req.Username, &config.User{
		PasswordHash: string(hash),
		Role:         req.Role,
		Permissions:  req.Permissions,
	})
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (h *Handler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	if GetRoleFromCtx(r) != "admin" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	target := r.PathValue("username")
	if target == "" {
		http.Error(w, "username required", http.StatusBadRequest)
		return
	}
	uf := h.auth.GetUsersFile()
	existing := uf.GetUser(target)
	if existing == nil {
		http.Error(w, "user not found", http.StatusNotFound)
		return
	}
	var req struct {
		Password    string              `json:"password,omitempty"`
		Role        string              `json:"role,omitempty"`
		Permissions config.Permissions  `json:"permissions,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.Password != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		existing.PasswordHash = string(hash)
	}
	if req.Role != "" {
		existing.Role = req.Role
	}
	if req.Permissions != nil {
		existing.Permissions = req.Permissions
	}
	uf.UpsertUser(target, existing)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (h *Handler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	if GetRoleFromCtx(r) != "admin" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	target := r.PathValue("username")
	if target == "" {
		http.Error(w, "username required", http.StatusBadRequest)
		return
	}
	uf := h.auth.GetUsersFile()
	if uf.GetUser(target) == nil {
		http.Error(w, "user not found", http.StatusNotFound)
		return
	}
	// Cannot delete the last admin
	if existing := uf.GetUser(target); existing != nil && existing.Role == "admin" {
		admins := 0
		for _, u := range uf.ListUsers() {
			if u.Role == "admin" {
				admins++
			}
		}
		if admins <= 1 {
			http.Error(w, "cannot delete the last admin", http.StatusBadRequest)
			return
		}
	}
	uf.DeleteUser(target)
	w.WriteHeader(http.StatusNoContent)
}
