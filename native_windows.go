//go:build windows

package main

func resolveNative(name string) (uint32, bool) {
	if c, ok := scanCodeByName[name]; ok {
		return c, true
	}
	if c, ok := vkCodeByName[name]; ok {
		return c, true
	}
	return 0, false
}

func nativeName(code uint32) (string, bool) {
	if n, ok := scanNameByCode[code]; ok {
		return n, true
	}
	if n, ok := vkNameByCode[code]; ok {
		return n, true
	}
	return "", false
}