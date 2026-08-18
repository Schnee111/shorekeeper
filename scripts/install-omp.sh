#!/usr/bin/env bash
set -euo pipefail

# Global install of oh-my-pi from release binary
OMP_BIN=/home/daffa/.hermes/node/lib/node_modules/oh-my-pi/omp-linux-x64
BIN_LINK=/home/daffa/.hermes/node/bin/omp

mkdir -p "$(dirname "$BIN_LINK")"
cp /tmp/omp-linux-x64 "$OMP_BIN"
chmod +x "$OMP_BIN"
ln -sf "$OMP_BIN" "$BIN_LINK"

echo "Global install done: $BIN_LINK -> $OMP_BIN"
