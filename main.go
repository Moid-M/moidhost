package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"moidhost/internal/api"
	"moidhost/internal/config"
	"moidhost/internal/server"
)

//go:embed web
var webFS embed.FS

func main() {
	dataDir := "."
	if env := os.Getenv("MOIDHOST_DATA"); env != "" {
		dataDir = env
	}
	configPath := filepath.Join(dataDir, "config.json")
	serversDir := filepath.Join(dataDir, "servers")

	os.MkdirAll(serversDir, 0755)

	store := config.NewStore(configPath)
	manager, err := server.NewManager(store)
	if err != nil {
		log.Fatalf("failed to initialize: %v", err)
	}

	handler := api.NewHandler(manager, serversDir)

	mux := http.NewServeMux()
	handler.Register(mux, webFS)

	cfg, _ := store.Load()
	port := cfg.Port
	if port == 0 {
		port = 8080
	}

	addr := fmt.Sprintf(":%d", port)
	log.Printf("moidhost listening on http://localhost%s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
