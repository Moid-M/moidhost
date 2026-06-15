package api

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type worldInfo struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	ModTime   string `json:"mod_time"`
	IsLoaded  bool   `json:"is_loaded"`
}

type backupEntry struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Created string `json:"created"`
}

func (h *Handler) WorldInfo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	// Find world directories in the server folder
	var worlds []worldInfo
	entries, err := os.ReadDir(inst.Config.Path)
	if err != nil {
		json.NewEncoder(w).Encode(worlds)
		return
	}

	// Known world folder patterns
	worldPatterns := []string{"world", "world_nether", "world_the_end"}
	seen := map[string]bool{}

	for _, pattern := range worldPatterns {
		info, err := os.Stat(filepath.Join(inst.Config.Path, pattern))
		if err != nil || !info.IsDir() {
			continue
		}
		size := dirSize(filepath.Join(inst.Config.Path, pattern))
		worlds = append(worlds, worldInfo{
			Name:     pattern,
			Path:     pattern,
			Size:     size,
			ModTime:  info.ModTime().Format(time.RFC3339),
			IsLoaded: true,
		})
		seen[pattern] = true
	}

	// Also scan for any other directories that look like worlds (have level.dat)
	for _, e := range entries {
		if !e.IsDir() || seen[e.Name()] || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if _, err := os.Stat(filepath.Join(inst.Config.Path, e.Name(), "level.dat")); err == nil {
			info, _ := e.Info()
			size := dirSize(filepath.Join(inst.Config.Path, e.Name()))
			worlds = append(worlds, worldInfo{
				Name:     e.Name(),
				Path:     e.Name(),
				Size:     size,
				ModTime:  info.ModTime().Format(time.RFC3339),
				IsLoaded: true,
			})
		}
	}

	json.NewEncoder(w).Encode(worlds)
}

func dirSize(path string) int64 {
	var total int64
	filepath.Walk(path, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !fi.IsDir() {
			total += fi.Size()
		}
		return nil
	})
	return total
}

func backupDir(serverPath string) string {
	return filepath.Join(serverPath, "backups")
}

func (h *Handler) BackupList(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	bDir := backupDir(inst.Config.Path)
	entries, err := os.ReadDir(bDir)
	if err != nil {
		json.NewEncoder(w).Encode([]backupEntry{})
		return
	}

	var backups []backupEntry
	for _, e := range entries {
		if e.IsDir() || (!strings.HasSuffix(e.Name(), ".zip") && !strings.HasSuffix(e.Name(), ".tar.gz")) {
			continue
		}
		info, _ := e.Info()
		if info == nil {
			continue
		}
		backups = append(backups, backupEntry{
			Name:    e.Name(),
			Size:    info.Size(),
			Created: info.ModTime().Format(time.RFC3339),
		})
	}

	sort.Slice(backups, func(i, j int) bool {
		return backups[i].Created > backups[j].Created
	})

	json.NewEncoder(w).Encode(backups)
}

func (h *Handler) BackupCreate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	var req struct {
		Folders []string `json:"folders"`
	}
	folders := findWorldDirs(inst.Config.Path)

	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil && len(req.Folders) > 0 {
			// Validate that requested folders exist
			var valid []string
			for _, f := range req.Folders {
				fi, err := os.Stat(filepath.Join(inst.Config.Path, f))
				if err == nil && fi.IsDir() {
					valid = append(valid, f)
				}
			}
			if len(valid) > 0 {
				folders = valid
			}
		}
	}

	if len(folders) == 0 {
		http.Error(w, "no directories to back up", http.StatusBadRequest)
		return
	}

	bDir := backupDir(inst.Config.Path)
	os.MkdirAll(bDir, 0755)

	ts := time.Now().Format("2006-01-02_150405")
	suffix := "backup"
	if len(folders) == 1 {
		suffix = folders[0]
	}
	zipName := fmt.Sprintf("%s-%s.zip", suffix, ts)
	zipPath := filepath.Join(bDir, zipName)

	if err := zipWorlds(zipPath, folders, inst.Config.Path); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	info, _ := os.Stat(zipPath)
	var size int64
	if info != nil {
		size = info.Size()
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(backupEntry{
		Name:    zipName,
		Size:    size,
		Created: time.Now().Format(time.RFC3339),
	})
}

