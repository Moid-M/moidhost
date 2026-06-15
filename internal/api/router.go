package api

import (
	"embed"
	"io/fs"
	"net/http"

	"moidhost/internal/server"
)

type Handler struct {
	manager *server.Manager
	dataDir string
}

func NewHandler(manager *server.Manager, dataDir string) *Handler {
	return &Handler{manager: manager, dataDir: dataDir}
}

func (h *Handler) Register(mux *http.ServeMux, webFS embed.FS) {
	mux.HandleFunc("GET /api/servers", h.ListServers)
	mux.HandleFunc("POST /api/servers", h.CreateServer)
	mux.HandleFunc("GET /api/servers/{id}", h.GetServer)
	mux.HandleFunc("PUT /api/servers/{id}", h.UpdateServer)
	mux.HandleFunc("DELETE /api/servers/{id}", h.DeleteServer)
	mux.HandleFunc("POST /api/servers/{id}/start", h.StartServer)
	mux.HandleFunc("POST /api/servers/{id}/stop", h.StopServer)
	mux.HandleFunc("POST /api/servers/{id}/restart", h.RestartServer)
	mux.HandleFunc("POST /api/servers/{id}/kill", h.KillServer)
	mux.HandleFunc("POST /api/servers/{id}/command", h.SendCommand)
	mux.HandleFunc("GET /api/servers/{id}/console", h.ConsoleWS)
	mux.HandleFunc("GET /api/servers/{id}/logs", h.GetLogs)
	mux.HandleFunc("GET /api/servers/{id}/files", h.ListFiles)
	mux.HandleFunc("PUT /api/servers/{id}/files", h.RenameFile)
	mux.HandleFunc("DELETE /api/servers/{id}/files", h.DeleteFile)
	mux.HandleFunc("POST /api/servers/{id}/upload", h.UploadFile)
	mux.HandleFunc("GET /api/servers/{id}/download", h.DownloadFile)
	mux.HandleFunc("GET /api/servers/{id}/file", h.ReadFile)
	mux.HandleFunc("PUT /api/servers/{id}/file", h.WriteFile)
	mux.HandleFunc("POST /api/servers/{id}/eula", h.AcceptEULA)
	mux.HandleFunc("GET /api/servers/{id}/players", h.ServerPlayers)

	// World management
	mux.HandleFunc("GET /api/servers/{id}/world", h.WorldInfo)
	mux.HandleFunc("GET /api/servers/{id}/world/download", h.WorldDownload)
	mux.HandleFunc("POST /api/servers/{id}/world/upload", h.WorldUpload)
	mux.HandleFunc("GET /api/servers/{id}/world/backups", h.BackupList)
	mux.HandleFunc("POST /api/servers/{id}/world/backup", h.BackupCreate)
	mux.HandleFunc("POST /api/servers/{id}/world/restore", h.BackupRestore)
	mux.HandleFunc("DELETE /api/servers/{id}/world/backup", h.BackupDelete)

	mux.HandleFunc("GET /api/system/stats", h.SystemStats)

	webRoot, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(webRoot))
	mux.Handle("GET /", fileServer)
}
