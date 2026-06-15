package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"moidhost/internal/config"
	"moidhost/internal/server"
)

type serverResponse struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	JarFile  string        `json:"jar_file"`
	JavaArgs string        `json:"java_args"`
	Port     int           `json:"port"`
	Status   server.Status `json:"status"`
	AutoStart bool         `json:"auto_start"`
}

func toResponse(inst *server.Instance) serverResponse {
	return serverResponse{
		ID:        inst.Config.ID,
		Name:      inst.Config.Name,
		JarFile:   inst.Config.JarFile,
		JavaArgs:  inst.Config.JavaArgs,
		Port:      inst.Config.Port,
		Status:    inst.Status,
		AutoStart: inst.Config.AutoStart,
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

func (h *Handler) RestartServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.manager.Restart(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	inst := h.manager.Get(id)
	json.NewEncoder(w).Encode(toResponse(inst))
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
