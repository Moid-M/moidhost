package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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
	CPUCores     int           `json:"cpu_cores"`
	DiskLimitMB  int           `json:"disk_limit_mb"`
	MaxMemory    uint64        `json:"max_memory_bytes"`
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
		CPUCores:     inst.Config.CPUCores,
		DiskLimitMB:  inst.Config.DiskLimitMB,
		MaxMemory:    parseMaxMemory(inst.Config.JavaArgs),
	}
}

// parseMaxMemory extracts -Xmx<value> from Java args and returns bytes.
func parseMaxMemory(javaArgs string) uint64 {
	fields := strings.Fields(javaArgs)
	for _, f := range fields {
		f = strings.ToLower(f)
		if !strings.HasPrefix(f, "-xmx") {
			continue
		}
		val := strings.TrimPrefix(f, "-xmx")
		if val == "" {
			continue
		}
		var mult uint64 = 1
		suffix := val[len(val)-1]
		numStr := val
		switch suffix {
		case 'k':
			mult = 1024
			numStr = val[:len(val)-1]
		case 'm':
			mult = 1024 * 1024
			numStr = val[:len(val)-1]
		case 'g':
			mult = 1024 * 1024 * 1024
			numStr = val[:len(val)-1]
		case 't':
			mult = 1024 * 1024 * 1024 * 1024
			numStr = val[:len(val)-1]
		}
		n, err := strconv.ParseUint(numStr, 10, 64)
		if err != nil {
			continue
		}
		return n * mult
	}
	return 0
}

func (h *Handler) checkPerm(w http.ResponseWriter, r *http.Request, id string, perms ...string) bool {
	if GetRoleFromCtx(r) == "admin" {
		return true
	}
	for _, perm := range perms {
		if h.auth.CheckPermission(r, id, perm) {
			return true
		}
	}
	http.Error(w, "forbidden", http.StatusForbidden)
	return false
}

func (h *Handler) ListServers(w http.ResponseWriter, r *http.Request) {
	insts := h.manager.List()
	role := GetRoleFromCtx(r)
	username := GetUserFromCtx(r)
	resp := make([]serverResponse, 0, len(insts))
	for _, inst := range insts {
		if role == "admin" {
			resp = append(resp, toResponse(inst))
		} else {
			user := h.auth.GetUsersFile().GetUser(username)
			if user != nil {
				if _, ok := user.Permissions[inst.Config.ID]; ok {
					resp = append(resp, toResponse(inst))
				}
			}
		}
	}
	json.NewEncoder(w).Encode(resp)
}

func (h *Handler) CreateServer(w http.ResponseWriter, r *http.Request) {
	if GetRoleFromCtx(r) != "admin" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
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
	if !h.checkPerm(w, r, id, "dashboard") {
		return
	}
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) UpdateServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.checkPerm(w, r, id, "settings") {
		return
	}
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
	if !h.checkPerm(w, r, id, "server_delete") {
		return
	}
	if err := h.manager.Delete(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) StartServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.checkPerm(w, r, id, "start") {
		return
	}
	if err := h.manager.Start(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) StopServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.checkPerm(w, r, id, "stop") {
		return
	}
	if err := h.manager.Stop(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) KillServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.checkPerm(w, r, id, "stop") {
		return
	}
	if err := h.manager.Kill(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) RestartServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.checkPerm(w, r, id, "restart") {
		return
	}
	if err := h.manager.Restart(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
}

func (h *Handler) AcceptEULA(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.checkPerm(w, r, id, "start") {
		return
	}
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
	if !h.checkPerm(w, r, id, "players") {
		return
	}
	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	type playerStats struct {
		PlayTime int `json:"play_time"`
		Deaths   int `json:"deaths"`
		Kills    int `json:"kills"`
		Damage   int `json:"damage"`
		WalkDist int `json:"walk_dist"`
	}

	type playerEntry struct {
		Name     string       `json:"name"`
		UUID     string       `json:"uuid"`
		Online   bool         `json:"online"`
		Stats    *playerStats `json:"stats,omitempty"`
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
				entry := playerEntry{Name: p.Name, UUID: p.UUID}
				// Read stats from world/stats/<uuid>.json
				statsPath := filepath.Join(inst.Config.Path, "world", "stats", p.UUID+".json")
				if sd, err := os.ReadFile(statsPath); err == nil {
					var raw struct {
						Stats struct {
							Custom struct {
								PlayTime int `json:"minecraft:play_time"`
								Deaths   int `json:"minecraft:deaths"`
								Kills    int `json:"minecraft:mob_kills"`
								Damage   int `json:"minecraft:damage_dealt"`
								WalkDist int `json:"minecraft:walk_one_cm"`
							} `json:"minecraft:custom"`
						} `json:"stats"`
					}
					if json.Unmarshal(sd, &raw) == nil {
						entry.Stats = &playerStats{
							PlayTime: raw.Stats.Custom.PlayTime,
							Deaths:   raw.Stats.Custom.Deaths,
							Kills:    raw.Stats.Custom.Kills,
							Damage:   raw.Stats.Custom.Damage,
							WalkDist: raw.Stats.Custom.WalkDist,
						}
					}
				}
				players = append(players, entry)
			}
		}
	}

	// If server is running, mark online players from the console
	if inst.Status == server.StatusRunning {
		lines, _ := h.manager.GetLogs(id)
		for i := len(lines) - 1; i >= 0; i-- {
			line := lines[i]
			if strings.Contains(line, "There are") && strings.Contains(line, "players online") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					for _, name := range strings.Split(parts[1], ",") {
						name = strings.TrimSpace(name)
						if name != "" {
							found := false
							for j := range players {
								if players[j].Name == name {
									players[j].Online = true
									found = true
									break
								}
							}
							if !found {
								players = append(players, playerEntry{Name: name, Online: true})
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

func (h *Handler) ServerStats(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.checkPerm(w, r, id, "dashboard") {
		return
	}

	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	stats := struct {
		CPUPercent  float64 `json:"cpu_percent"`
		MemoryRSS   uint64  `json:"memory_rss_bytes"`
		MaxMemory   uint64  `json:"max_memory_bytes"`
		DiskUsed    uint64  `json:"disk_used_bytes"`
		DiskLimit   uint64  `json:"disk_limit_bytes"`
		CPUCores    int     `json:"cpu_cores"`
		ProcessPid  int     `json:"process_pid"`
	}{}

	pid := h.manager.GetProcessPid(id)
	stats.ProcessPid = pid
	stats.CPUCores = inst.Config.CPUCores
	stats.MaxMemory = parseMaxMemory(inst.Config.JavaArgs)
	if inst.Config.DiskLimitMB > 0 {
		stats.DiskLimit = uint64(inst.Config.DiskLimitMB) * 1024 * 1024
	}

	if pid > 0 {
		ps, err := system.GetProcessStats(pid)
		if err == nil {
			stats.CPUPercent = ps.CPUPercent
			stats.MemoryRSS = ps.MemoryRSS
		}
	}

	disk, err := system.GetDirSize(inst.Config.Path)
	if err == nil {
		stats.DiskUsed = disk
	}

	json.NewEncoder(w).Encode(stats)
}

func (h *Handler) SendCommand(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.checkPerm(w, r, id, "console_send") {
		return
	}
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
