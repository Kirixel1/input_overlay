//go:build linux

package main

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

type inputEvent struct {
	Sec, Usec int64
	Type      uint16
	Code      uint16
	Value     int32
}

const eventSize = int(unsafe.Sizeof(inputEvent{}))

func looksLikeKeyboard(fd int) bool {
	name := make([]byte, 256)
	n, _, err := syscall.Syscall6(syscall.SYS_IOCTL, uintptr(fd),
		uintptr(0x4506), uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)-1), 0, 0)
	if err != 0 || n == 0 {
		return true
	}
	s := strings.ToLower(string(name[:n]))
	switch {
	case strings.Contains(s, "keyboard"), strings.Contains(s, "keypad"),
		strings.Contains(s, "kbd"):
		return true
	case strings.Contains(s, "mouse"), strings.Contains(s, "touchpad"),
		strings.Contains(s, "trackpad"):
		return false
	}
	return true
}

func openDevices() ([]int, error) {
	paths, _ := filepath.Glob("/dev/input/event*")
	sort.Strings(paths)
	var fds []int
	for _, p := range paths {
		fd, err := syscall.Open(p, syscall.O_RDONLY|syscall.O_NONBLOCK, 0)
		if err != nil {
			continue
		}
		if looksLikeKeyboard(fd) {
			fds = append(fds, fd)
		} else {
			syscall.Close(fd)
		}
	}
	if len(fds) == 0 {
		return nil, fmt.Errorf("no readable keyboard devices (run once: sudo usermod -aG input $USER, then log back in; or: sudo setfacl -m u:$USER:r /dev/input/event*)")
	}
	return fds, nil
}

func runInputCapture(onKey func(uint32, bool)) {
	for {
		fds, err := openDevices()
		if err != nil {
			fmt.Println("evdev:", err, "- retrying in 2s")
			time.Sleep(2 * time.Second)
			continue
		}

		fmt.Printf("watching %d keyboard device(s)\n", len(fds))

		buf := make([]byte, 64*eventSize)
		dead := false
		for !dead {
			maxfd := 0
			var rset syscall.FdSet
			for _, fd := range fds {
				if fd > maxfd {
					maxfd = fd
				}
				rset.Bits[fd/64] |= 1 << (uint(fd) % 64)
			}
			tv := syscall.Timeval{Sec: 0, Usec: 200_000}
			n, err := syscall.Select(maxfd+1, &rset, nil, nil, &tv)
			if err == syscall.EINTR {
				continue
			}
			if err != nil {
				dead = true
				break
			}
			if n == 0 {
				continue
			}

			for _, fd := range fds {
				if rset.Bits[fd/64]&(1<<(uint(fd)%64)) == 0 {
					continue
				}
				nr, err := syscall.Read(fd, buf)
				if err != nil {
					if err == syscall.EAGAIN {
						continue
					}
					dead = true
					break
				}
				if nr == 0 {
					dead = true
					break
				}
				for off := 0; off+eventSize <= nr; off += eventSize {
					ev := (*inputEvent)(unsafe.Pointer(&buf[off]))
					if ev.Type != 1 || ev.Value > 1 || ev.Code > keyMaxNative {
						continue
					}
					onKey(uint32(ev.Code), ev.Value == 1)
				}
			}
		}

		for _, fd := range fds {
			syscall.Close(fd)
		}
		time.Sleep(500 * time.Millisecond)
	}
}