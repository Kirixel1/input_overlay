#!/usr/bin/env bash
set -euo pipefail
mkdir -p dist
go build -o dist/celeste-input-overlay .
GOOS=windows GOARCH=amd64 go build -o dist/celeste-input-overlay.exe .
tmp=$(mktemp -d)
cp dist/celeste-input-overlay.exe "$tmp/"
cp -r web "$tmp/web"
(cd "$tmp" && zip -qr "$OLDPWD/dist/celeste-input-overlay-windows.zip" cele* web)
rm -rf "$tmp"
echo "dist/celeste-input-overlay (linux)"
echo "dist/celeste-input-overlay-windows.zip (windows)"