package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"nhooyr.io/websocket"
)

//go:embed all:web
var embeddedWeb embed.FS

const (
	appDirName = "celeste-input-overlay"
	httpPort   = "8090"
	wsPath     = "/ws"
)

type Size struct {
	W int `json:"w"`
	H int `json:"h"`
}

type Cell struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	Label       string   `json:"label"`
	LabelSize   int      `json:"labelSize,omitempty"`
	Keys        []string `json:"keys"`
	ShowCounter bool     `json:"showCounter"`
	X           int      `json:"x"`
	Y           int      `json:"y"`
	W           int      `json:"w"`
	H           int      `json:"h"`
	Image       string   `json:"image,omitempty"`
	OnBg        string   `json:"onBg,omitempty"`
	OnBorder    string   `json:"onBorder,omitempty"`
	Font        string   `json:"font,omitempty"`
	Scale       float64  `json:"scale,omitempty"`
}

type Overlay struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Size  Size   `json:"size"`
	Cells []Cell `json:"cells"`
}

type Config struct {
	Version  int       `json:"version"`
	Active   int       `json:"active"`
	Overlays []Overlay `json:"overlays"`
}

const defaultConfigJSON = `{
  "version": 2,
  "active": 0,
  "overlays": [
    {
      "id": "celeste",
      "name": "Celeste",
      "size": { "w": 510, "h": 206 },
      "cells": [
        { "id": "dash", "kind": "key", "label": "Dash",  "keys": ["KEY_H"], "showCounter": true, "x": 14,  "y": 14,  "w": 90, "h": 72 },
        { "id": "jump", "kind": "key", "label": "Jump",  "keys": ["KEY_J"], "showCounter": true, "x": 112, "y": 14,  "w": 90, "h": 72 },
        { "id": "up",   "kind": "key", "label": "↑",     "keys": ["KEY_W", "KEY_UP"], "showCounter": true, "x": 210, "y": 14, "w": 90, "h": 72 },
        { "id": "demo", "kind": "key", "label": "Demo",  "keys": ["KEY_Y"], "showCounter": true, "x": 308, "y": 14,  "w": 90, "h": 72 },
        { "id": "grab", "kind": "key", "label": "Grab",  "keys": ["KEY_LEFTSHIFT", "KEY_RIGHTSHIFT"], "showCounter": true, "x": 14,  "y": 94, "w": 90, "h": 72 },
        { "id": "left", "kind": "key", "label": "←",     "keys": ["KEY_A", "KEY_LEFT"], "showCounter": true, "x": 112, "y": 94, "w": 90, "h": 72 },
        { "id": "down", "kind": "key", "label": "↓",     "keys": ["KEY_S", "KEY_DOWN"], "showCounter": true, "x": 210, "y": 94, "w": 90, "h": 72 },
        { "id": "right","kind": "key", "label": "→",     "keys": ["KEY_D", "KEY_RIGHT"], "showCounter": true, "x": 308, "y": 94, "w": 90, "h": 72 },
        { "id": "jump2","kind": "key", "label": "Jump2", "keys": ["KEY_K"], "showCounter": true, "x": 406, "y": 94, "w": 90, "h": 72 },
        { "id": "madeline", "kind": "image", "image": "media/madeline_like_hihi.png", "showCounter": false, "x": 406, "y": 14, "w": 90, "h": 72 }
      ]
    }
  ]
}`

type captureTarget struct {
	Ov   string
	Cell string
}

var (
	sm            sync.Mutex
	cfgNow        Config
	watched       map[uint32]bool
	pressed       map[uint32]bool
	counts        map[string]int64
	capture       captureTarget
	countsDirty   atomic.Bool
	cfgDirty      atomic.Bool
)

func countKey(ovID, cellID string) string {
	return ovID + ":" + cellID
}

func activeIdx() int {
	if len(cfgNow.Overlays) == 0 {
		return 0
	}
	if cfgNow.Active < 0 || cfgNow.Active >= len(cfgNow.Overlays) {
		return 0
	}
	return cfgNow.Active
}

func configPath() string {
	if p := os.Getenv("CELESTE_OVERLAY_CONFIG"); p != "" {
		return p
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "config.json"
	}
	return filepath.Join(dir, appDirName, "config.json")
}

