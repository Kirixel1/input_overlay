//go:build windows

package main

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	user32         = syscall.NewLazyDLL("user32.dll")
	procSetHook    = user32.NewProc("SetWindowsHookExW")
	procCallNext   = user32.NewProc("CallNextHookEx")
	procGetMessage = user32.NewProc("GetMessageW")
	kernel32       = syscall.NewLazyDLL("kernel32.dll")
	procGetModule  = kernel32.NewProc("GetModuleHandleW")
)

const (
	whKeyboardLL = 13
	wmKeyDown    = 0x0100
	wmSysKeyDown = 0x0104
	llkhfExtended = 0x01
)

type kbdLLHookStruct struct {
	VKCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DWExtraInfo uintptr
}

var kbdProc uintptr

func runInputCapture(onKey func(uint32, bool)) {
	runtime.LockOSThread()
	kbdProc = syscall.NewCallback(onHookEvent)
	hmod, _, _ := procGetModule.Call(0)
	hook, _, _ := procSetHook.Call(whKeyboardLL, kbdProc, hmod, 0)
	if hook == 0 {
		fmt.Println("keyboard hook failed; overlay input is disabled")
		return
	}
	for {
		var msg [6]uintptr
		r, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0)
		if r == 0 || r == 0xFFFFFFFF {
			return
		}
	}
}

func onHookEvent(nCode int, wParam, lParam uintptr) uintptr {
	if nCode >= 0 && lParam != 0 {
		kbd := (*kbdLLHookStruct)(unsafe.Pointer(lParam))
		down := wParam == wmKeyDown || wParam == wmSysKeyDown
		code := kbd.ScanCode
		ext := kbd.Flags&llkhfExtended != 0
		if ext {
			code |= 0x8000
		}
		switch {
		case kbd.VKCode >= 0x25 && kbd.VKCode <= 0x28:
			// Arrows are extended keys, but some keyboards/software report
			// them without the LLKHF_EXTENDED flag. Prefer the virtual-key
			// code so Up/Left/Right/Down always resolve to KEY_UP etc.
			code = 0x10000 | kbd.VKCode
		case scanNameByCode[code] == "" && kbd.VKCode < 0x100:
			code = 0x10000 | kbd.VKCode
		}
		onKey(code, down)
	}
	next, _, _ := procCallNext.Call(0, uintptr(nCode), wParam, lParam)
	return next
}