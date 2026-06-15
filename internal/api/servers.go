package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"moidhost/internal/config"
	"moidhost/internal/server"
	"moidhost/internal/system"
)

type serverResponse struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	JarFile      string        `json:"jar_file"`
	JavaPath     string        `json:"java_path"`
	JavaArgs     string        `json:"java_args"`
	Port         int           `json:"port"`
	Status       server.Status `json:"status"`
	AutoStart    bool          `json:"auto_start"`
	EULAAccepted bool          `json:"eula_accepted"`
}

func checkEULA(path string) bool {
	data, err := os.ReadFile(filepath.Join(path, "eula.txt"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "eula=true" {
			return true
		}
	}
	return false
}

func toResponse(inst *server.Instance) serverResponse {
	return serverResponse{
		ID:           inst.Config.ID,
		Name:         inst.Config.Name,
		JarFile:      inst.Config.JarFile,
		JavaPath:     inst.Config.JavaPath,
		JavaArgs:     inst.Config.JavaArgs,
		Port:         inst.Config.Port,
		Status:       inst.Status,
		AutoStart:    inst.Config.AutoStart,
		EULAAccepted: checkEULA(inst.Config.Path),
	}
}

func (h *Handler) ListServers(w http.ResponseWriter, r *http.Request) {
	insts := h.manager.List()
	resp := make([]serverResponse, len(insts))
	for i, inst := range insts {
		resp[i] = toResponse(inst)
	}
	json.NewEncoder(w).Encode(resp)
}

func (h *Handler) CreateServer(w http.ResponseWriter, r *http.Request) {
	var sc config.ServerConfig
	if err := json.NewDecoder(r.Body).Decode(&sc); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if sc.ID == "" {
		sc.ID = strings.ToLower(strings.ReplaceAll(sc.Name, " ", "-"))
	}
	if sc.JavaArgs == "" {
		sc.JavaArgs = "-Xmx1G -Xms1G"
	}
	if sc.Port == 0 {
		sc.Port = 25565
	}
	if err := h.manager.Create(sc); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(sc.ID)
	if inst == nil {
		http.Error(w, "failed to create server", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) GetServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) UpdateServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var sc config.ServerConfig
	if err := json.NewDecoder(r.Body).Decode(&sc); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	sc.ID = id
	if err := h.manager.Update(id, sc); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) DeleteServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.manager.Delete(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) StartServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.manager.Start(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) StopServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.manager.Stop(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) KillServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.manager.Kill(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) RestartServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.manager.Restart(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) AcceptEULA(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}
	eulaPath := filepath.Join(inst.Config.Path, "eula.txt")
	if err := os.WriteFile(eulaPath, []byte("# By accepting you agree to the Minecraft EULA\n# https://aka.ms/MinecraftEULA\neula=true\n"), 0644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) ServerPlayers(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	type playerEntry struct {
		Name string `json:"name"`
		UUID string `json:"uuid"`
	}

	players := []playerEntry{}

	// Try usercache.json for known players
	cachePath := filepath.Join(inst.Config.Path, "usercache.json")
	if data, err := os.ReadFile(cachePath); err == nil {
		var cached []struct {
			Name string `json:"name"`
			UUID string `json:"uuid"`
		}
		if json.Unmarshal(data, &cached) == nil {
			for _, p := range cached {
				players = append(players, playerEntry{Name: p.Name, UUID: p.UUID})
			}
		}
	}

	// If server is running, get online players from the console
	if inst.Status == server.StatusRunning {
		lines, _ := h.manager.GetLogs(id)
		for i := len(lines) - 1; i >= 0; i-- {
			line := lines[i]
			if strings.Contains(line, "There are") && strings.Contains(line, "players online") {
				// Parse: "There are 3 of max of 20 players online: Steve, Alex, Notch"
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					for _, name := range strings.Split(parts[1], ",") {
						name = strings.TrimSpace(name)
						if name != "" {
							found := false
							for _, p := range players {
								if p.Name == name {
									found = true
									break
								}
							}
							if !found {
								players = append(players, playerEntry{Name: name, UUID: ""})
							}
						}
					}
				}
				break
			}
		}
	}

	json.NewEncoder(w).Encode(players)
}

func (h *Handler) SystemStats(w http.ResponseWriter, r *http.Request) {
	stats, err := system.GetStats(h.dataDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(stats)
}

func (h *Handler) SendCommand(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Command string `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := h.manager.SendCommand(id, req.Command); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusOK)
}
