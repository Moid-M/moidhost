package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/term"

	"moidhost/internal/api"
	"moidhost/internal/config"
	"moidhost/internal/server"
)

const Version = "0.1.0"

//go:embed web
var webFS embed.FS

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "-v", "--version":
			fmt.Printf("moidhost v%s %s/%s\n", Version, runtime.GOOS, runtime.GOARCH)
			return
		case "update":
			cmdUpdate()
			return
		case "uninstall":
			cmdUninstall()
			return
		case "reset-password":
			cmdResetPassword()
			return
		case "help", "-h", "--help":
			printHelp()
			return
		}
	}
	startServer()
}

func printHelp() {
	fmt.Println(`moidhost - Minecraft server manager

Usage:
  moidhost              Start the web server
  moidhost version      Print version
  moidhost update       Self-update (builds from source)
  moidhost uninstall    Remove binary, service, and data (requires sudo)
  moidhost reset-password  Reset admin password (requires sudo)

Docs: https://github.com/Moid-M/moidhost`)
}

func startServer() {
	dataDir := "."
	if env := os.Getenv("MOIDHOST_DATA"); env != "" {
		dataDir = env
	}
	configPath := filepath.Join(dataDir, "config.json")
	serversDir := filepath.Join(dataDir, "servers")

	if err := os.MkdirAll(serversDir, 0755); err != nil {
		log.Fatalf("cannot create data directory %s: %v\nTry: sudo chown -R $(whoami) %s", serversDir, err, dataDir)
	}

	store := config.NewStore(configPath)
	manager, err := server.NewManager(store)
	if err != nil {
		log.Fatalf("failed to initialize: %v", err)
	}

	// Initialize users file
	usersPath := filepath.Join(dataDir, "users.json")
	users := config.NewUsersFile(usersPath)

	// Process setup_admin file from install.sh (creates initial admin)
	if err := api.SetupAdminFromFile(users); err == nil {
		log.Println("Admin account created from install setup.")
	}

	handler := api.NewHandler(manager, serversDir, users)

	mux := http.NewServeMux()
	handler.Register(mux, webFS)

	cfg, _ := store.Load()
	port := cfg.Port
	if port == 0 {
		port = 8080
	}

	addr := fmt.Sprintf(":%d", port)
	log.Printf("moidhost v%s listening on http://localhost%s", Version, addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func cmdResetPassword() {
	if os.Geteuid() != 0 {
		fmt.Println("This command requires root. Run with sudo.")
		os.Exit(1)
	}

	dataDir := os.Getenv("MOIDHOST_DATA")
	if dataDir == "" {
		dataDir = "/var/lib/moidhost"
	}
	usersPath := filepath.Join(dataDir, "users.json")
	users := config.NewUsersFile(usersPath)

	fmt.Print("Username: ")
	reader := bufio.NewReader(os.Stdin)
	username, _ := reader.ReadString('\n')
	username = strings.TrimSpace(username)

	if username == "" {
		log.Fatal("username cannot be empty")
	}

	user := users.GetUser(username)
	if user == nil {
		log.Fatalf("user %s not found", username)
	}

	fmt.Print("New password: ")
	passBytes, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Println()
	if err != nil {
		log.Fatalf("failed to read password: %v", err)
	}
	password := string(passBytes)
	if password == "" {
		log.Fatal("password cannot be empty")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		log.Fatalf("failed to hash password: %v", err)
	}

	user.PasswordHash = string(hash)
	if err := users.UpsertUser(username, user); err != nil {
		log.Fatalf("failed to save: %v", err)
	}

	fmt.Printf("Password for '%s' reset successfully.\n", username)
}

func cmdUpdate() {
	self, err := os.Executable()
	if err != nil {
		log.Fatalf("failed to find self: %v", err)
	}

	fmt.Println("==> Updating moidhost from source...")

	tmp, err := os.MkdirTemp("", "moidhost-update-")
	if err != nil {
		log.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmp)

	cmd := exec.Command("git", "clone", "--depth=1",
		"https://github.com/Moid-M/moidhost.git", tmp)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatalf("failed to clone repo: %v", err)
	}

	build := exec.Command("go", "build", "-o", self, ".")
	build.Dir = tmp
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		log.Fatalf("failed to build: %v (is Go installed?)", err)
	}

	fmt.Println("==> Update complete. Restart moidhost to apply.")
}

func cmdUninstall() {
	fmt.Println("==> Uninstalling moidhost...")

	if os.Geteuid() != 0 {
		fmt.Println("This command requires root. Run with sudo.")
		os.Exit(1)
	}

	self, err := os.Executable()
	if err != nil {
		log.Fatalf("failed to find self: %v", err)
	}

	exec.Command("systemctl", "stop", "moidhost").Run()
	exec.Command("systemctl", "disable", "moidhost").Run()
	os.Remove("/etc/systemd/system/moidhost.service")
	exec.Command("systemctl", "daemon-reload").Run()
	fmt.Println("  Service removed.")

	os.Remove(self)
	fmt.Printf("  Binary removed (%s).\n", self)

	dataDir := os.Getenv("MOIDHOST_DATA")
	if dataDir == "" {
		dataDir = "/var/lib/moidhost"
	}
	if info, err := os.Stat(dataDir); err == nil && info.IsDir() {
		fmt.Printf("  Data directory (%s) preserved. Remove manually if desired.\n", dataDir)
	}

	fmt.Println("==> Uninstall complete.")
}
