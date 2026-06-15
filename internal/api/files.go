package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type fileEntry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime string `json:"mod_time"`
}

func (h *Handler) ListFiles(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	subDir := r.URL.Query().Get("dir")
	if subDir != "" {
		subDir = filepath.Clean(subDir)
		if strings.Contains(subDir, "..") {
			http.Error(w, "invalid path", http.StatusBadRequest)
			return
		}
	}

	dir := inst.Config.Path
	if subDir != "" {
		dir = filepath.Join(dir, subDir)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	files := make([]fileEntry, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileEntry{
			Name:    e.Name(),
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Format("2006-01-02 15:04:05"),
		})
	}
	json.NewEncoder(w).Encode(files)
}

func (h *Handler) UploadFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	r.ParseMultipartForm(100 << 20)
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	subDir := r.FormValue("dir")
	destDir := inst.Config.Path
	if subDir != "" {
		destDir = filepath.Join(destDir, filepath.Clean(subDir))
	}

	destPath := filepath.Join(destDir, header.Filename)

	if !strings.HasPrefix(destPath, inst.Config.Path) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	dst, err := os.Create(destPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "file": header.Filename})
}

func (h *Handler) DeleteFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		http.Error(w, "path required", http.StatusBadRequest)
		return
	}
	filePath = filepath.Clean(filePath)
	fullPath := filepath.Join(inst.Config.Path, filePath)

	if !strings.HasPrefix(fullPath, inst.Config.Path) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	if err := os.Remove(fullPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