func countsPath() string {
	if p := os.Getenv("CELESTE_OVERLAY_COUNTS"); p != "" {
		return p
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "counts.json"
	}
	return filepath.Join(dir, appDirName, "counts.json")
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func hasKey(cell *Cell, name string) bool {
	for _, k := range cell.Keys {
		if k == name {
			return true
		}
	}
	return false
}

func appendKey(cell *Cell, name string) {
	cell.Keys = append(cell.Keys, name)
}

func cellHasNative(cell *Cell, code uint32) bool {
	if cell.Kind != "key" {
		return false
	}
	for _, k := range cell.Keys {
		if c, ok := resolveNative(k); ok && c == code {
			return true
		}
	}
	return false
}

func rebuildWatched() {
	w := map[uint32]bool{}
	for oi := range cfgNow.Overlays {
		ov := &cfgNow.Overlays[oi]
		for ci := range ov.Cells {
			cell := &ov.Cells[ci]
			if cell.Kind != "key" {
				continue
			}
			for _, k := range cell.Keys {
				if c, ok := resolveNative(k); ok {
					w[c] = true
				}
			}
		}
	}
	watched = w
	for c := range pressed {
		if !w[c] {
			delete(pressed, c)
		}
	}
}

func normalizeCells(cells []Cell) ([]Cell, error) {
	if len(cells) > 200 {
		cells = cells[:200]
	}
	seen := map[string]bool{}
	var out []Cell
	for i := range cells {
		cell := cells[i]
		switch cell.Kind {
		case "image":
		default:
			cell.Kind = "key"
		}
		if cell.Kind == "key" {
			var keys []string
			for _, k := range cell.Keys {
				n, ok := normalizeKeyInput(k)
				if ok && !hasKey(&Cell{Keys: keys}, n) {
					keys = append(keys, n)
				}
				if len(keys) >= 16 {
					break
				}
			}
			cell.Keys = keys
		} else {
			cell.Keys = nil
			cell.Image = strings.TrimSpace(cell.Image)
			if len(cell.Image) > 500 {
				return nil, fmt.Errorf("image path too long")
			}
		}
		cell.Label = strings.TrimSpace(cell.Label)
		if len(cell.Label) > 64 {
			cell.Label = cell.Label[:64]
		}
		cell.Font = strings.TrimSpace(cell.Font)
		if len(cell.Font) > 64 {
			cell.Font = cell.Font[:64]
		}
		if cell.Scale != 0 && (cell.Scale < 0.25 || cell.Scale > 4) {
			cell.Scale = 1
		}
		if cell.LabelSize < 8 || cell.LabelSize > 96 {
			cell.LabelSize = 24
		}
		if cell.X < 0 {
			cell.X = 0
		}
		if cell.Y < 0 {
			cell.Y = 0
		}
		if cell.W < 30 {
			cell.W = 90
		}
		if cell.H < 30 {
			cell.H = 72
		}
		if cell.ID == "" {
			cell.ID = fmt.Sprintf("cell-%d", i+1)
		}
		base := cell.ID
		for n := 1; seen[cell.ID]; n++ {
			cell.ID = fmt.Sprintf("%s-%d", base[:minInt(len(base), 40)], n)
		}
		seen[cell.ID] = true
		out = append(out, cell)
	}
	return out, nil
}

func normalizeConfig(c Config) (Config, error) {
	if len(c.Overlays) == 0 {
		return c, fmt.Errorf("no overlays in config")
	}
	if len(c.Overlays) > 50 {
		c.Overlays = c.Overlays[:50]
	}
	if c.Active < 0 {
		c.Active = 0
	}
	if c.Active >= len(c.Overlays) {
		c.Active = len(c.Overlays) - 1
	}
	seenOv := map[string]bool{}
	for i := range c.Overlays {
		ov := &c.Overlays[i]
		ov.ID = strings.TrimSpace(ov.ID)
		if ov.ID == "" {
			if i == 0 {
				ov.ID = "celeste"
			} else {
				ov.ID = fmt.Sprintf("ov-%d", i+1)
			}
		}
		base := ov.ID
		for n := 1; seenOv[ov.ID]; n++ {
			ov.ID = fmt.Sprintf("%s-%d", base[:minInt(len(base), 24)], n)
		}
		seenOv[ov.ID] = true
		if strings.TrimSpace(ov.Name) == "" {
			ov.Name = fmt.Sprintf("Overlay %d", i+1)
		}
		ov.Name = strings.TrimSpace(ov.Name)
		if len(ov.Name) > 64 {
			ov.Name = ov.Name[:64]
		}
		if ov.Size.W <= 0 {
			ov.Size.W = 510
		}
		if ov.Size.H <= 0 {
			ov.Size.H = 206
		}
		nc, err := normalizeCells(ov.Cells)
		if err != nil {
			return c, err
		}
		ov.Cells = nc
	}
	if c.Version == 0 {
		c.Version = 2
	}
	return c, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func saveConfig(c Config) error {
	return writeJSON(configPath(), c)
}

func saveCountsFile() error {
	sm.Lock()
	mp := make(map[string]int64, len(counts))
	for id, n := range counts {
		mp[id] = n
	}
	sm.Unlock()
	return writeJSON(countsPath(), map[string]any{
		"version": 1,
		"counts":  mp,
	})
}

func loadCounts() {
	var cf struct {
		Version int              `json:"version"`
		Counts  map[string]int64 `json:"counts"`
	}
	if err := readJSON(countsPath(), &cf); err != nil {
		return
	}
	prefix := ""
	if len(cfgNow.Overlays) > 0 {
		prefix = cfgNow.Overlays[0].ID + ":"
	}
	sm.Lock()
	for id, n := range cf.Counts {
		if n == 0 {
			continue
		}
		if strings.Contains(id, ":") {
			counts[id] = n
		} else if prefix != "" {
			counts[prefix+id] = n
		}
	}
	sm.Unlock()
}

func defaultConfig() (Config, error) {
	var c Config
	if err := json.Unmarshal([]byte(defaultConfigJSON), &c); err != nil {
		return c, err
	}
	return normalizeConfig(c)
}

// migrateLegacyConfig converts an old single-layout config (top-level
// "size"/"cells") into the new multi-overlay format with one Celeste overlay.
func migrateLegacyConfig() (Config, error) {
	var l struct {
		Size  Size   `json:"size"`
		Cells []Cell `json:"cells"`
	}
	if err := readJSON(configPath(), &l); err != nil {
		return Config{}, err
	}
	if l.Cells == nil && l.Size.W == 0 && l.Size.H == 0 {
		return Config{}, fmt.Errorf("no legacy layout found")
	}
	return Config{
		Version: 2,
		Active:  0,
		Overlays: []Overlay{
			{ID: "celeste", Name: "Celeste", Size: l.Size, Cells: l.Cells},
		},
	}, nil
}

func loadConfig() {
	var c Config
	if err := readJSON(configPath(), &c); err == nil && len(c.Overlays) > 0 {
		if nc, err := normalizeConfig(c); err == nil {
			cfgNow = nc
			return
		}
	}
	if migrated, err := migrateLegacyConfig(); err == nil {
		if nc, err := normalizeConfig(migrated); err == nil {
			cfgNow = nc
			return
		}
	}
	c, err := defaultConfig()
	if err != nil {
		panic(err)
	}
	cfgNow = c
}

func initState() {
	if counts == nil {
		counts = map[string]int64{}
	}
	if pressed == nil {
		pressed = map[uint32]bool{}
	}
}

func signalChanged() {
	select {
	case changedCh <- struct{}{}:
	default:
	}
}

var changedCh = make(chan struct{}, 1)

func onKey(code uint32, down bool) {
	if os.Getenv("CELESTE_OVERLAY_DEBUG") != "" {
		if n, ok := nativeName(code); ok {
			fmt.Printf("key %s code=%d down=%v\n", n, code, down)
		} else {
			fmt.Printf("key code=%d down=%v (unknown)\n", code, down)
		}
	}
	captured := false
	var capCell, capOv, capName string
	sm.Lock()
	if pressed[code] == down {
		sm.Unlock()
		return
	}
	pressed[code] = down
	if down {
		if name, ok := nativeName(code); ok && capture.Cell != "" {
			if name == "KEY_ESC" {
				capture = captureTarget{}
			} else {
				captured = true
				capCell = capture.Cell
				capOv = capture.Ov
				capName = name
				capture = captureTarget{}
				for oi := range cfgNow.Overlays {
					ov := &cfgNow.Overlays[oi]
					if ov.ID != capOv {
						continue
					}
					for ci := range ov.Cells {
						if ov.Cells[ci].ID == capCell {
							if !hasKey(&ov.Cells[ci], capName) {
								appendKey(&ov.Cells[ci], capName)
								cfgDirty.Store(true)
							}
							break
						}
					}
					break
				}
				rebuildWatched()
			}
		}
		if !captured {
			for oi := range cfgNow.Overlays {
				ov := &cfgNow.Overlays[oi]
				for ci := range ov.Cells {
					cell := &ov.Cells[ci]
					if cell.ShowCounter && cellHasNative(cell, code) {
						counts[countKey(ov.ID, cell.ID)]++
						countsDirty.Store(true)
					}
				}
			}
		}
	}
	sm.Unlock()
	if captured {
		cfgDirty.Store(true)
		saveConfig(cfgNow)
		sendCfg("captured", capCell, "Captured "+capName+" for "+capCell+"")
	}
	signalChanged()
}

func applyCfg(c Config) {
	nc, err := normalizeConfig(c)
	if err != nil {
		sendToast("invalid config: " + err.Error())
		return
	}
	sm.Lock()
	cfgNow = nc
	rebuildWatched()
	keep := map[string]bool{}
	for oi := range nc.Overlays {
		for _, cell := range nc.Overlays[oi].Cells {
			keep[countKey(nc.Overlays[oi].ID, cell.ID)] = true
		}
	}
	for id := range counts {
		if !keep[id] {
			delete(counts, id)
			countsDirty.Store(true)
		}
	}
	sm.Unlock()
	cfgDirty.Store(true)
	saveConfig(nc)
	sendCfg("saved", "", "")
	signalChanged()
}

func snapshots() map[string]any {
	sm.Lock()
	defer sm.Unlock()
	p := map[string][]bool{}
	c := map[string][]int64{}
	for oi := range cfgNow.Overlays {
		ov := &cfgNow.Overlays[oi]
		pv := make([]bool, len(ov.Cells))
		cv := make([]int64, len(ov.Cells))
		for ci := range ov.Cells {
			cell := &ov.Cells[ci]
			if cell.Kind == "key" {
				for _, k := range cell.Keys {
					if code, ok := resolveNative(k); ok && pressed[code] {
						pv[ci] = true
					}
				}
			}
			cv[ci] = counts[countKey(ov.ID, cell.ID)]
		}
		p[ov.ID] = pv
		c[ov.ID] = cv
	}
	return map[string]any{"t": "st", "p": p, "c": c}
}

func getCfg() Config {
	sm.Lock()
	defer sm.Unlock()
	c := cfgNow
	c.Overlays = make([]Overlay, len(cfgNow.Overlays))
	copy(c.Overlays, cfgNow.Overlays)
	for i := range c.Overlays {
		c.Overlays[i].Cells = make([]Cell, len(cfgNow.Overlays[i].Cells))
		copy(c.Overlays[i].Cells, cfgNow.Overlays[i].Cells)
		for j := range c.Overlays[i].Cells {
			c.Overlays[i].Cells[j].Keys = append([]string(nil), cfgNow.Overlays[i].Cells[j].Keys...)
		}
	}
	return c
}

func snapshotMsg() map[string]any {
	return snapshots()
}

func cfgMsg() map[string]any {
	return map[string]any{"t": "cfg", "cfg": getCfg()}
}

var (
	wsMu      sync.Mutex
	wsClients = make(map[*websocket.Conn]struct{})
)

func sendWS(c *websocket.Conn, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	wsMu.Lock()
	defer wsMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		_ = c.CloseNow()
		delete(wsClients, c)
	}
}

func broadcast(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	wsMu.Lock()
	defer wsMu.Unlock()
	for c := range wsClients {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			_ = c.CloseNow()
			delete(wsClients, c)
		}
		cancel()
	}
}

