package api

import (
	"encoding/json"
	"net/http"

	"github.com/coder/websocket"
)

type consoleMsg struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

func (h *Handler) ConsoleWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	if !h.checkPerm(w, r, id, "console") {
		return
	}

	inst := h.manager.Get(id)
	if inst == nil {
		http.Error(w, "server not found", http.StatusNotFound)
		return
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer c.CloseNow()

	logs, err := h.manager.GetLogs(id)
	if err == nil && logs != nil {
		for _, line := range logs {
			msg, _ := json.Marshal(consoleMsg{Type: "log", Data: line})
			c.Write(r.Context(), websocket.MessageText, msg)
		}
	}

	ch, err := h.manager.Subscribe(id)
	if err != nil {
		return
	}
	defer h.manager.Unsubscribe(id, ch)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, msg, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var cmd consoleMsg
			if json.Unmarshal(msg, &cmd) == nil && cmd.Type == "cmd" {
				h.manager.SendCommand(id, cmd.Data)
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		case line, ok := <-ch:
			if !ok {
				return
			}
			msg, _ := json.Marshal(consoleMsg{Type: "log", Data: line})
			c.Write(r.Context(), websocket.MessageText, msg)
		}
	}
}

func (h *Handler) GetLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.checkPerm(w, r, id, "console") {
		return
	}
	logs, err := h.manager.GetLogs(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if logs == nil {
		logs = []string{}
	}
	json.NewEncoder(w).Encode(logs)
}
