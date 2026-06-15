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

	mux.HandleFunc("GET /api/system/stats", h.SystemStats)

	webRoot, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(webRoot))
	mux.Handle("GET /", fileServer)
}
