# celeste input overlay

A nohboard-style input overlay for Celeste with a browser layout editor.
Runs a tiny server on `localhost:8090`, key presses are captured globally
(Linux: evdev, Windows: low-level keyboard hook) and rendered with press
counters in a browser or OBS Browser Source.

## run (windows)

1. download `celeste-input-overlay-windows.zip` from [releases](../../releases)
2. unzip anywhere and run `celeste-input-overlay.exe`
3. open http://localhost:8090/?edit=1

the console window that stays open is the server, close it to stop.

## run (linux)

```sh
./celeste-input-overlay
```

build with Go (≥ 1.26):  `go build .`

## use

1. open http://localhost:8090/?edit=1 (or press `Edit` on the overlay)
2. click a cell to edit it — label, counter on/off, label size, font, scale, x/y/w/h
3. drag to move, drag the corner handle to resize (snaps to 10px)
4. `+ keys` adds a key cell, `+ image` adds an image cell (put the image file into `web/`)
5. bind keys by typing evdev names (`KEY_H`, `A`, or raw code `35`), or press `listen` and just press a key (Esc cancels)
6. `Done` switches back to the overlay

in OBS add a **Browser Source** pointing at `http://localhost:8090/?noedit=1`
(transparent, so your game/sources show through).

## files

layout and counters are saved automatically in
`~/.config/celeste-input-overlay/` (`config.json`, `counts.json`).

## build

```sh
./build.sh        # linux binary + windows zip into dist/
go build .        # just the current OS
```

bindings use Linux evdev key names (`KEY_*`) — the same config works on both
platforms, scan codes / VK codes are mapped internally.