func sendToast(msg string) {
	broadcast(map[string]any{"t": "toast", "m": msg})
}

func sendCfg(kind, id, msg string) {
	m := cfgMsg()
	m["mid"] = kind
	m["msg"] = msg
	broadcast(m)
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ctx := context.Background()
	wsMu.Lock()
	wsClients[c] = struct{}{}
	wsMu.Unlock()
	sendWS(c, cfgMsg())
	sendWS(c, snapshotMsg())

	go func() {
		defer func() {
			wsMu.Lock()
			delete(wsClients, c)
			wsMu.Unlock()
			_ = c.Close(websocket.StatusNormalClosure, "")
		}()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			roundTripMsg(c, data)
		}
	}()
}

func roundTripMsg(c *websocket.Conn, data []byte) {
	var m struct {
		T    string  `json:"t"`
		ID   string  `json:"id"`
		OV   string  `json:"ov"`
		Cfg  *Config `json:"cfg"`
		Key  string  `json:"key"`
		Down *bool   `json:"down"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return
	}
	switch m.T {
	case "cfg":
		if m.Cfg != nil {
			applyCfg(*m.Cfg)
		}
	case "cap":
		sm.Lock()
		capture.Ov = m.OV
		if capture.Ov == "" && len(cfgNow.Overlays) > 0 {
			capture.Ov = cfgNow.Overlays[activeIdx()].ID
		}
		capture.Cell = m.ID
		sm.Unlock()
		sendWS(c, map[string]any{"t": "toast", "m": "listening; press a key (Esc cancels)"})
	case "capoff":
		sm.Lock()
		capture = captureTarget{}
		sm.Unlock()
		sendWS(c, map[string]any{"t": "toast", "m": "capture cancelled"})
	case "reset":
		sm.Lock()
		if id := m.ID; counts != nil {
			ovID := m.OV
			if ovID == "" && len(cfgNow.Overlays) > 0 {
				ovID = cfgNow.Overlays[activeIdx()].ID
			}
			if ovID != "" {
				counts[countKey(ovID, id)] = 0
			}
		}
		countsDirty.Store(true)
		sm.Unlock()
		signalChanged()
	case "resetall":
		sm.Lock()
		for id := range counts {
			counts[id] = 0
		}
		countsDirty.Store(true)
		sm.Unlock()
		signalChanged()
	case "inject":
		if name, ok := normalizeKeyInput(m.Key); ok {
			if code, ok2 := resolveNative(name); ok2 {
				down := m.Down == nil || *m.Down
				onKey(code, down)
			}
		}
	}
}

func handleInject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var m struct {
		Key  string `json:"key"`
		Down *bool  `json:"down"`
	}
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	name, ok := normalizeKeyInput(m.Key)
	if !ok {
		http.Error(w, "unknown key", http.StatusBadRequest)
		return
	}
	code, ok := resolveNative(name)
	if !ok {
		http.Error(w, "unsupported on this platform", http.StatusBadRequest)
		return
	}
	down := m.Down == nil || *m.Down
	onKey(code, down)
	w.Write([]byte("ok"))
}

func noStore(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

func handleMedia(w http.ResponseWriter, r *http.Request) {
	files := []string{}
	if base := webDir(); base != "" {
		entries, err := os.ReadDir(filepath.Join(base, "media"))
		if err == nil {
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				switch strings.ToLower(filepath.Ext(e.Name())) {
				case ".png", ".jpg", ".jpeg", ".gif":
					files = append(files, e.Name())
				}
			}
		}
	}
	sort.Strings(files)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string][]string{"files": files})
}

func webDir() string {
	if p := os.Getenv("CELESTE_OVERLAY_WEB"); p != "" {
		return p
	}
	if fi, err := os.Stat("web"); err == nil && fi.IsDir() {
		return "web"
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "web")
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			return p
		}
	}
	return ""
}

func staticFiles() (http.FileSystem, error) {
	if d := webDir(); d != "" {
		return http.Dir(d), nil
	}
	sub, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return nil, err
	}
	return http.FS(sub), nil
}

func countsSaver() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if !countsDirty.Swap(false) && !cfgDirty.Swap(false) {
			continue
		}
		if err := saveCountsFile(); err != nil {
			fmt.Fprintln(os.Stderr, "counts: save failed:", err)
		}
	}
}

func mustStatic() http.FileSystem {
	h, err := staticFiles()
	if err != nil {
		fmt.Fprintln(os.Stderr, "static:", err)
		os.Exit(1)
	}
	return h
}

func main() {
	initState()
	loadConfig()
	sm.Lock()
	rebuildWatched()
	sm.Unlock()
	loadCounts()

	if err := saveConfig(cfgNow); err != nil {
		fmt.Fprintln(os.Stderr, "config: save failed:", err)
	}

	go runInputCapture(onKey)
	go countsSaver()

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		_ = saveCountsFile()
		_ = saveConfig(cfgNow)
		os.Exit(0)
	}()

	go func() {
		for range changedCh {
			broadcast(snapshotMsg())
			time.Sleep(4 * time.Millisecond)
		}
	}()

	http.Handle("/", noStore(http.FileServer(mustStatic())))
	http.HandleFunc(wsPath, handleWS)
	http.HandleFunc("/api/inject", handleInject)
	http.HandleFunc("/api/media", handleMedia)

	port := httpPort
	if p := os.Getenv("CELESTE_OVERLAY_PORT"); p != "" {
		port = p
	}
	addr := ":" + port
	fmt.Println("config:", configPath())
	fmt.Println("counts:", countsPath())
	fmt.Println("HTTP/WebSocket listening on http://localhost" + addr)
	fmt.Println("OBS Browser Source: http://localhost" + addr + "/?noedit=1  (transparent)")
	fmt.Println("Layout editor:      http://localhost" + addr + "/?edit=1")
	fmt.Println("Test keys via:      curl -X POST localhost" + addr + "/api/inject -d '{\"key\":\"KEY_H\",\"down\":true}'")
	if err := http.ListenAndServe(addr, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}