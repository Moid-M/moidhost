package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func errBad(msg string) error  { return &apiErr{msg, http.StatusBadRequest} }
func errNotFound(msg string) error { return &apiErr{msg, http.StatusNotFound} }

type apiErr struct {
	msg  string
	code int
}

func (e *apiErr) Error() string { return e.msg }
func (e *apiErr) Status() int   { return e.code }

type fileEntry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime string `json:"mod_time"`
}

func (h *Handler) safePath(id, subPath string) (string, error) {
	inst := h.manager.Get(id)
	if inst == nil {
		return "", errNotFound("server not found")
	}
	subPath = filepath.Clean(subPath)
	if strings.Contains(subPath, "..") {
		return "", errBad("invalid path")
	}
	fullPath := filepath.Join(inst.Config.Path, subPath)
	if !strings.HasPrefix(fullPath, inst.Config.Path) {
		return "", errBad("invalid path")
	}
	return fullPath, nil
}

func (h *Handler) ListFiles(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	subDir := r.URL.Query().Get("dir")
	fullPath, err := h.safePath(id, subDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	entries, err := os.ReadDir(fullPath)
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
		s, err := h.safePath(id, subDir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		destDir = s
	}

	destPath := filepath.Join(destDir, header.Filename)
	if _, err := os.Stat(destPath); err == nil {
		http.Error(w, "file already exists", http.StatusConflict)
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

func (h *Handler) DownloadFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		http.Error(w, "path required", http.StatusBadRequest)
		return
	}

	fullPath, err := h.safePath(id, filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	f, err := os.Open(fullPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.Error(w, "cannot download directory", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Disposition", "attachment; filename=\""+filepath.Base(fullPath)+"\"")
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, filepath.Base(fullPath), info.ModTime(), f)
}

func (h *Handler) RenameFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		http.Error(w, "path required", http.StatusBadRequest)
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Name == "" || strings.Contains(req.Name, "/") {
		http.Error(w, "invalid name", http.StatusBadRequest)
		return
	}

	oldPath, err := h.safePath(id, filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	newPath := filepath.Join(filepath.Dir(oldPath), req.Name)
	if _, err := os.Stat(newPath); err == nil {
		http.Error(w, "target already exists", http.StatusConflict)
		return
	}

	if err := os.Rename(oldPath, newPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (h *Handler) ReadFile(w http.ResponseWriter, r *http.Request) {
	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		http.Error(w, "path required", http.StatusBadRequest)
		return
	}
	fullPath, err := h.safePath(r.PathValue("id"), filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	data, err := os.ReadFile(fullPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	contentType := "text/plain"
	if strings.HasSuffix(filePath, ".json") {
		contentType = "application/json"
	} else if strings.HasSuffix(filePath, ".html") || strings.HasSuffix(filePath, ".htm") {
		contentType = "text/html"
	} else if strings.HasSuffix(filePath, ".yml") || strings.HasSuffix(filePath, ".yaml") {
		contentType = "text/yaml"
	} else if strings.HasSuffix(filePath, ".properties") {
		contentType = "text/plain"
	} else if strings.HasSuffix(filePath, ".xml") {
		contentType = "text/xml"
	} else if strings.HasSuffix(filePath, ".png") || strings.HasSuffix(filePath, ".jpg") || strings.HasSuffix(filePath, ".jpeg") || strings.HasSuffix(filePath, ".gif") || strings.HasSuffix(filePath, ".ico") {
		contentType = ""
	}
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Write(data)
}

func (h *Handler) WriteFile(w http.ResponseWriter, r *http.Request) {
	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		http.Error(w, "path required", http.StatusBadRequest)
		return
	}
	fullPath, err := h.safePath(r.PathValue("id"), filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := os.WriteFile(fullPath, []byte(req.Content), 0644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (h *Handler) DeleteFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		http.Error(w, "path required", http.StatusBadRequest)
		return
	}

	fullPath, err := h.safePath(id, filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := os.RemoveAll(fullPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
