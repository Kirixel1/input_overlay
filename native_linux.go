//go:build linux

package main

func resolveNative(name string) (uint32, bool) {
	c, ok := evdevCodeByName[name]
	return uint32(c), ok
}

func nativeName(code uint32) (string, bool) {
	n, ok := evdevNameByCode[uint16(code)]
	return n, ok
}