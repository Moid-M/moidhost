package api

import (
	"embed"
	"io/fs"
	"net/http"

	"moidhost/internal/config"
	"moidhost/internal/server"
)

type Handler struct {
	manager *server.Manager
	dataDir string
	auth    *AuthHandler
}

func NewHandler(manager *server.Manager, dataDir string, users *config.UsersFile) *Handler {
	return &Handler{
		manager: manager,
		dataDir: dataDir,
		auth:    NewAuthHandler(users),
	}
}

func (h *Handler) Auth() *AuthHandler { return h.auth }

func (h *Handler) Register(mux *http.ServeMux, webFS embed.FS) {
	// Public routes (no auth)
	loginHandler := func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			h.auth.Login(w, r)
			return
		}
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}

	// Wrap all API routes with auth middleware
	auth := h.auth.Middleware

	// Public
	mux.HandleFunc("POST /api/login", loginHandler)

	// Auth-required API
	mux.Handle("GET /api/auth/validate", auth(h.auth.ValidateToken)())
	mux.Handle("POST /api/auth/logout", auth(h.auth.Logout)())

	mux.Handle("GET /api/servers", auth(h.ListServers)())
	mux.Handle("POST /api/servers", auth(h.CreateServer)())
	mux.Handle("GET /api/servers/{id}", auth(h.GetServer)())
	mux.Handle("PUT /api/servers/{id}", auth(h.UpdateServer)())
	mux.Handle("DELETE /api/servers/{id}", auth(h.DeleteServer)())
	mux.Handle("POST /api/servers/{id}/start", auth(h.StartServer)())
	mux.Handle("POST /api/servers/{id}/stop", auth(h.StopServer)())
	mux.Handle("POST /api/servers/{id}/restart", auth(h.RestartServer)())
	mux.Handle("POST /api/servers/{id}/kill", auth(h.KillServer)())
	mux.Handle("POST /api/servers/{id}/command", auth(h.SendCommand)())
	mux.Handle("GET /api/servers/{id}/console", auth(h.ConsoleWS)())
	mux.Handle("GET /api/servers/{id}/logs", auth(h.GetLogs)())
	mux.Handle("GET /api/servers/{id}/files", auth(h.ListFiles)())
	mux.Handle("PUT /api/servers/{id}/files", auth(h.RenameFile)())
	mux.Handle("DELETE /api/servers/{id}/files", auth(h.DeleteFile)())
	mux.Handle("POST /api/servers/{id}/upload", auth(h.UploadFile)())
	mux.Handle("GET /api/servers/{id}/download", auth(h.DownloadFile)())
	mux.Handle("GET /api/servers/{id}/file", auth(h.ReadFile)())
	mux.Handle("PUT /api/servers/{id}/file", auth(h.WriteFile)())
	mux.Handle("POST /api/servers/{id}/eula", auth(h.AcceptEULA)())
	mux.Handle("GET /api/servers/{id}/players", auth(h.ServerPlayers)())

	// World management
	mux.Handle("GET /api/servers/{id}/world", auth(h.WorldInfo)())
	mux.Handle("DELETE /api/servers/{id}/world", auth(h.WorldDelete)())
	mux.Handle("GET /api/servers/{id}/world/download", auth(h.WorldDownload)())
	mux.Handle("POST /api/servers/{id}/world/upload", auth(h.WorldUpload)())
	mux.Handle("GET /api/servers/{id}/world/folders", auth(h.WorldFolders)())

	// Backup management
	mux.Handle("GET /api/servers/{id}/backups", auth(h.BackupList)())
	mux.Handle("POST /api/servers/{id}/backups", auth(h.BackupCreate)())
	mux.Handle("DELETE /api/servers/{id}/backups", auth(h.BackupDelete)())
	mux.Handle("POST /api/servers/{id}/backups/restore", auth(h.BackupRestore)())
	mux.Handle("GET /api/servers/{id}/backups/download", auth(h.BackupDownload)())

	// System
	mux.Handle("GET /api/system/stats", auth(h.SystemStats)())

	// User management (admin only, checked inside handlers)
	mux.Handle("GET /api/users", auth(h.ListUsers)())
	mux.Handle("POST /api/users", auth(h.CreateUser)())
	mux.Handle("PUT /api/users/{username}", auth(h.UpdateUser)())
	mux.Handle("DELETE /api/users/{username}", auth(h.DeleteUser)())

	webRoot, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(webRoot))
	mux.Handle("GET /", fileServer)
}
