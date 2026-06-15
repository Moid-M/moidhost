package process

import (
	"bufio"
	"io"
	"os/exec"
	"sync"
	"time"
)

type ServerProcess struct {
	mu     sync.Mutex
	Cmd    *exec.Cmd
	Stdin  io.WriteCloser
	lines  []string
	maxLen int
	subs   map[chan string]struct{}
	done   chan struct{}
}

func NewServerProcess() *ServerProcess {
	return &ServerProcess{
		lines:  make([]string, 0, 1000),
		maxLen: 1000,
		subs:   make(map[chan string]struct{}),
		done:   make(chan struct{}),
	}
}

func (sp *ServerProcess) Start(javaPath string, args []string, dir string) error {
	sp.mu.Lock()
	defer sp.mu.Unlock()

	cmdArgs := append([]string{"-jar"}, args...)
	cmd := exec.Command(javaPath, cmdArgs...)
	cmd.Dir = dir

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	sp.Cmd = cmd
	sp.Stdin = stdin

	if err := cmd.Start(); err != nil {
		return err
	}

	go sp.readLines(stdout)
	go sp.readLines(stderr)
	go func() {
		cmd.Wait()
		sp.mu.Lock()
		if sp.Stdin != nil {
			sp.Stdin.Close()
			sp.Stdin = nil
		}
		sp.mu.Unlock()
		close(sp.done)
	}()
	return nil
}

func (sp *ServerProcess) readLines(r io.Reader) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		sp.mu.Lock()
		sp.lines = append(sp.lines, line)
		if len(sp.lines) > sp.maxLen {
			sp.lines = sp.lines[len(sp.lines)-sp.maxLen:]
		}
		subs := make([]chan string, 0, len(sp.subs))
		for ch := range sp.subs {
			subs = append(subs, ch)
		}
		sp.mu.Unlock()
		for _, ch := range subs {
			select {
			case ch <- line:
			default:
			}
		}
	}
}

func (sp *ServerProcess) SendCommand(cmd string) error {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.Stdin == nil {
		return nil
	}
	_, err := io.WriteString(sp.Stdin, cmd+"\n")
	return err
}

func (sp *ServerProcess) Subscribe() chan string {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	ch := make(chan string, 64)
	sp.subs[ch] = struct{}{}
	return ch
}

func (sp *ServerProcess) Unsubscribe(ch chan string) {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	delete(sp.subs, ch)
	close(ch)
}

func (sp *ServerProcess) Lines() []string {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	out := make([]string, len(sp.lines))
	copy(out, sp.lines)
	return out
}

func (sp *ServerProcess) Stop(timeout time.Duration) error {
	sp.mu.Lock()
	cmd := sp.Cmd
	stdin := sp.Stdin
	sp.mu.Unlock()

	if stdin != nil {
		io.WriteString(stdin, "stop\n")
	}

	if cmd == nil || cmd.Process == nil {
		return nil
	}

	select {
	case <-sp.done:
		return nil
	case <-time.After(timeout):
		return cmd.Process.Kill()
	}
}

func (sp *ServerProcess) Kill() error {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.Cmd != nil && sp.Cmd.Process != nil {
		return sp.Cmd.Process.Kill()
	}
	return nil
}

func (sp *ServerProcess) Done() <-chan struct{} {
	return sp.done
}

func (sp *ServerProcess) Running() bool {
	select {
	case <-sp.done:
		return false
	default:
		return true
	}
}