func (h *Handler) BackupDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	backupName := r.URL.Query().Get("name")
	if backupName == "" {
		http.Error(w, "backup name required", http.StatusBadRequest)
		return
	}

	backupPath := filepath.Join(backupDir(inst.Config.Path), filepath.Base(backupName))
	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		http.Error(w, "backup not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(backupName)))
	w.Header().Set("Content-Type", "application/zip")
	http.ServeFile(w, r, backupPath)
}

func (h *Handler) BackupRestore(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	backupName := r.URL.Query().Get("name")
	if backupName == "" {
		http.Error(w, "backup name required", http.StatusBadRequest)
		return
	}

	if inst.Status == "running" || inst.Status == "starting" {
		http.Error(w, "server must be stopped to restore a backup", http.StatusBadRequest)
		return
	}

	bDir := backupDir(inst.Config.Path)
	zipPath := filepath.Join(bDir, filepath.Base(backupName))

	if _, err := os.Stat(zipPath); os.IsNotExist(err) {
		http.Error(w, "backup not found", http.StatusNotFound)
		return
	}

	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer reader.Close()

	for _, f := range reader.File {
		if f.FileInfo().IsDir() {
			os.MkdirAll(filepath.Join(inst.Config.Path, f.Name), 0755)
			continue
		}
		destPath := filepath.Join(inst.Config.Path, f.Name)
		os.MkdirAll(filepath.Dir(destPath), 0755)
		src, err := f.Open()
		if err != nil {
			continue
		}
		dst, err := os.Create(destPath)
		if err != nil {
			src.Close()
			continue
		}
		io.Copy(dst, src)
		dst.Close()
		src.Close()
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (h *Handler) BackupDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	backupName := r.URL.Query().Get("name")
	if backupName == "" {
		http.Error(w, "backup name required", http.StatusBadRequest)
		return
	}

	bDir := backupDir(inst.Config.Path)
	zipPath := filepath.Join(bDir, filepath.Base(backupName))
	if err := os.Remove(zipPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) WorldDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	worldName := r.URL.Query().Get("world")
	if worldName == "" {
		worldName = "world"
	}

	worldPath := filepath.Join(inst.Config.Path, worldName)
	if _, err := os.Stat(worldPath); os.IsNotExist(err) {
		http.Error(w, "world not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, worldName))
	w.Header().Set("Content-Type", "application/zip")

	zw := zip.NewWriter(w)
	filepath.Walk(worldPath, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(inst.Config.Path, path)
		if fi.IsDir() {
			zw.Create(rel + "/")
			return nil
		}
		f, err := zw.Create(rel)
		if err != nil {
			return nil
		}
		src, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer src.Close()
		io.Copy(f, src)
		return nil
	})
	zw.Close()
}

func (h *Handler) WorldUpload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	if inst.Status == "running" || inst.Status == "starting" {
		http.Error(w, "server must be stopped to upload a world", http.StatusBadRequest)
		return
	}

	r.ParseMultipartForm(500 << 20) // 500MB max
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	tmpPath := filepath.Join(inst.Config.Path, ".upload_"+header.Filename)
	dst, err := os.Create(tmpPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if _, err := io.Copy(dst, file); err != nil {
		dst.Close()
		os.Remove(tmpPath)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dst.Close()
	defer os.Remove(tmpPath)

	reader, err := zip.OpenReader(tmpPath)
	if err != nil {
		http.Error(w, "invalid zip file", http.StatusBadRequest)
		return
	}
	defer reader.Close()

	var extractedWorlds []string
	for _, f := range reader.File {
		rel := filepath.Clean(f.Name)
		if strings.Contains(rel, "..") {
			continue
		}
		destPath := filepath.Join(inst.Config.Path, rel)
		if f.FileInfo().IsDir() {
			os.MkdirAll(destPath, 0755)
			continue
		}
		os.MkdirAll(filepath.Dir(destPath), 0755)
		src, err := f.Open()
		if err != nil {
			continue
		}
		dst, err := os.Create(destPath)
		if err != nil {
			src.Close()
			continue
		}
		io.Copy(dst, src)
		dst.Close()
		src.Close()
		// Track top-level dirs
		parts := strings.SplitN(rel, string(filepath.Separator), 2)
		if len(parts) > 0 && parts[0] != "" {
			full := filepath.Join(inst.Config.Path, parts[0])
			if fi, err := os.Stat(full); err == nil && fi.IsDir() {
				found := false
				for _, w := range extractedWorlds {
					if w == parts[0] {
						found = true
						break
					}
				}
				if !found {
					extractedWorlds = append(extractedWorlds, parts[0])
				}
			}
		}
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "ok",
		"worlds": extractedWorlds,
	})
}

// Helper: find all world directories
func findWorldDirs(serverPath string) []string {
	var dirs []string
	patterns := []string{"world", "world_nether", "world_the_end"}
	for _, p := range patterns {
		if fi, err := os.Stat(filepath.Join(serverPath, p)); err == nil && fi.IsDir() {
			dirs = append(dirs, p)
		}
	}
	// Scan for additional world dirs with level.dat
	entries, _ := os.ReadDir(serverPath)
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || e.Name() == "backups" {
			continue
		}
		found := false
		for _, d := range dirs {
			if d == e.Name() {
				found = true
				break
			}
		}
		if found {
			continue
		}
		if _, err := os.Stat(filepath.Join(serverPath, e.Name(), "level.dat")); err == nil {
			dirs = append(dirs, e.Name())
		}
	}
	return dirs
}

func zipWorlds(zipPath string, dirs []string, serverPath string) error {
	zw, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	defer zw.Close()

	w := zip.NewWriter(zw)
	defer w.Close()

	for _, dir := range dirs {
		absDir := filepath.Join(serverPath, dir)
		filepath.Walk(absDir, func(path string, fi os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(serverPath, path)
			if fi.IsDir() {
				w.Create(rel + "/")
				return nil
			}
			f, err := w.Create(rel)
			if err != nil {
				return nil
			}
			src, err := os.Open(path)
			if err != nil {
				return nil
			}
			defer src.Close()
			io.Copy(f, src)
			return nil
		})
	}
	return nil
}

func (h *Handler) WorldFolders(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	var folders []struct {
		Name  string `json:"name"`
		Size  int64  `json:"size"`
		IsMod bool   `json:"is_mod"`
	}

	entries, err := os.ReadDir(inst.Config.Path)
	if err != nil {
		json.NewEncoder(w).Encode(folders)
		return
	}

	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || e.Name() == "backups" {
			continue
		}
		info, _ := e.Info()
		var size int64
		if info != nil {
			size = info.Size()
		}
		isMod := e.Name() == "plugins" || e.Name() == "mods" || e.Name() == "datapacks"
		folders = append(folders, struct {
			Name  string `json:"name"`
			Size  int64  `json:"size"`
			IsMod bool   `json:"is_mod"`
		}{
			Name:  e.Name(),
			Size:  dirSize(filepath.Join(inst.Config.Path, e.Name())),
			IsMod: isMod,
		})
	}

	json.NewEncoder(w).Encode(folders)
}

func (h *Handler) WorldDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	worldName := r.URL.Query().Get("name")
	if worldName == "" {
		http.Error(w, "world name required", http.StatusBadRequest)
		return
	}

	if inst.Status == "running" || inst.Status == "starting" {
		http.Error(w, "server must be stopped to delete a world", http.StatusBadRequest)
		return
	}

	worldPath := filepath.Join(inst.Config.Path, worldName)
	if _, err := os.Stat(worldPath); os.IsNotExist(err) {
		http.Error(w, "world not found", http.StatusNotFound)
		return
	}

	if err := os.RemoveAll(worldPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
